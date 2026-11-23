import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { type LoadedAction, loadAction, type ResolvedAgentSpec, resolveInputs, runHook } from "./actions.ts";
import {
	closed,
	compiled,
	devMode,
	gitCommand,
	isLocked,
	json,
	output,
	prompt,
	read,
	runId,
	STATE,
	touch,
	tryLock,
	writeJson,
} from "./platform.ts";
import { ephemeralArgs, parseModelSpec, resolveModels } from "./system.ts";
import type { RpcPolicy } from "./tasks.ts";
import { TaskEnv } from "./tasks.ts";
import { getProject, type ProjectInfo } from "./workspace.ts";

export const VALID_ID = /^[0-9a-f]{32}$/;

export interface RunMeta {
	id: string;
	project: string;
	action: string;
	ref?: string;
	baseHead?: string;
	keepUp?: boolean;
	createdAt: string;
	updatedAt: string;
	status: "preparing" | "running" | "done" | "failed";
}

export interface RunConfig {
	project: string;
	action: string;
	ref?: string;
	inputs: Record<string, string>;
	prompt: string;
	keepUp: boolean;
	requestId: string;
	mode: "run" | "resume" | "continue";
	prepared?: boolean;
	agentLaunchAttempted: boolean;
	hookPending?: "prepare" | "after";
	prepareDone?: boolean;
	afterDone?: boolean;
	agentDone?: boolean;
}

export function runDir(id: string) {
	if (!VALID_ID.test(id)) throw Error("Invalid run ID");
	return join(STATE, "runs", id);
}

export function runLock(id: string) {
	return join(runDir(id), "lock");
}

export function activeRunIds(): string[] {
	const runsDir = join(STATE, "runs");
	if (!fs.existsSync(runsDir)) return [];
	const active: string[] = [];
	for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || !VALID_ID.test(entry.name)) continue;
		if (isLocked(join(runsDir, entry.name, "lock"))) active.push(entry.name);
	}
	return active;
}

export function readMeta(id: string): RunMeta {
	const file = join(runDir(id), "meta.json");
	if (!fs.existsSync(file)) throw Error(`Unknown run: ${id}`);
	return json(file) as RunMeta;
}

export function writeMeta(id: string, meta: RunMeta) {
	writeJson(join(runDir(id), "meta.json"), { ...meta, updatedAt: new Date().toISOString() });
}

export function status(dir: string, msg: string, agent?: string) {
	const prefix = agent ? `[${agent}] ` : "";
	const safe = `${prefix}${msg}`.replace(/[\p{C}\p{Z}]/gu, (c) => {
		if (" \t\n".includes(c)) return c;
		if (c === "\r") return "\\r";
		const n = c.codePointAt(0)!;
		return (
			(n < 256 ? "\\x" : n <= 65535 ? "\\u" : "\\U") + n.toString(16).padStart(n < 256 ? 2 : n <= 65535 ? 4 : 8, "0")
		);
	});
	fs.appendFileSync(join(dir, "progress"), `${safe}\n`);
}

function composeInstructions(
	agent: ResolvedAgentSpec,
	project: ProjectInfo,
	services: string[],
	contextFiles: string[],
	availableSubagents?: Record<string, ResolvedAgentSpec>,
): string {
	const parts: string[] = [
		`You are agent '${agent.name}' running inside an isolated Docker container for project '${project.name}'.`,
		`Repository workspace: /workspace (mode: ${agent.mode}).`,
		`Your writable scratch directory: /scratch/${agent.name} (shared with project runner at /scratch/${agent.name}).`,
	];
	if (agent.mode === "read-only") {
		parts.push(
			"Read-only workspace policy: do not modify repository files in /workspace. Put temporary scripts, tests, or experiments in your scratch directory.",
		);
	}
	if (services.length) {
		parts.push(
			`Running project Compose services on your Docker network: ${services.join(", ")}. You can reach them directly over the network or use exec/logs/ps/restart as permitted.`,
		);
	}
	if (contextFiles.length) {
		parts.push(`Read-only prepared context files in /context: ${contextFiles.join(", ")}.`);
	}
	if (availableSubagents && Object.keys(availableSubagents).length && agent.tools.includes("delegate")) {
		const lines = Object.values(availableSubagents).map(
			(a) => `- ${a.name} (mode: ${a.mode}, model: ${a.model})${a.description ? `: ${a.description}` : ""}`,
		);
		parts.push(
			`Configured subagents you can invoke in parallel via the 'delegate' tool:\n${lines.join("\n")}\nNote: parallel batches may include multiple read-only subagents, while read-write subagents must run one at a time.`,
		);
	}
	const agentsMd = join(project.folder, "AGENTS.md");
	if (fs.existsSync(agentsMd)) {
		const notes = read(agentsMd).trim();
		if (notes) parts.push(`Project notes (AGENTS.md):\n${notes}`);
	}
	if (agent.instructions.trim()) {
		parts.push(`Action instructions:\n${agent.instructions.trim()}`);
	}
	return parts.join("\n\n");
}

