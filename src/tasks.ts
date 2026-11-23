import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { join, posix } from "node:path";
import { IMAGE, isolatedRun } from "./container.ts";
import { closed, command, gitCommand, output, run, STATE, touch } from "./platform.ts";
import type { ProjectInfo } from "./workspace.ts";

export const CONTAINER_REPO_DIR = "/workspace/repo";

export interface Mount {
	type: string;
	source: string;
	target: string;
	read_only?: boolean;
}

export interface ComposeService {
	volumes?: Mount[];
	ports?: unknown[];
	privileged?: boolean;
	container_name?: string;
	network_mode?: string;
	[key: string]: unknown;
}

export interface ComposeResource {
	name: string;
	external?: boolean;
	driver_opts?: object;
	[key: string]: unknown;
}

export interface ComposeConfig {
	name?: string;
	services: Record<string, ComposeService>;
	volumes?: Record<string, ComposeResource>;
	networks?: Record<string, ComposeResource>;
	[key: string]: unknown;
}

export interface RpcPolicy {
	allowedServices?: string[];
	allowExec?: boolean;
	allowLogs?: boolean;
	allowPs?: boolean;
	allowRestart?: boolean;
}

export interface RpcResponse {
	text: string;
	error?: boolean;
}

const MAX_OUTPUT = 32000;
const SERVICE_NAME = /^[a-zA-Z0-9._-]+$/;

