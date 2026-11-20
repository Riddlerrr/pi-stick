import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { closed, json, output, prompt, ROOT, read, run, runId, STATE, userSettings } from "./platform.ts";
import { validateCompose } from "./tasks.ts";
import { listProjects } from "./workspace.ts";

export const IMAGE = "pi-stick:current";

export interface ModelSpec {
	provider: string;
	modelId: string;
	raw: string;
}

export interface ResolvedAuth {
	models: Record<string, unknown[]>;
	credentials: Record<string, { token: string; authType?: "oauth" | "api_key" }>;
}

export function parseModelSpec(spec: string): ModelSpec {
	const idx = spec.indexOf("/");
	if (idx <= 0 || idx === spec.length - 1) throw Error(`Expected model in 'provider/modelId' format, got: ${spec}`);
	const provider = spec.slice(0, idx).trim();
	const modelId = spec.slice(idx + 1).trim();
	if (!provider || !modelId || provider.includes(" ") || modelId.includes("\0"))
		throw Error(`Invalid model identifier: ${spec}`);
	return { provider, modelId, raw: `${provider}/${modelId}` };
}

function readLocalCatalog(): Record<string, { models?: Array<{ id?: string; [k: string]: unknown }> }> {
	const file = join(homedir(), ".pi/agent/models-store.json");
	if (!fs.existsSync(file)) return {};
	try {
		const data = json(file);
		return data && typeof data === "object" ? data : {};
	} catch {
		return {};
	}
}

function readAuthTypes(): Record<string, "oauth" | "api_key"> {
	// Inspect credential type metadata only; never read secrets from auth.json.
	const file = join(homedir(), ".pi/agent/auth.json");
	if (!fs.existsSync(file)) return {};
	try {
		const data = json(file);
		if (!data || typeof data !== "object") return {};
		const types: Record<string, "oauth" | "api_key"> = {};
		for (const [provider, entry] of Object.entries(data as Record<string, { type?: unknown }>)) {
			if (entry?.type === "oauth" || entry?.type === "api_key") types[provider] = entry.type;
		}
		return types;
	} catch {
		return {};
	}
}

export function resolveModels(specs: string[], offline = false): ResolvedAuth {
	const parsed = specs.map(parseModelSpec);
	const catalog = readLocalCatalog();
	const authTypes = readAuthTypes();
	const models: Record<string, unknown[]> = {};
	const credentials: Record<string, { token: string; authType?: "oauth" | "api_key" }> = {};

	for (const { provider, modelId, raw } of parsed) {
		const catalogEntry = catalog[provider]?.models?.find((m) => m.id === modelId);
		if (catalogEntry) {
			models[provider] ??= [];
			if (!models[provider].some((m) => (m as { id?: string }).id === modelId)) {
				models[provider].push(catalogEntry);
			}
		}
		if (!credentials[provider]) {
			// Tokens travel only over stdin to the ephemeral container; never log or put in argv/env.
			const token = offline
				? "offline-fixture"
				: output(["pi", "auth", "print-bearer-token", "--model", raw, "--min-expiry", "1h"]);
			credentials[provider] = { token, authType: authTypes[provider] };
		}
	}
	return { models, credentials };
}

export interface EphemeralContainerOptions {
	image?: string;
	network: string;
	repo?: string;
	scratch?: string;
	context?: string;
	sessions?: string;
	tmpfsSessions?: boolean;
}

export function ephemeralArgs(opts: EphemeralContainerOptions): string[] {
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	if (!uid || gid === undefined) throw Error("Refusing to launch agent container as root");
	const args = [
		"docker",
		"run",
		"--rm",
		"-i",
		"--init",
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges:true",
		"--tmpfs",
		"/tmp:rw,nosuid,nodev,size=512m",
		"--memory",
		"2g",
		"--pids-limit",
		"128",
		"--user",
		`${uid}:${gid}`,
		"--network",
		opts.network,
	];
	if (opts.repo) args.push("-v", `${opts.repo}:/workspace`);
	if (opts.scratch) args.push("-v", `${opts.scratch}:/scratch`);
	if (opts.context) args.push("-v", `${opts.context}:/context:ro`);
	if (opts.tmpfsSessions) args.push("--tmpfs", `/sessions:uid=${uid},mode=0700`);
	else if (opts.sessions) args.push("-v", `${opts.sessions}:/sessions`);
	args.push(opts.image ?? IMAGE, "node", "/app/agent-runtime.ts");
	return args;
}

export async function probe(image = IMAGE): Promise<void> {
	const argv = ephemeralArgs({ image, network: "none", tmpfsSessions: true });
	const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
	const exit = closed(child);
	exit.catch(() => {});
	child.stdin.on("error", () => {});
	const send = (data: unknown) =>
		new Promise<void>((resolve, reject) =>
			child.stdin.write(`${JSON.stringify(data)}\n`, (err) => (err ? reject(err) : resolve())),
		);
	const lines = createInterface({ input: child.stdout });
	let ready = false;
	try {
		await send({
			id: runId(),
			check: true,
			models: {},
			credentials: {},
		});
		for await (const line of lines) {
			const msg = JSON.parse(line);
			if (typeof msg.rpc === "number") {
				await send({ rpc: msg.rpc, result: { text: `probe-ok:${msg.method}`, error: false } });
				continue;
			}
			if (msg.ready === true) {
				ready = true;
				break;
			}
		}
		child.stdin.end();
		const [code] = await exit;
		if (code !== 0 || !ready) throw Error("Ephemeral agent runtime self-check failed");
	} finally {
		lines.close();
		child.stdin.destroy();
		child.kill();
		await exit;
	}
}