function buildInitialPrompt(action: LoadedAction, userPrompt: string, inputs: Record<string, string>): string {
	const lines: string[] = [];
	if (userPrompt.trim()) lines.push(userPrompt.trim());
	else if (action.description) lines.push(action.description);
	else lines.push(`Execute action '${action.name}'.`);
	const inputEntries = Object.entries(inputs);
	if (inputEntries.length) {
		lines.push(`\nAction inputs:\n${inputEntries.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`);
	}
	return lines.join("\n");
}

function policyForAgent(action: LoadedAction, agentName?: string): RpcPolicy {
	const spec = !agentName || agentName === "orchestrator" ? action.orchestrator : action.agents[agentName];
	if (!spec) return { allowExec: false, allowLogs: false, allowPs: false, allowRestart: false };
	return {
		allowedServices: spec.allowedServices,
		allowExec: spec.tools.includes("exec"),
		allowLogs: spec.tools.includes("logs"),
		allowPs: spec.tools.includes("ps"),
		allowRestart: spec.tools.includes("restart"),
	};
}

async function spawnWorker(id: string, fd: number) {
	const dir = runDir(id);
	const log = fs.openSync(join(dir, "worker.log"), "a");
	try {
		const args = ["_worker", id];
		if (!compiled) args.unshift(process.argv[1]);
		const child = spawn(process.execPath, args, {
			detached: true,
			stdio: ["ignore", log, log, fd],
			env: { ...process.env, ...(devMode ? { PI_STICK_DEV: "1" } : {}) },
		});
		await once(child, "spawn");
		child.unref();
	} finally {
		fs.closeSync(log);
	}
}

export interface LaunchRunOptions {
	projectName: string;
	actionName: string;
	ref?: string;
	rawInputs: string[];
	promptText: string;
	keepUp: boolean;
}

export async function launchRun(opts: LaunchRunOptions): Promise<string> {
	const project = getProject(opts.projectName);
	const action = loadAction(opts.actionName, project, true);
	const inputs = resolveInputs(action, opts.rawInputs);
	const id = runId();
	const task = new TaskEnv(id, project);
	task.validateBase();

	fs.mkdirSync(task.dir, { recursive: true, mode: 0o700 });
	touch(join(task.dir, "progress"));
	const fd = fs.openSync(runLock(id), "a");
	try {
		if (!tryLock(fd)) throw Error("Could not acquire run lock");
		const now = new Date().toISOString();
		writeMeta(id, {
			id,
			project: project.name,
			action: action.name,
			ref: opts.ref,
			keepUp: opts.keepUp,
			createdAt: now,
			updatedAt: now,
			status: "preparing",
		});
		writeJson(join(task.dir, "run-config.json"), {
			project: project.name,
			action: action.name,
			ref: opts.ref,
			inputs,
			prompt: buildInitialPrompt(action, opts.promptText, inputs),
			keepUp: opts.keepUp,
			requestId: id,
			mode: "run",
			prepared: false,
			agentLaunchAttempted: false,
		} satisfies RunConfig);
		await spawnWorker(id, fd);
	} finally {
		fs.closeSync(fd);
	}
	console.log(`Run: ${id}\nFollow: pistick follow ${id}`);
	return id;
}

function requireSession(id: string) {
	const db = join(runDir(id), "session", `${id}.sqlite`);
	if (!fs.lstatSync(db, { throwIfNoEntry: false })?.isFile())
		throw Error(`Session database missing for run ${id}: ${db}; refusing to start without its history`);
}