async function spawnCapture(
	argv: string[],
	timeoutMs?: number,
): Promise<{ code: number | null; signal: string | null; text: string }> {
	const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
	let tail: Buffer = Buffer.alloc(0);
	const append = (chunk: Buffer) => {
		tail = Buffer.concat([tail, chunk]).subarray(-MAX_OUTPUT);
	};
	child.stdout.on("data", append);
	child.stderr.on("data", append);
	let timer: NodeJS.Timeout | undefined;
	if (timeoutMs) {
		timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		timer.unref();
	}
	try {
		const [code, signal] = await closed(child);
		return { code, signal, text: tail.toString("utf8") };
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function validateCompose(folder: string, key: string): ComposeConfig {
	// Resolve only the operator's base recipe, never compose.override.yaml.
	const conf: ComposeConfig = JSON.parse(
		output(["docker", "compose", "-p", key, "-f", join(folder, "compose.yaml"), "config", "--format", "json"]),
	);
	for (const group of [conf.volumes, conf.networks]) {
		for (const [name, resource] of Object.entries(group ?? {})) {
			if (resource.external || Object.keys(resource.driver_opts ?? {}).length || resource.name !== `${key}_${name}`)
				throw Error("Project recipes require task-scoped volumes and networks");
		}
	}
	for (const svc of Object.values(conf.services)) {
		if (
			svc.ports?.length ||
			svc.privileged ||
			svc.container_name ||
			svc.network_mode ||
			svc.volumes?.some((m) => m.type === "bind")
		)
			throw Error("Keep host mounts, ports and shared resources out of the base compose.yaml");
	}
	if (
		!conf.services.runner?.volumes?.some(
			(m) => m.type === "volume" && m.source === "source" && m.target === "/workspace",
		)
	)
		throw Error("The runner service needs a private source volume mounted at /workspace");
	return conf;
}

export class TaskEnv {
	readonly id: string;
	readonly project: ProjectInfo;
	readonly key: string;
	readonly dir: string;
	readonly workspace: string;
	readonly repo: string;
	readonly scratch: string;
	readonly context: string;
	readonly composeFile: string;
	readonly compose: string[];
	private servicesCache?: string[];
	private networkCache?: string;

	constructor(id: string, project: ProjectInfo, stateDir = STATE) {
		this.id = id;
		this.project = project;
		this.key = `pi-stick-${project.name}-${id.slice(0, 12)}`;
		this.dir = join(stateDir, "runs", id);
		this.workspace = join(this.dir, "workspace");
		this.repo = join(this.workspace, "repo");
		this.scratch = join(this.dir, "scratch");
		this.context = join(this.dir, "context");
		this.composeFile = join(this.dir, "compose.yaml");
		this.compose = ["docker", "compose", "-p", this.key, "-f", this.composeFile];
	}

	validateBase() {
		return validateCompose(this.project.folder, this.key);
	}

	prepareWorkspace(ref?: string): { baseHead: string } {
		if (ref !== undefined && (!ref.length || ref.startsWith("-") || ref.includes("\0")))
			throw Error("Invalid Git ref");
		fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		fs.mkdirSync(this.workspace, { recursive: true, mode: 0o700 });
		fs.mkdirSync(this.scratch, { recursive: true, mode: 0o700 });
		fs.mkdirSync(this.context, { recursive: true, mode: 0o700 });
		if (!fs.existsSync(this.repo)) {
			if (!fs.existsSync(this.project.repo)) throw Error(`Project repository not found at ${this.project.repo}`);
			run(
				[
					"git",
					"-c",
					"core.hooksPath=/dev/null",
					"clone",
					"--no-local",
					"--no-hardlinks",
					"--",
					this.project.repo,
					this.repo,
				],
				{ env: { ...process.env, GIT_ALLOW_PROTOCOL: "file:https:ssh" } },
			);
		}
		const git = gitCommand(this.repo);
		if (ref) {
			let targetSha: string | undefined;
			try {
				targetSha = output([...git, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
			} catch {
				// Not present locally; try fetching from origin.
			}
			if (targetSha) {
				run([...git, "checkout", "--detach", targetSha]);
			} else {
				run(
					[
						"git",
						"-c",
						"core.hooksPath=/dev/null",
						"-c",
						"credential.https://github.com.helper=!gh auth git-credential",
						"-C",
						this.repo,
						"fetch",
						"--no-tags",
						"origin",
						"--",
						ref,
					],
					{ env: { ...process.env, GIT_ALLOW_PROTOCOL: "file:https:ssh" } },
				);
				run([...git, "checkout", "--detach", "FETCH_HEAD"]);
			}
		}
		const baseHead = output([...git, "rev-parse", "HEAD"]);
		touch(join(this.dir, "last-used"));
		return { baseHead };
	}

	materializeCompose(): { network: string; services: string[] } {
		const conf = this.validateBase();
		let sourceStillUsed = false;
		for (const [name, svc] of Object.entries(conf.services)) {
			let usesWorkspace = false;
			if (svc.volumes) {
				svc.volumes = svc.volumes.map((m) => {
					if (m.type === "volume" && m.source === "source" && m.target === "/workspace") {
						usesWorkspace = true;
						return { type: "bind", source: this.workspace, target: "/workspace" };
					}
					if (m.type === "volume" && m.source === "source") sourceStillUsed = true;
					return m;
				});
			}
			if (name === "runner" || usesWorkspace) {
				svc.volumes ??= [];
				svc.volumes.push({ type: "bind", source: this.scratch, target: "/scratch" });
			}
		}
		if (!sourceStillUsed && conf.volumes) {
			delete conf.volumes.source;
			if (!Object.keys(conf.volumes).length) delete conf.volumes;
		}
		const network = conf.networks?.default?.name ?? `${this.key}_default`;
		const services = Object.keys(conf.services);
		fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		fs.writeFileSync(
			this.composeFile,
			JSON.stringify(conf).replaceAll("$", () => "$$"),
		);
		this.servicesCache = services;
		this.networkCache = network;
		return { network, services };
	}

	services(): string[] {
		if (this.servicesCache) return this.servicesCache;
		if (!fs.existsSync(this.composeFile)) return [];
		const conf: ComposeConfig = JSON.parse(fs.readFileSync(this.composeFile, "utf8").replaceAll("$$", "$"));
		this.servicesCache = Object.keys(conf.services ?? {});
		return this.servicesCache;
	}

	network(): string {
		if (this.networkCache) return this.networkCache;
		if (fs.existsSync(this.composeFile)) {
			const conf: ComposeConfig = JSON.parse(fs.readFileSync(this.composeFile, "utf8").replaceAll("$$", "$"));
			this.networkCache = conf.networks?.default?.name ?? `${this.key}_default`;
			return this.networkCache;
		}
		return `${this.key}_default`;
	}

	up(runSetup = true) {
		run([...this.compose, "up", "--build", "-d", "--wait", "--wait-timeout", "180"]);
		if (runSetup) {
			run([...this.compose, "exec", "-T", "-w", CONTAINER_REPO_DIR, "runner", "/usr/local/bin/setup-project"]);
		}
		touch(join(this.dir, "last-used"));
	}

	start() {
		run([...this.compose, "start"]);
		touch(join(this.dir, "last-used"));
	}

	stop() {
		if (!fs.existsSync(this.composeFile)) return;
		run([...this.compose, "stop"]);
		touch(join(this.dir, "last-used"));
	}

	down() {
		if (!fs.existsSync(this.composeFile)) return;
		run([...this.compose, "down", "--volumes"]);
	}

	inspectGit(...args: string[]): string {
		// Mount the trusted parent: the runner can replace entries inside workspace, including repo.
		return command([
			...isolatedRun("none"),
			"-v",
			`${this.workspace}:/workspace:ro`,
			IMAGE,
			...gitCommand(CONTAINER_REPO_DIR),
			"--no-optional-locks",
			...args,
		]).toString("utf8");
	}

	trackedStatus(): string {
		if (!fs.existsSync(this.repo)) return "";
		return this.inspectGit("status", "--porcelain", "--untracked-files=no");
	}

	captureDiff(baseHead?: string): { patch: string; untracked: string[] } {
		const patch = this.inspectGit("diff", "--no-ext-diff", "--no-textconv", baseHead || "HEAD", "--");
		const untrackedRaw = this.inspectGit("ls-files", "--others", "--exclude-standard").trim();
		const untracked = untrackedRaw ? untrackedRaw.split("\n") : [];
		const patchFile = join(this.dir, "changes.patch");
		if (patch.trim()) fs.writeFileSync(patchFile, patch);
		else fs.rmSync(patchFile, { force: true });
		return { patch, untracked };
	}

	private validateService(service: string): string {
		if (!SERVICE_NAME.test(service)) throw Error(`Invalid service name: ${service}`);
		const known = this.services();
		if (known.length && !known.includes(service)) throw Error(`Unknown Compose service: ${service}`);
		return service;
	}

	private resolveExecWorkdir(workdir?: unknown): string {
		if (workdir === undefined || workdir === "") return CONTAINER_REPO_DIR;
		if (typeof workdir !== "string" || workdir.includes("\0") || workdir.length > 512) throw Error("Invalid workdir");
		if (workdir === "/scratch" || workdir.startsWith("/scratch/")) {
			const norm = posix.normalize(workdir);
			if (norm === "/scratch" || norm.startsWith("/scratch/")) return norm;
			throw Error("Invalid scratch workdir");
		}
		const rel = workdir.startsWith(CONTAINER_REPO_DIR) ? workdir : posix.join(CONTAINER_REPO_DIR, workdir);
		const norm = posix.normalize(rel);
		if (norm !== CONTAINER_REPO_DIR && !norm.startsWith(`${CONTAINER_REPO_DIR}/`))
			throw Error(`Workdir must stay inside ${CONTAINER_REPO_DIR} or /scratch`);
		return norm;
	}

	async handleRpc(method: string, params: Record<string, unknown> = {}, policy: RpcPolicy = {}): Promise<RpcResponse> {
		switch (method) {
			case "exec": {
				if (policy.allowExec === false) return { text: "exec is not permitted for this agent", error: true };
				const cmd = params.command;
				if (typeof cmd !== "string" || !cmd.length || cmd.length > 16384 || cmd.includes("\0"))
					return { text: "exec requires a non-empty command string", error: true };
				const service = this.validateService(typeof params.service === "string" ? params.service : "runner");
				const allowed = policy.allowedServices ?? ["runner"];
				if (!allowed.includes("*") && !allowed.includes(service))
					return { text: `exec in service '${service}' is not permitted`, error: true };
				const workdir = this.resolveExecWorkdir(params.workdir);
				const timeoutSec =
					typeof params.timeout === "number" && Number.isSafeInteger(params.timeout) && params.timeout > 0
						? Math.min(params.timeout, 900)
						: 300;
				const res = await spawnCapture(
					[
						...this.compose,
						"exec",
						"-T",
						"-w",
						workdir,
						service,
						"timeout",
						"--kill-after=15s",
						`${timeoutSec}s`,
						"sh",
						"-lc",
						cmd,
					],
					(timeoutSec + 30) * 1000,
				);
				return {
					text: `exit=${res.code ?? res.signal}\n${res.text}`,
					error: res.code !== 0,
				};
			}
			case "logs": {
				if (policy.allowLogs === false) return { text: "logs is not permitted for this agent", error: true };
				const tail =
					typeof params.tail === "number" && Number.isSafeInteger(params.tail) && params.tail > 0
						? Math.min(params.tail, 2000)
						: 200;
				const argv = [...this.compose, "logs", "--no-color", "--tail", String(tail)];
				if (typeof params.service === "string" && params.service.length) {
					argv.push(this.validateService(params.service));
				}
				const res = await spawnCapture(argv, 30_000);
				return { text: res.text || "(no logs)", error: res.code !== 0 };
			}
			case "ps": {
				if (policy.allowPs === false) return { text: "ps is not permitted for this agent", error: true };
				const res = await spawnCapture([...this.compose, "ps", "--format", "json"], 30_000);
				return { text: res.text || "[]", error: res.code !== 0 };
			}
			case "restart": {
				if (policy.allowRestart === false) return { text: "restart is not permitted for this agent", error: true };
				if (typeof params.service !== "string" || !params.service.length)
					return { text: "restart requires a service name", error: true };
				const service = this.validateService(params.service);
				const res = await spawnCapture([...this.compose, "restart", service], 120_000);
				return {
					text: res.code === 0 ? `Restarted service '${service}'.\n${res.text}`.trim() : res.text,
					error: res.code !== 0,
				};
			}
			case "check_clean": {
				return { text: this.trackedStatus(), error: false };
			}
			default:
				return { text: `Unsupported RPC method: ${method}`, error: true };
		}
	}
}
