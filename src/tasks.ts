import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { IMAGE, isolatedRun } from "./container.ts";
import { closed, command, gitCommand, output, run, runId, STATE, touch } from "./platform.ts";
import { RUNNER_SHELL } from "./runner-shell.ts";
import { type ProjectInfo, projectSource } from "./workspace.ts";

export const CONTAINER_WORKSPACE_DIR = "/workspace";
export const CONTAINER_REPO_DIR = `${CONTAINER_WORKSPACE_DIR}/repo`;

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
	networks?: Record<string, unknown>;
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
	configs?: Record<string, { file?: string; external?: boolean }>;
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
	exitCode?: number;
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
	if (conf.secrets) throw Error("Compose secrets are not supported in the base compose.yaml");
	if (conf.configs) {
		const project = fs.realpathSync(folder);
		const repo = fs.realpathSync(join(project, "repo"));
		for (const [name, config] of Object.entries(conf.configs)) {
			if (config.external || typeof config.file !== "string")
				throw Error(`Compose config '${name}' must use a project file`);
			const file = fs.realpathSync(config.file);
			if (!file.startsWith(`${project}/`) || file.startsWith(`${repo}/`) || !fs.statSync(file).isFile())
				throw Error(`Compose config '${name}' must be a regular project file outside repo/`);
			config.file = file;
		}
	}
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
	if (!Object.hasOwn(conf.services.runner.networks ?? {}, "default"))
		throw Error("Attach the runner service to the default network in compose.yaml so the agent can reach it");
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
		const source = projectSource(this.project.folder);
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
		if (source) run([...git, "remote", "set-url", "origin", source]);
		if (ref) {
			// Cloning the project copies its non-current branches as remote-tracking refs.
			const localCommit = (name: string) =>
				command([...git, "rev-parse", "--verify", "--quiet", `${name}^{commit}`], {}, [0, 1])
					.toString()
					.trim();
			const targetSha = localCommit(ref) || localCommit(`refs/remotes/origin/${ref.replace(/^refs\/heads\//, "")}`);
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
						return { type: "bind", source: this.workspace, target: m.target, read_only: m.read_only };
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

	up() {
		run([...this.compose, "up", "--build", "-d", "--wait", "--wait-timeout", "180"]);
		touch(join(this.dir, "last-used"));
	}

	setup() {
		run([
			...this.compose,
			"exec",
			"-T",
			"-w",
			CONTAINER_REPO_DIR,
			"runner",
			"/bin/sh",
			"-c",
			'if [ -e "$0" ] || [ -L "$0" ]; then exec "$0"; fi',
			"/usr/local/bin/setup-project",
		]);
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

	private inspectionArgs(...args: string[]) {
		// Mount the trusted parent: the runner can replace entries inside workspace, including repo.
		return [...isolatedRun("none"), "-v", `${this.workspace}:${CONTAINER_WORKSPACE_DIR}:ro`, IMAGE, ...args];
	}

	inspectGit(...args: string[]): string {
		return command(this.inspectionArgs(...gitCommand(CONTAINER_REPO_DIR), "--no-optional-locks", ...args)).toString(
			"utf8",
		);
	}

	private async trackedStatus(): Promise<RpcResponse> {
		const [docker, ...args] = this.inspectionArgs(
			"timeout",
			"-k",
			"2",
			"30",
			...gitCommand(CONTAINER_REPO_DIR),
			"--no-optional-locks",
			"status",
			"--porcelain",
			"--untracked-files=no",
		);
		try {
			const { stdout } = await promisify(execFile)(docker, args, {
				timeout: 35_000,
				killSignal: "SIGKILL",
				maxBuffer: 1024 * 1024,
			});
			return { text: stdout };
		} catch (err) {
			const { code, signal } = err as NodeJS.ErrnoException & { signal?: string };
			return { error: true, text: `git status failed (${signal ?? code ?? "unknown error"})` };
		}
	}

	captureDiff(baseHead?: string) {
		const untrackedRaw = this.inspectGit("ls-files", "--others", "--exclude-standard").replace(/\n$/, "");
		const untracked = untrackedRaw ? untrackedRaw.split("\n") : [];
		const git = [...gitCommand(CONTAINER_REPO_DIR), "--no-optional-locks"];
		// Intent-to-add needs a writable index and may write the empty blob; keep both in the container tmpfs.
		const args = untracked.length
			? this.inspectionArgs(
					"sh",
					"-ec",
					`base=$1; shift
					tmp=$(mktemp -d)
					index=$("$@" rev-parse --path-format=absolute --git-path index)
					objects=$("$@" rev-parse --path-format=absolute --git-path objects)
					test ! -f "$index" || cp -- "$index" "$tmp/index"
					mkdir "$tmp/objects"
					export GIT_INDEX_FILE="$tmp/index" GIT_OBJECT_DIRECTORY="$tmp/objects" GIT_ALTERNATE_OBJECT_DIRECTORIES="$objects"
					"$@" ls-files --others --exclude-standard -z > "$tmp/paths"
					"$@" --literal-pathspecs add -N --pathspec-from-file="$tmp/paths" --pathspec-file-nul
					exec "$@" diff --binary --no-ext-diff --no-textconv "$base" --`,
					"sh",
					baseHead || "HEAD",
					...git,
				)
			: this.inspectionArgs(...git, "diff", "--binary", "--no-ext-diff", "--no-textconv", baseHead || "HEAD", "--");
		const patchFile = join(this.dir, "changes.patch");
		const tmp = `${patchFile}.${runId()}.tmp`;
		const fd = fs.openSync(tmp, "wx", 0o600);
		try {
			try {
				run(args, { stdio: ["ignore", fd, "inherit"] });
			} finally {
				fs.closeSync(fd);
			}
			if (fs.statSync(tmp).size) {
				fs.renameSync(tmp, patchFile);
				return { patchFile, untracked };
			}
			fs.rmSync(patchFile, { force: true });
			return { patchFile: undefined, untracked };
		} finally {
			fs.rmSync(tmp, { force: true });
		}
	}

	private validateService(service: unknown, allowed: string[]): string {
		if (typeof service !== "string" || !SERVICE_NAME.test(service)) throw Error(`Invalid service name: ${service}`);
		const known = this.services();
		if (!known.includes(service)) throw Error(`Unknown Compose service: ${service}`);
		if (!allowed.includes("*") && !allowed.includes(service)) throw Error(`Service ${service} is not permitted`);
		return service;
	}

	async handleRpc(
		method: string,
		params: Record<string, unknown> = {},
		policy: RpcPolicy = {},
		onChunk?: (chunk: Buffer) => Promise<void>,
		abort?: AbortSignal,
	): Promise<RpcResponse> {
		const allowed = policy.allowedServices ?? ["*"];
		switch (method) {
			case "exec": {
				if (policy.allowExec === false) return { text: "bash is not permitted for this agent", error: true };
				const cmd = params.command;
				if (typeof cmd !== "string" || cmd.includes("\0")) return { text: "Invalid command", error: true };
				const target = params.service === undefined ? "runner" : params.service;
				const service = this.validateService(target, allowed);
				const timeout = params.timeout;
				if (
					timeout !== undefined &&
					(typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2147483647)
				)
					return { text: "Invalid timeout", error: true };
				const argv = [
					...this.compose,
					"exec",
					"-T",
					...(service === "runner" ? ["-w", CONTAINER_REPO_DIR] : []),
					"--",
					service,
					"sh",
					"-c",
					RUNNER_SHELL,
					cmd,
				];
				if (!onChunk) throw Error("Missing bash output stream");
				const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
				child.stdin.on("error", () => {});
				const cancel = () => {
					if (!child.stdin.writableEnded) child.stdin.end("\n");
				};
				if (abort?.aborted) cancel();
				else abort?.addEventListener("abort", cancel, { once: true });
				let timedOut = false;
				const timer =
					timeout === undefined
						? undefined
						: setTimeout(() => {
								timedOut = true;
								cancel();
							}, timeout * 1000);
				const exit = closed(child);
				const forward = async (source: NodeJS.ReadableStream) => {
					for await (const chunk of source) await onChunk(chunk as Buffer);
				};
				try {
					const [[code, signal]] = await Promise.all([exit, forward(child.stdout), forward(child.stderr)]);
					if (abort?.aborted) throw Error("Command aborted");
					if (timedOut) throw Error(`Command timed out after ${timeout} seconds`);
					if (code === null) throw Error(`Command terminated by ${signal}`);
					return { text: "", exitCode: code };
				} finally {
					clearTimeout(timer);
					abort?.removeEventListener("abort", cancel);
					cancel();
				}
			}
			case "logs": {
				if (policy.allowLogs === false) return { text: "logs is not permitted for this agent", error: true };
				const tail =
					typeof params.tail === "number" && Number.isSafeInteger(params.tail) && params.tail > 0
						? Math.min(params.tail, 2000)
						: 200;
				const argv = [...this.compose, "logs", "--no-color", "--tail", String(tail)];
				if (params.service !== undefined) argv.push("--", this.validateService(params.service, allowed));
				else if (!allowed.includes("*")) {
					if (!allowed.length) return { text: "No services are permitted", error: true };
					argv.push("--", ...allowed.map((service) => this.validateService(service, allowed)));
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
				const service = this.validateService(params.service, allowed);
				const res = await spawnCapture([...this.compose, "restart", "--no-deps", "--", service], 120_000);
				return {
					text: res.code === 0 ? `Restarted service '${service}'.\n${res.text}`.trim() : res.text,
					error: res.code !== 0,
				};
			}
			case "check_clean": {
				return this.trackedStatus();
			}
			default:
				return { text: `Unsupported RPC method: ${method}`, error: true };
		}
	}
}