export async function launchResume(id: string, retryHook = false): Promise<string> {
	const dir = runDir(id);
	const exitFile = join(dir, "exit");
	const cfgFile = join(dir, "run-config.json");
	if (!fs.existsSync(cfgFile)) throw Error(`Unknown run: ${id}`);
	const fd = fs.openSync(runLock(id), "a");
	try {
		if (!tryLock(fd)) throw Error(`Run ${id} is currently active; use 'pistick follow ${id}'`);
		const cfg = json(cfgFile) as RunConfig;
		if (fs.existsSync(exitFile) && read(exitFile).trim() === "0")
			throw Error("Run already completed; use 'pistick continue' for follow-up instructions");
		// A legacy config without the marker cannot prove the agent never started.
		if (cfg.agentLaunchAttempted !== false) requireSession(id);
		if (cfg.hookPending && !retryHook)
			throw Error(
				`Outcome of ${cfg.hookPending} hook unknown; verify its side effects before using resume --retry-hook`,
			);
		// Older versions overwrote the turn kind on resume; only follow-ups have a fresh request ID.
		if (cfg.mode === "resume") {
			cfg.mode = cfg.requestId === id ? "run" : "continue";
			writeJson(cfgFile, cfg);
		}
		fs.rmSync(exitFile, { force: true });
		await spawnWorker(id, fd);
	} finally {
		fs.closeSync(fd);
	}
	console.log(`Resuming: ${id}\nFollow: pistick follow ${id}`);
	return id;
}

export async function launchContinue(id: string, promptText: string, keepUp?: boolean): Promise<string> {
	if (!promptText.trim()) throw Error("Follow-up prompt cannot be empty");
	const dir = runDir(id);
	const cfgFile = join(dir, "run-config.json");
	const exitFile = join(dir, "exit");
	if (!fs.existsSync(cfgFile)) throw Error(`Unknown run: ${id}`);
	const fd = fs.openSync(runLock(id), "a");
	try {
		if (!tryLock(fd)) throw Error(`Run ${id} is currently active; wait for it to finish first`);
		const cfg = json(cfgFile) as RunConfig;
		const project = getProject(cfg.project);
		const task = new TaskEnv(id, project);
		if (!fs.existsSync(task.repo)) throw Error(`Workspace for run ${id} is no longer present`);
		if (cfg.hookPending) throw Error(`Resolve pending ${cfg.hookPending} hook with resume first`);
		if (!cfg.prepared) throw Error("Run preparation is incomplete; resume it first");
		requireSession(id);
		delete cfg.afterDone;
		delete cfg.agentDone;
		cfg.mode = "continue";
		cfg.prompt = promptText.trim();
		cfg.requestId = runId();
		if (keepUp !== undefined) cfg.keepUp = keepUp;
		writeJson(cfgFile, cfg);
		fs.rmSync(exitFile, { force: true });
		await spawnWorker(id, fd);
	} finally {
		fs.closeSync(fd);
	}
	console.log(`Continuing: ${id}\nFollow: pistick follow ${id}`);
	return id;
}