export async function doctor(extraChecks: Array<[string, () => unknown | Promise<unknown>]> = []): Promise<boolean> {
	const settings = userSettings();
	const checks: Array<[string, () => unknown | Promise<unknown>]> = [
		["Docker daemon", () => output(["docker", "info", "--format", "{{.ServerVersion}}"])],
		[`Agent image (${IMAGE})`, () => output(["docker", "image", "inspect", IMAGE, "--format", "{{.Id}}"])],
		["Ephemeral runtime self-check (durable SQLite, Codemode, JSON-RPC; no model call)", () => probe(IMAGE)],
		[
			settings.default_model
				? `Pi default model auth (${settings.default_model})`
				: "Pi default model (not set; configure per action or in settings.json)",
			() => {
				if (settings.default_model) resolveModels([settings.default_model]);
			},
		],
		[
			"Project base Compose recipes",
			() => {
				for (const p of listProjects()) validateCompose(p.folder, `pi-stick-${p.name}-check`);
			},
		],
		...extraChecks,
	];
	let ok = true;
	for (const [label, check] of checks) {
		try {
			await check();
			console.log("OK  ", label);
		} catch (err) {
			ok = false;
			console.log("FAIL", label, err instanceof Error ? `(${err.message})` : "");
			if (label.startsWith("Docker daemon")) break;
		}
	}
	return ok;
}

export async function update(yes: boolean, activeRunCount: number) {
	if (activeRunCount > 0) throw Error(`Cannot update while ${activeRunCount} task run(s) are active`);
	if (
		!yes &&
		(await prompt("Build latest pi-stick agent image and promote after self-checks? [y/N] ")).toLowerCase() !== "y"
	)
		return;
	const id = runId().slice(0, 12);
	const candidate = `pi-stick:candidate-${id}`;
	const rollback = `pi-stick:before-${id}`;
	const files = ["package.json", "package-lock.json", "Dockerfile"];
	const stage = fs.mkdtempSync(join(tmpdir(), "pi-stick-update-"));
	const copy = (name: string, from: string, to: string) => fs.copyFileSync(join(from, name), join(to, name));
	try {
		for (const f of [...files, "agent-runtime.ts", ".dockerignore"]) copy(f, ROOT, stage);
		const base = "node:current-bookworm-slim";
		const digest = /^Digest:\s+(sha256:[0-9a-f]{64})$/m.exec(
			output(["docker", "buildx", "imagetools", "inspect", base]),
		)?.[1];
		const npm = output(["npm", "view", "npm@latest", "version"]);
		if (!digest || !/^\d+\.\d+\.\d+$/.test(npm)) throw Error("Cannot resolve latest Node base digest or npm release");
		const dockerfile = join(stage, "Dockerfile");
		fs.writeFileSync(
			dockerfile,
			read(dockerfile)
				.replace(/^FROM .*/, `FROM ${base}@${digest}`)
				.replace(/^ARG NPM_VERSION=.*$/m, `ARG NPM_VERSION=${npm}`),
		);
		fs.unlinkSync(join(stage, "package-lock.json"));
		const deps = Object.keys(json(join(stage, "package.json")).dependencies).map((d) => `${d}@latest`);
		run(
			[
				"npm",
				"install",
				"--save-exact",
				"--package-lock-only",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				...deps,
			],
			{ cwd: stage },
		);
		run(["docker", "build", "--pull", "--no-cache", "-t", candidate, stage]);
		await probe(candidate);
		const backup = join(STATE, "backups", id);
		fs.mkdirSync(backup, { recursive: true });
		for (const f of files) copy(f, ROOT, backup);
		let hadCurrent = false;
		try {
			const prevId = output(["docker", "image", "inspect", IMAGE, "--format", "{{.Id}}"]);
			if (prevId) {
				run(["docker", "tag", prevId, rollback]);
				hadCurrent = true;
			}
		} catch {
			// First build: no existing image to tag as rollback.
		}
		console.log(`Backup: ${backup}${hadCurrent ? `; previous image: ${rollback}` : ""}`);
		try {
			run(["docker", "tag", candidate, IMAGE]);
			await probe(IMAGE);
			for (const f of files) copy(f, stage, ROOT);
		} catch (err) {
			for (const f of files) copy(f, backup, ROOT);
			if (hadCurrent) run(["docker", "tag", rollback, IMAGE]);
			throw err;
		}
		console.log("Updated pi-stick agent image. Project images unchanged.");
	} finally {
		fs.rmSync(stage, { recursive: true, force: true });
	}
}
