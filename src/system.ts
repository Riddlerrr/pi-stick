import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { CredentialPayload } from "../runtime-auth.ts";
import { type HostMessage, isRequest, type Job, RUN, readRuntime } from "../runtime-tools/protocol.ts";
import { agentName, IMAGE, isolatedRun } from "./container.ts";
import { ASSETS, closed, devMode, json, output, ROOT, run, runId, settingsPath, userSettings } from "./platform.ts";
import { CONTAINER_REPO_DIR, CONTAINER_WORKSPACE_DIR, validateCompose } from "./tasks.ts";
import { listProjects } from "./workspace.ts";

export interface ModelSpec {
	provider: string;
	modelId: string;
	raw: string;
}

export interface ResolvedAuth {
	models: Job["models"];
	credentials: Record<string, CredentialPayload>;
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

function readLocalCatalog(): Record<string, { models?: Job["models"][string] }> {
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

export async function exportAccessLease(model: string, authType?: "oauth" | "api_key") {
	const minutes = 5;
	const validUntil = Date.now() + minutes * 60_000;
	const args =
		authType === "api_key"
			? ["print-api-key", "--model", model]
			: ["print-bearer-token", "--model", model, "--min-expiry", `${minutes}m`];
	try {
		const { stdout } = await promisify(execFile)("pi", ["auth", ...args], { timeout: 30_000 });
		const token = stdout.trim();
		if (!token) throw Error();
		return { token, validUntil };
	} catch {
		// Subprocess diagnostics may contain secrets.
		throw Error(`Could not obtain Pi credential for ${model}`);
	}
}

export async function resolveModels(specs: string[]): Promise<ResolvedAuth> {
	const parsed = specs.map(parseModelSpec);
	const catalog = readLocalCatalog();
	const authTypes = readAuthTypes();
	const models: Job["models"] = {};
	const credentials: ResolvedAuth["credentials"] = Object.create(null);

	for (const { provider, modelId, raw } of parsed) {
		const catalogEntry = catalog[provider]?.models?.find((m) => m.id === modelId);
		if (catalogEntry) {
			models[provider] ??= [];
			if (!models[provider].some((m) => m.id === modelId)) {
				models[provider].push(catalogEntry);
			}
		}
		if (!credentials[provider]) {
			// Tokens travel only over stdin to the ephemeral container; never log or put in argv/env.
			const authType = authTypes[provider];
			credentials[provider] = { ...(await exportAccessLease(raw, authType)), authType };
		}
	}
	return { models, credentials };
}

export interface EphemeralContainerOptions {
	runId?: string;
	image?: string;
	network: string;
	workspace?: string;
	scratch?: string;
	context?: string;
	sessions?: string;
	tmpfsProbe?: boolean;
}

export function ephemeralArgs(opts: EphemeralContainerOptions): string[] {
	const args = isolatedRun(opts.network);
	if (opts.runId) args.push("--name", agentName(opts.runId), "--label", `pi-stick.run=${opts.runId}`);
	if (opts.tmpfsProbe) {
		const uid = process.getuid?.();
		args.push(
			"--tmpfs",
			`${CONTAINER_REPO_DIR}:rw,uid=${uid},mode=0700`,
			"--tmpfs",
			`/scratch:rw,uid=${uid},mode=0700`,
			"--tmpfs",
			`/sessions:rw,uid=${uid},mode=0700`,
		);
	} else {
		// The runner controls entries inside workspace; do not let Docker resolve repo on the host.
		if (opts.workspace) args.push("-v", `${opts.workspace}:${CONTAINER_WORKSPACE_DIR}`);
		if (opts.scratch) args.push("-v", `${opts.scratch}:/scratch`);
		if (opts.context) args.push("-v", `${opts.context}:/context:ro`);
		if (opts.sessions) args.push("-v", `${opts.sessions}:/sessions`);
	}
	args.push(opts.image ?? IMAGE, "node", "/app/agent-runtime.ts");
	return args;
}

export async function probe(image = IMAGE): Promise<void> {
	// Check from the host: an older image's bundled self-check may not exercise Git.
	const [docker, ...args] = isolatedRun("none");
	try {
		const { stdout } = await promisify(execFile)(docker, [...args, image, "git", "--version"], {
			timeout: 30_000,
			killSignal: "SIGKILL",
		});
		if (!stdout.startsWith("git version ")) throw Error("Unexpected git --version output");
	} catch (cause) {
		throw Error(`Cannot run git --version in agent image '${image}'; check or rebuild the image`, { cause });
	}
	const argv = ephemeralArgs({ image, network: "none", tmpfsProbe: true });
	const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
	const exit = closed(child);
	exit.catch(() => {});
	child.stdin.on("error", () => {});
	const send = (data: HostMessage) =>
		new Promise<void>((resolve, reject) =>
			child.stdin.write(`${JSON.stringify(data)}\n`, (err) => (err ? reject(err) : resolve())),
		);
	const lines = createInterface({ input: child.stdout });
	let ready = false;
	try {
		const id = runId();
		await send({
			type: RUN,
			id,
			check: true,
			models: {},
			credentials: {},
		});
		for await (const line of lines) {
			const msg = readRuntime(line);
			if (isRequest(msg) && msg.type !== "refresh_token") {
				if (msg.type === "exec") {
					await send({ type: "exec_chunk", id: msg.id, chunk: Buffer.from("probe-bash").toString("base64") });
					await send({
						type: "response",
						command: msg.type,
						id: msg.id,
						success: true,
						data: { text: "", exitCode: 7 },
					});
				} else
					await send({
						type: "response",
						command: msg.type,
						id: msg.id,
						success: true,
						data: { text: `probe-ok:${msg.type}`, error: false },
					});
				continue;
			}
			if (
				msg.type === "response" &&
				msg.command === "run" &&
				msg.id === id &&
				msg.success === true &&
				"ready" in msg.data
			) {
				ready = true;
				break;
			}
			throw Error("Unexpected probe protocol message; rebuild the agent image");
		}
		child.stdin.end();
		const [code] = await exit;
		if (code !== 0 || !ready)
			throw Error("Ephemeral agent runtime self-check failed; if incompatible, run pistick containers build");
	} finally {
		lines.close();
		child.stdin.destroy();
		child.kill();
		await exit;
	}
}

export async function doctor(extraChecks: Array<[string, () => unknown | Promise<unknown>]> = []): Promise<boolean> {
	console.log(`Mode: ${devMode ? "dev" : "installed"}`);
	console.log(`Home: ${ROOT}`);
	if (ASSETS !== ROOT) console.log(`Assets: ${ASSETS}`);
	console.log(`Settings: ${settingsPath()}`);
	console.log(`Image: ${IMAGE}`);
	const settings = userSettings();
	const checks: Array<[string, () => unknown | Promise<unknown>]> = [
		["Docker daemon", () => output(["docker", "info", "--format", "{{.ServerVersion}}"])],
		[`Agent image matches installed build inputs (${IMAGE})`, checkImageInputs],
		["Ephemeral runtime self-check (Git, durable SQLite, Codemode, JSONL RPC; no model call)", () => probe(IMAGE)],
		[
			settings.default_model
				? `Pi default model auth (${settings.default_model})`
				: "Pi default model (not set; configure per action or in settings.json)",
			async () => {
				if (settings.default_model) await resolveModels([settings.default_model]);
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

const inputLabel = "io.pi-stick.build-inputs.sha256";

export function imageFingerprint(stage?: string, assets = ASSETS) {
	const hash = createHash("sha256");
	if (!fs.lstatSync(join(assets, "runtime-tools")).isDirectory())
		throw Error("Expected a real runtime-tools directory");
	const tools = fs
		.readdirSync(join(assets, "runtime-tools"))
		.filter((name) => name.endsWith(".ts"))
		.sort();
	if (stage) fs.mkdirSync(join(stage, "runtime-tools"));
	for (const name of [
		"Dockerfile",
		".dockerignore",
		"package.json",
		"package-lock.json",
		"agent-runtime.ts",
		"runtime-auth.ts",
		...tools.map((name) => `runtime-tools/${name}`),
	]) {
		const file = join(assets, name);
		if (!fs.lstatSync(file).isFile()) throw Error(`Expected a regular build input: ${file}`);
		const bytes = fs.readFileSync(file);
		hash.update(`${name}\0${bytes.length}\0`).update(bytes);
		if (stage) fs.writeFileSync(join(stage, name), bytes);
	}
	return hash.digest("hex");
}

export function checkImageInputs() {
	let label: string;
	try {
		label = output([
			"docker",
			"image",
			"inspect",
			IMAGE,
			"--format",
			`{{with .Config.Labels}}{{index . "${inputLabel}"}}{{end}}`,
		]);
	} catch {
		throw Error(
			`Cannot inspect ${IMAGE}. Check Docker access; if the image is missing, run pistick containers build.`,
		);
	}
	if (!label || label === "<no value>")
		throw Error(`Image ${IMAGE} has no build fingerprint. Run pistick containers build to record one.`);
	if (label !== imageFingerprint())
		throw Error(`Image ${IMAGE} does not match installed runtime files. Run pistick containers build.`);
}

export function buildImage(activeRunCount: number) {
	if (activeRunCount > 0) throw Error(`Cannot build while ${activeRunCount} task run(s) are active`);
	const stage = fs.mkdtempSync(join(tmpdir(), "pi-stick-build-"));
	try {
		run(["docker", "build", "--label", `${inputLabel}=${imageFingerprint(stage)}`, "-t", IMAGE, stage]);
	} finally {
		fs.rmSync(stage, { recursive: true, force: true });
	}
}