export async function worker(id: string): Promise<number> {
	const dir = runDir(id);
	const cfgFile = join(dir, "run-config.json");
	const cfg = json(cfgFile) as RunConfig;
	const meta = readMeta(id);
	const project = getProject(cfg.project);
	const action = loadAction(cfg.action, project, true);
	const task = new TaskEnv(id, project);
	let code = 1;
	let stackStartAttempted = false;

	try {
		if (cfg.hookPending && !action.hooks[cfg.hookPending]) throw Error(`Pending ${cfg.hookPending} hook is missing`);
		let services: string[];
		if (cfg.mode === "continue") {
			status(dir, `Starting project stack for follow-up on ${project.name}…`);
			if (!fs.existsSync(task.composeFile)) task.materializeCompose();
			services = task.services();
			stackStartAttempted = true;
			try {
				task.start();
			} catch {
				task.up(false);
			}
		} else if (cfg.prepared) {
			status(dir, `Resuming run on ${project.name}…`);
			if (!fs.existsSync(task.composeFile)) task.materializeCompose();
			services = task.services();
			stackStartAttempted = true;
			task.up(false);
		} else {
			status(dir, `Preparing isolated workspace for ${project.name}…`);
			if (!cfg.prepareDone && !cfg.hookPending) {
				meta.baseHead = task.prepareWorkspace(cfg.ref).baseHead;
				writeMeta(id, meta);
			}

			if (action.hooks.prepare && !cfg.prepareDone) {
				cfg.hookPending = "prepare";
				writeJson(cfgFile, cfg);
				status(dir, "Running prepare hook…");
				runHook(action.hooks.prepare, {
					runId: id,
					project,
					action,
					runDir: dir,
					repoDir: task.repo,
					scratchDir: task.scratch,
					contextDir: task.context,
					ref: cfg.ref,
					baseHead: meta.baseHead,
					prompt: cfg.prompt,
					inputs: cfg.inputs,
				});
				meta.baseHead = output([...gitCommand(task.repo), "rev-parse", "HEAD"]);
				writeMeta(id, meta);
				delete cfg.hookPending;
				cfg.prepareDone = true;
				writeJson(cfgFile, cfg);
			}

			status(dir, "Starting project Compose stack…");
			const mat = task.materializeCompose();
			services = mat.services;
			stackStartAttempted = true;
			task.up(true);
			cfg.prepared = true;
			writeJson(cfgFile, cfg);
		}

		const reportFile = join(dir, "report.md");
		const outputsDir = join(dir, "outputs");
		const patchFile = join(dir, "changes.patch");
		if (!cfg.agentDone) {
			const contextFiles = fs.existsSync(task.context) ? fs.readdirSync(task.context).sort() : [];
			const modelSpecs = [action.orchestrator.model, ...Object.values(action.agents).map((a) => a.model)];
			const auth = resolveModels(modelSpecs);
			const orchModel = parseModelSpec(action.orchestrator.model);

			meta.status = "running";
			meta.keepUp = cfg.keepUp;
			writeMeta(id, meta);
			status(dir, `Starting action '${action.name}' (${action.orchestrator.model})…`);

			const subagentPayloads: Record<string, unknown> = {};
			for (const [agentName, spec] of Object.entries(action.agents)) {
				const parsedModel = parseModelSpec(spec.model);
				subagentPayloads[agentName] = {
					name: agentName,
					description: spec.description,
					model: { provider: parsedModel.provider, modelId: parsedModel.modelId },
					instructions: composeInstructions(spec, project, services, contextFiles),
					mode: spec.mode,
					tools: spec.tools,
					maxTurns: spec.maxTurns,
				};
			}

			const jobPayload: Record<string, unknown> = {
				id,
				models: auth.models,
				credentials: auth.credentials,
				orchestrator: {
					name: "orchestrator",
					model: { provider: orchModel.provider, modelId: orchModel.modelId },
					instructions: composeInstructions(action.orchestrator, project, services, contextFiles, action.agents),
					mode: action.orchestrator.mode,
					tools: action.orchestrator.tools,
					maxTurns: action.orchestrator.maxTurns,
				},
				agents: subagentPayloads,
				stages: action.stages,
				prompt: cfg.prompt,
				requestId: cfg.requestId,
				continueRun: cfg.mode === "continue",
			};

			if (cfg.agentLaunchAttempted === false) {
				fs.mkdirSync(join(dir, "session"), { recursive: true, mode: 0o700 });
				cfg.agentLaunchAttempted = true;
				writeJson(cfgFile, cfg);
			} else {
				requireSession(id);
			}
			const result = await executeAgentContainer(
				task,
				jobPayload,
				(agentName) => policyForAgent(action, agentName),
				(line, agentName) => status(dir, line, agentName),
			);

			fs.writeFileSync(reportFile, `${result.report}\n`);
			if (result.outputs && Object.keys(result.outputs).length) {
				fs.mkdirSync(outputsDir, { recursive: true, mode: 0o700 });
				for (const [name, content] of Object.entries(result.outputs)) {
					if (/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) {
						fs.writeFileSync(join(outputsDir, `${name}.md`), `${content}\n`);
					}
				}
			}

			const { patch, untracked } = task.captureDiff(meta.baseHead);
			status(dir, result.report, "orchestrator");
			status(dir, `Wrote: ${reportFile}`);
			if (patch.trim()) status(dir, `Patch: ${join(dir, "changes.patch")}`);
			if (untracked.length) status(dir, `Untracked files: ${untracked.length}`);

			cfg.agentDone = true;
			writeJson(cfgFile, cfg);
		}

		if (action.hooks.after && !cfg.afterDone) {
			cfg.hookPending = "after";
			writeJson(cfgFile, cfg);
			status(dir, "Running after hook…");
			runHook(action.hooks.after, {
				runId: id,
				project,
				action,
				runDir: dir,
				repoDir: task.repo,
				scratchDir: task.scratch,
				contextDir: task.context,
				ref: cfg.ref,
				baseHead: meta.baseHead,
				prompt: cfg.prompt,
				inputs: cfg.inputs,
				exitCode: 0,
				reportFile,
				patchFile: fs.existsSync(patchFile) ? patchFile : undefined,
				outputsDir: fs.existsSync(outputsDir) ? outputsDir : undefined,
			});
			delete cfg.hookPending;
			cfg.afterDone = true;
			writeJson(cfgFile, cfg);
		}
		code = 0;
	} catch (err) {
		status(dir, `Failed; see private log: ${join(dir, "worker.log")}`);
		console.error(err);
	} finally {
		if (stackStartAttempted && !cfg.keepUp) {
			try {
				task.stop();
			} catch (err) {
				code = 1;
				status(dir, `Failed to stop project stack; see private log: ${join(dir, "worker.log")}`);
				console.error("Failed to stop project stack:", err);
			}
		}
		meta.status = code === 0 ? "done" : "failed";
		writeMeta(id, meta);
		touch(join(dir, "last-used"));
		fs.writeFileSync(join(dir, "exit.tmp"), String(code));
		fs.renameSync(join(dir, "exit.tmp"), join(dir, "exit"));
	}
	return code;
}

export async function follow(id: string) {
	const dir = runDir(id);
	const exit = join(dir, "exit");
	const lockPath = join(dir, "lock");
	if (!fs.existsSync(dir)) throw Error("Unknown run");
	const file = fs.openSync(join(dir, "progress"), "r");
	const buf = Buffer.alloc(65536);
	async function drain() {
		for (;;) {
			const n = fs.readSync(file, buf);
			if (n <= 0) break;
			if (!process.stdout.write(Buffer.from(buf.subarray(0, n)))) await once(process.stdout, "drain");
		}
	}
	try {
		for (;;) {
			await drain();
			if (fs.existsSync(exit)) {
				await drain();
				return Number(read(exit));
			}
			const fd = fs.openSync(lockPath, "a");
			try {
				if (tryLock(fd) && !fs.existsSync(exit))
					throw Error("Worker interrupted; inspect worker.log or resume this run");
			} finally {
				fs.closeSync(fd);
			}
			await sleep(500);
		}
	} finally {
		fs.closeSync(file);
	}
}

export interface AgentRunResult {
	report: string;
	outputs?: Record<string, string>;
}

export async function executeAgentContainer(
	task: TaskEnv,
	jobPayload: Record<string, unknown>,
	resolvePolicy: (agent?: string) => RpcPolicy,
	onProgress: (line: string, agent?: string) => void,
): Promise<AgentRunResult> {
	const argv = ephemeralArgs({
		network: task.network(),
		repo: task.repo,
		scratch: task.scratch,
		context: task.context,
		sessions: join(task.dir, "session"),
	});
	const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
	const exit = closed(child);
	exit.catch(() => {});
	child.stdin.on("error", () => {});

	let writeQueue = Promise.resolve();
	const send = (value: unknown) => {
		const next = writeQueue.then(
			() =>
				new Promise<void>((resolve, reject) =>
					child.stdin.write(`${JSON.stringify(value)}\n`, (err) => (err ? reject(err) : resolve())),
				),
		);
		writeQueue = next.catch(() => {});
		return next;
	};

	const lines = createInterface({ input: child.stdout });
	const inflight = new Set<Promise<void>>();
	let report: string | undefined;
	let outputs: Record<string, string> | undefined;
	let rpcCount = 0;

	try {
		await send(jobPayload);
		for await (const line of lines) {
			const msg = JSON.parse(line);
			if (typeof msg.progress === "string") {
				onProgress(msg.progress, typeof msg.agent === "string" ? msg.agent : undefined);
				continue;
			}
			if (typeof msg.report === "string") {
				report = msg.report;
				if (msg.outputs && typeof msg.outputs === "object") outputs = msg.outputs as Record<string, string>;
				break;
			}
			if (typeof msg.rpc === "number" && typeof msg.method === "string") {
				if (++rpcCount > 500) throw Error("RPC call limit exceeded");
				const rpcId = msg.rpc as number;
				const method = msg.method as string;
				const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
				const agentName = typeof msg.agent === "string" ? msg.agent : undefined;
				const work = (async () => {
					let result: { text: string; error?: boolean };
					try {
						result = await task.handleRpc(method, params, resolvePolicy(agentName));
					} catch (err) {
						result = {
							text: err instanceof Error ? err.message : "RPC operation failed",
							error: true,
						};
					}
					await send({ rpc: rpcId, result });
				})();
				inflight.add(work);
				work.finally(() => inflight.delete(work));
				continue;
			}
			throw Error("Unexpected message from agent container");
		}
		await Promise.allSettled(inflight);
		await writeQueue;
		child.stdin.end();
		const [code] = await exit;
		if (code !== 0 || !report?.trim()) throw Error("Agent container failed to return a report");
		return { report, outputs };
	} finally {
		lines.close();
		child.stdin.destroy();
		child.kill();
		await exit;
	}
}

export function listRuns(all: boolean) {
	const runsDir = join(STATE, "runs");
	if (!fs.existsSync(runsDir)) {
		console.log("No runs found.");
		return;
	}
	const rows: Array<{ id: string; state: string; project: string; action: string; updatedAt: string }> = [];
	for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || !VALID_ID.test(entry.name)) continue;
		const id = entry.name;
		const dir = join(runsDir, id);
		const active = isLocked(join(dir, "lock"));
		const metaFile = join(dir, "meta.json");
		const meta: Partial<RunMeta> = fs.existsSync(metaFile) ? json(metaFile) : {};
		const exitFile = join(dir, "exit");
		const state = active
			? "running"
			: fs.existsSync(exitFile)
				? read(exitFile).trim() === "0"
					? "done"
					: "failed"
				: "interrupted";
		if (!all && state !== "running") continue;
		rows.push({
			id,
			state,
			project: meta.project ?? "-",
			action: meta.action ?? "-",
			updatedAt: meta.updatedAt ?? meta.createdAt ?? "-",
		});
	}
	rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	if (!rows.length) {
		console.log(all ? "No runs found." : "No active runs. Use --all to list past runs.");
		return;
	}
	for (const r of rows) {
		console.log(`${r.id}  ${r.state.padEnd(11)}  ${r.project}  ${r.action}  ${r.updatedAt}`);
	}
}

export function stopRun(id: string) {
	const meta = readMeta(id);
	if (isLocked(runLock(id))) throw Error(`Run ${id} is currently active; wait for it to finish before stopping`);
	const task = new TaskEnv(id, getProject(meta.project));
	task.stop();
	touch(join(task.dir, "last-used"));
	console.log(`Stopped containers for run ${id}.`);
}

export function diffRun(id: string) {
	const meta = readMeta(id);
	const task = new TaskEnv(id, getProject(meta.project));
	if (!fs.existsSync(task.repo)) {
		const patchFile = join(task.dir, "changes.patch");
		if (fs.existsSync(patchFile)) {
			process.stdout.write(read(patchFile));
			return;
		}
		console.log("No changes.");
		return;
	}
	const { patch, untracked } = task.captureDiff(meta.baseHead);
	if (patch) process.stdout.write(patch);
	if (untracked.length) {
		console.log(`\nUntracked files:\n${untracked.map((f) => `  ${f}`).join("\n")}`);
	}
	if (!patch && !untracked.length) console.log("No changes.");
}

export async function cleanup(days: number, dry: boolean) {
	const runsDir = join(STATE, "runs");
	const cutoff = Date.now() - days * 86400000;
	if (!fs.existsSync(runsDir)) {
		console.log("No eligible pi-stick runs.");
		return;
	}
	const items: Array<{ dir: string; key: string; compose: string }> = [];
	for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
		const id = entry.name;
		if (!entry.isDirectory() || !VALID_ID.test(id)) continue;
		const dir = join(runsDir, id);
		if (isLocked(join(dir, "lock"))) continue;
		if (!fs.existsSync(join(dir, "exit"))) continue;
		const last = fs.statSync(join(dir, "last-used"), { throwIfNoEntry: false });
		if (!last?.isFile() || last.mtimeMs > cutoff) continue;
		const metaFile = join(dir, "meta.json");
		const project = fs.existsSync(metaFile) ? (json(metaFile) as Partial<RunMeta>).project : undefined;
		const key = project ? `pi-stick-${project}-${id.slice(0, 12)}` : `pi-stick-run-${id.slice(0, 12)}`;
		const compose = join(dir, "compose.yaml");
		items.push({ dir, key, compose });
		console.log(`${id} (${project ?? "unknown"}): workspace, scratch stack/volumes, reports and session`);
	}
	if (!items.length) {
		console.log("No eligible pi-stick runs.");
		return;
	}
	if (dry || (await prompt("Permanently delete listed pi-stick runs? [y/N] ")).toLowerCase() !== "y") return;
	for (const { dir, key, compose } of items) {
		if (fs.existsSync(compose)) {
			const res = spawn("docker", ["compose", "-p", key, "-f", compose, "down", "--volumes"], { stdio: "inherit" });
			await closed(res);
		}
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
