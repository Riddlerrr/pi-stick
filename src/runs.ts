import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import type { UsageState } from "@earendil-works/pi-durable";
import { readActionSnapshot, saveActionSnapshot } from "./action-snapshot.ts";
import { type LoadedAction, loadAction, type ResolvedAgentSpec, resolveInputs, runHook } from "./actions.ts";
import { agentName } from "./container.ts";
import {
	closed,
	command,
	compiled,
	devMode,
	isLocked,
	json,
	output,
	prompt,
	read,
	run,
	runId,
	STATE,
	touch,
	tryLock,
	writeJson,
} from "./platform.ts";
import { ephemeralArgs, exportAccessLease, parseModelSpec, resolveModels } from "./system.ts";
import { CONTAINER_REPO_DIR, type RpcPolicy, TaskEnv } from "./tasks.ts";
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
	usage?: UsageState;
}

export interface RunConfig {
	project: string;
	action: string;
	ref?: string;
	inputs: Record<string, string>;
	prompt: string;
	keepUp: boolean;
	requestId: string;
	mode: "run" | "continue";
	prepared?: boolean;
	agentLaunchAttempted: boolean;
	actionDigest: string;
	hookPending?: "prepare" | "after";
	prepareDone?: boolean;
	setupPending?: boolean;
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
	projectNotes: string | null,
	services: string[],
	contextFiles: string[],
	availableSubagents?: Record<string, ResolvedAgentSpec>,
): string {
	const parts: string[] = [
		`You are agent '${agent.name}' running inside an isolated Docker container for project '${project.name}'.`,
		`Repository workspace: ${CONTAINER_REPO_DIR} in the agent container and runner (mode: ${agent.mode}).`,
		`Your writable scratch directory: /scratch/${agent.name} (shared with project runner at /scratch/${agent.name}).`,
	];
	if (agent.mode === "read-only") {
		parts.push(
			`Read-only workspace policy: do not modify repository files in ${CONTAINER_REPO_DIR}. Put temporary scripts, tests, or experiments in your scratch directory.`,
		);
	}
	if (services.length) {
		parts.push(
			`Running project Compose services on your Docker network: ${services.join(", ")}. You can reach them directly over the network or use bash/logs/ps/restart as permitted.`,
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
	if (projectNotes?.trim()) parts.push(`Project notes (AGENTS.md):\n${projectNotes.trim()}`);
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

function policyForAgent(action: Pick<LoadedAction, "agents" | "orchestrator">, agentName?: string): RpcPolicy {
	const spec = !agentName || agentName === "orchestrator" ? action.orchestrator : action.agents[agentName];
	if (!spec) return { allowExec: false, allowLogs: false, allowPs: false, allowRestart: false };
	return {
		allowedServices: spec.allowedServices,
		allowExec: spec.tools.includes("bash"),
		allowLogs: spec.tools.includes("logs"),
		allowPs: spec.tools.includes("ps"),
		allowRestart: spec.tools.includes("restart"),
	};
}

async function spawnWorker(id: string, fd: number) {
	const dir = runDir(id);
	const fifo = join(dir, "kill.fifo");
	fs.rmSync(fifo, { force: true });
	command(["mkfifo", "-m", "600", fifo]);
	const control = fs.openSync(fifo, fs.constants.O_RDWR);
	const log = fs.openSync(join(dir, "worker.log"), "a");
	try {
		const args = ["_worker", id];
		if (!compiled) args.unshift(process.argv[1]);
		const child = spawn(process.execPath, args, {
			detached: true,
			stdio: ["ignore", log, log, fd, control],
			env: { ...process.env, ...(devMode ? { PI_STICK_DEV: "1" } : {}) },
		});
		await once(child, "spawn");
		child.unref();
	} finally {
		fs.closeSync(control);
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
	const { services } = task.validateBase();
	for (const agent of [action.orchestrator, ...Object.values(action.agents)]) {
		if (!agent) continue;
		for (const service of agent.allowedServices) {
			if (service !== "*" && !Object.hasOwn(services, service)) {
				const path = agent === action.orchestrator ? "orchestrator" : `agents.${agent.name}`;
				throw Error(`${path}.allowedServices: unknown service '${service}' in project '${project.name}'`);
			}
		}
	}

	fs.mkdirSync(task.dir, { recursive: true, mode: 0o700 });
	touch(join(task.dir, "progress"));
	const fd = fs.openSync(runLock(id), "a");
	try {
		if (!tryLock(fd)) throw Error("Could not acquire run lock");
		const actionDigest = saveActionSnapshot(task.dir, action, project.folder);
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
			prepareDone: false,
			setupPending: false,
			agentLaunchAttempted: false,
			actionDigest,
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
		readActionSnapshot(dir, cfg.actionDigest);
		// A legacy config without the marker cannot prove the agent never started.
		if (cfg.agentLaunchAttempted !== false) requireSession(id);
		// Older workers did not checkpoint setup; once Compose was materialized it may have run.
		if (!retryHook && !cfg.prepared && (cfg.setupPending ?? fs.existsSync(join(dir, "compose.yaml"))))
			throw Error("Outcome of setup-project unknown; inspect its side effects before using resume --retry-hook");
		if (cfg.hookPending && !retryHook)
			throw Error(
				`Outcome of ${cfg.hookPending} hook unknown; verify its side effects before using resume --retry-hook`,
			);
		if (cfg.agentLaunchAttempted !== false) removeOrphanAgent(id);
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
		if (!readActionSnapshot(dir, cfg.actionDigest).orchestrator)
			throw Error("Cannot continue a run without an orchestrator");
		const project = getProject(cfg.project);
		const task = new TaskEnv(id, project);
		if (!fs.existsSync(task.repo)) throw Error(`Workspace for run ${id} is no longer present`);
		if (cfg.hookPending) throw Error(`Resolve pending ${cfg.hookPending} hook with resume first`);
		if (!cfg.prepared) throw Error("Run preparation is incomplete; resume it first");
		requireSession(id);
		if (!fs.existsSync(exitFile) || read(exitFile).trim() !== "0")
			throw Error(`Current turn did not finish successfully; use 'pistick resume ${id}'`);
		delete cfg.afterDone;
		delete cfg.agentDone;
		cfg.mode = "continue";
		cfg.prompt = promptText.trim();
		cfg.requestId = runId();
		if (keepUp !== undefined) cfg.keepUp = keepUp;
		// A new request must never inherit the previous turn's success marker.
		fs.unlinkSync(exitFile);
		writeJson(cfgFile, cfg);
		await spawnWorker(id, fd);
	} finally {
		fs.closeSync(fd);
	}
	console.log(`Continuing: ${id}\nFollow: pistick follow ${id}`);
	return id;
}

export async function worker(id: string): Promise<number> {
	const dir = runDir(id);
	const fifo = join(dir, "kill.fifo");
	const inherited = fs.fstatSync(4);
	const control = fs.statSync(fifo);
	const group = read("/proc/self/stat").split(") ").at(-1)?.split(" ")[2];
	if (
		Number(group) !== process.pid ||
		!inherited.isFIFO() ||
		inherited.ino !== control.ino ||
		inherited.dev !== control.dev
	)
		throw Error("Invalid worker control channel");
	// A synchronous host hook can block Node's event loop. This reader can still kill its own detached group.
	const reader = fs.openSync(fifo, "r");
	try {
		const guard = spawn("/bin/sh", ["-c", 'if read -r cmd && [ "$cmd" = kill ]; then kill -KILL 0; fi'], {
			stdio: [reader, "ignore", "inherit"],
		});
		await once(guard, "spawn");
		guard.unref();
	} finally {
		fs.closeSync(reader);
	}
	const cfgFile = join(dir, "run-config.json");
	const cfg = json(cfgFile) as RunConfig;
	const meta = readMeta(id);
	const project = getProject(cfg.project);
	const action = readActionSnapshot(dir, cfg.actionDigest);
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
				task.up();
			}
		} else if (cfg.prepared) {
			status(dir, `Resuming run on ${project.name}…`);
			if (!fs.existsSync(task.composeFile)) task.materializeCompose();
			services = task.services();
			stackStartAttempted = true;
			task.up();
		} else {
			status(dir, `Preparing isolated workspace for ${project.name}…`);
			if (!cfg.prepareDone && !cfg.hookPending) {
				if (cfg.prepareDone === undefined && fs.existsSync(task.workspace))
					throw Error("Cannot safely repeat checkout preparation for this legacy run; start a new run");
				meta.baseHead = task.prepareWorkspace(cfg.ref).baseHead;
				writeMeta(id, meta);
			}

			if (action.hooks.prepare && !cfg.prepareDone) {
				cfg.hookPending = "prepare";
				writeJson(cfgFile, cfg);
				status(dir, "Running prepare hook…");
				runHook("prepare", action.hooks.prepare, {
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
				meta.baseHead = task.inspectGit("rev-parse", "HEAD").trim();
				writeMeta(id, meta);
				delete cfg.hookPending;
			}
			if (!cfg.prepareDone) {
				cfg.prepareDone = true;
				writeJson(cfgFile, cfg);
			}

			status(dir, "Starting project Compose stack…");
			const mat = task.materializeCompose();
			services = mat.services;
			stackStartAttempted = true;
			task.up();
			cfg.setupPending = true;
			writeJson(cfgFile, cfg);
			task.setup();
			cfg.setupPending = false;
			cfg.prepared = true;
			writeJson(cfgFile, cfg);
		}

		const reportFile = join(dir, "report.md");
		const outputsDir = join(dir, "outputs");
		const patchFile = join(dir, "changes.patch");
		if (!cfg.agentDone) {
			const contextFiles = fs.existsSync(task.context) ? fs.readdirSync(task.context).sort() : [];
			const modelSpecs = Object.values(action.agents).map((a) => a.model);
			if (action.orchestrator) modelSpecs.unshift(action.orchestrator.model);
			const auth = await resolveModels(modelSpecs);

			meta.status = "running";
			meta.keepUp = cfg.keepUp;
			writeMeta(id, meta);
			const reporter = action.orchestrator ?? action.agents[action.stages.at(-1)!.parallel[0]];
			status(dir, `Starting action '${action.name}' (${reporter.model})…`);

			const payload = (spec: ResolvedAgentSpec) => {
				const { provider, modelId } = parseModelSpec(spec.model);
				return {
					name: spec.name,
					description: spec.description,
					model: { provider, modelId },
					instructions: composeInstructions(
						spec,
						project,
						action.projectNotes,
						services,
						contextFiles,
						spec === action.orchestrator ? action.agents : undefined,
					),
					mode: spec.mode,
					tools: spec.tools,
					thinkingLevel: spec.thinkingLevel,
					maxTurns: spec.maxTurns,
				};
			};

			const jobPayload: Record<string, unknown> = {
				id,
				models: auth.models,
				credentials: auth.credentials,
				orchestrator: action.orchestrator && payload(action.orchestrator),
				agents: Object.fromEntries(Object.entries(action.agents).map(([name, spec]) => [name, payload(spec)])),
				stageContext: action.stageContext,
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
				async (provider) => {
					const spec = modelSpecs.find((s) => parseModelSpec(s).provider === provider);
					if (typeof provider !== "string" || !spec || auth.credentials[provider].authType === "api_key")
						throw Error("OAuth refresh not permitted");
					return JSON.stringify(await exportAccessLease(spec));
				},
				(usage) => {
					meta.usage = usage;
					writeMeta(id, meta);
				},
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
			status(dir, result.report, action.orchestrator ? "orchestrator" : `agent:${reporter.name}`);
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
			runHook("after", action.hooks.after, {
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

function isUsageSnapshot(value: unknown): value is UsageState {
	const record = (v: unknown): v is Record<string, unknown> =>
		v !== null && typeof v === "object" && !Array.isArray(v);
	const amount = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
	if (!record(value) || Object.keys(value).length !== 2 || !record(value.models) || !record(value.tools)) return false;
	const common = ["input", "output", "cacheRead", "cacheWrite"];
	const tokens = [...common, "totalTokens"];
	const costs = [...common, "total"];
	return [value.models, value.tools].every((bucket) =>
		Object.values(bucket).every((entry) => {
			if (!record(entry) || !record(entry.cost)) return false;
			const cost = entry.cost;
			return (
				tokens.every((k) => amount(entry[k])) &&
				Object.entries(entry).every(
					([k, v]) =>
						k === "cost" || tokens.includes(k) || ((k === "cacheWrite1h" || k === "reasoning") && amount(v)),
				) &&
				costs.every((k) => amount(cost[k])) &&
				Object.entries(cost).every(([k, v]) =>
					k === "totalFromProvider" ? typeof v === "boolean" : costs.includes(k),
				)
			);
		}),
	);
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
	refreshToken: (provider: unknown) => Promise<string>,
	onUsage: (usage: UsageState) => void,
): Promise<AgentRunResult> {
	const argv = ephemeralArgs({
		runId: task.id,
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
	const commands = new Map<number, AbortController>();
	let report: string | undefined;
	let outputs: Record<string, string> | undefined;
	let rpcCount = 0;

	try {
		await send(jobPayload);
		for await (const line of lines) {
			const msg = JSON.parse(line);
			if (typeof msg.cancelRpc === "number") {
				commands.get(msg.cancelRpc)?.abort();
				continue;
			}
			if (typeof msg.progress === "string") {
				onProgress(msg.progress, typeof msg.agent === "string" ? msg.agent : undefined);
				continue;
			}
			if (typeof msg.report === "string" || Object.hasOwn(msg, "usage")) {
				if (Object.hasOwn(msg, "usage")) {
					if (!isUsageSnapshot(msg.usage)) throw Error("Invalid agent usage snapshot");
					onUsage(msg.usage);
				}
				report = typeof msg.report === "string" ? msg.report : undefined;
				if (msg.outputs && typeof msg.outputs === "object") outputs = msg.outputs as Record<string, string>;
				break;
			}
			if (typeof msg.rpc === "number" && typeof msg.method === "string") {
				if (++rpcCount > 500) throw Error("RPC call limit exceeded");
				const rpcId = msg.rpc as number;
				const method = msg.method as string;
				if (commands.has(rpcId)) throw Error("Duplicate RPC id");
				const controller = method === "exec" ? new AbortController() : undefined;
				if (controller) commands.set(rpcId, controller);
				const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
				const agentName = typeof msg.agent === "string" ? msg.agent : undefined;
				const work = (async () => {
					let result: { text: string; error?: boolean };
					try {
						result =
							method === "refresh_token" && !agentName
								? { text: await refreshToken(params.provider) }
								: await task.handleRpc(
										method,
										params,
										resolvePolicy(agentName),
										(chunk) => send({ rpc: rpcId, chunk: chunk.toString("base64") }),
										controller?.signal,
									);
					} catch (err) {
						result = {
							text: err instanceof Error ? err.message : "RPC operation failed",
							error: true,
						};
					}
					commands.delete(rpcId);
					await send({ rpc: rpcId, result });
				})();
				inflight.add(work);
				work.then(
					() => inflight.delete(work),
					() => inflight.delete(work),
				);
				continue;
			}
			throw Error("Unexpected message from agent container");
		}
		for (const controller of commands.values()) controller.abort();
		await Promise.allSettled(inflight);
		await writeQueue;
		child.stdin.end();
		const [code] = await exit;
		if (code !== 0 || !report?.trim()) throw Error("Agent container failed to return a report");
		return { report, outputs };
	} finally {
		for (const controller of commands.values()) controller.abort();
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

// Caller holds the run lock; remove by immutable container ID, never by a reusable name.
function removeOrphanAgent(id: string) {
	const lookup = () =>
		output([
			"docker",
			"ps",
			"-a",
			"--no-trunc",
			"--filter",
			`name=^/${agentName(id)}$`,
			"--format",
			'{{.ID}} {{.Label "pi-stick.run"}}',
		]);
	const found = lookup();
	if (!found) return;
	const [container, owner] = found.split(" ");
	if (!/^[0-9a-f]{64}$/.test(container) || owner !== id)
		throw Error(`Cannot verify ownership of ${agentName(id)}; refusing to remove it`);
	try {
		run(["docker", "rm", "-f", container]);
	} catch (err) {
		// --rm may have already removed the agent after its stdin closed.
		if (lookup()) throw err;
		return;
	}
	if (lookup()) throw Error(`Agent container for run ${id} still exists`);
}

export async function killRun(id: string) {
	const meta = readMeta(id);
	const dir = runDir(id);
	const fifo = join(dir, "kill.fifo");
	const lock = fs.openSync(runLock(id), "r+");
	try {
		if (tryLock(lock)) throw Error(`Run ${id} is not active`);
		const { O_WRONLY, O_NONBLOCK, O_NOFOLLOW } = fs.constants;
		const pipe = fs.openSync(fifo, O_WRONLY | O_NONBLOCK | O_NOFOLLOW);
		try {
			const attempt = fs.fstatSync(pipe);
			if (!attempt.isFIFO()) throw Error("Invalid worker control channel");
			fs.writeSync(pipe, "kill\n");
			const deadline = Date.now() + 10_000;
			while (!tryLock(lock)) {
				if (Date.now() >= deadline) throw Error("Worker did not release the run lock; inspect the run");
				await sleep(50);
			}
			const current = fs.statSync(fifo);
			if (attempt.dev !== current.dev || attempt.ino !== current.ino || fs.existsSync(join(dir, "exit")))
				throw Error("Run attempt already ended; not stopping its containers");
			removeOrphanAgent(id);
			new TaskEnv(id, getProject(meta.project)).stop();
			status(dir, "Killed by operator; workspace and session retained.");
			console.log(`Killed run ${id}.`);
		} finally {
			fs.closeSync(pipe);
		}
	} finally {
		fs.closeSync(lock);
	}
}

export function stopRun(id: string) {
	const meta = readMeta(id);
	const fd = fs.openSync(runLock(id), "a");
	try {
		if (!tryLock(fd)) throw Error(`Run ${id} is currently active; wait for it to finish before stopping`);
		removeOrphanAgent(id);
		const task = new TaskEnv(id, getProject(meta.project));
		task.stop();
		touch(join(task.dir, "last-used"));
	} finally {
		fs.closeSync(fd);
	}
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
	function eligibleLastUsed(dir: string) {
		if (!fs.existsSync(join(dir, "exit"))) return;
		const last = fs.statSync(join(dir, "last-used"), { throwIfNoEntry: false });
		return last?.isFile() && last.mtimeMs <= cutoff ? last.mtimeMs : undefined;
	}
	const items: Array<{ id: string; key: string; lastUsed: number }> = [];
	for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
		const id = entry.name;
		if (!entry.isDirectory() || !VALID_ID.test(id)) continue;
		const dir = join(runsDir, id);
		if (isLocked(join(dir, "lock"))) continue;
		const lastUsed = eligibleLastUsed(dir);
		if (lastUsed === undefined) continue;
		const metaFile = join(dir, "meta.json");
		const project = fs.existsSync(metaFile) ? (json(metaFile) as Partial<RunMeta>).project : undefined;
		const key = project ? `pi-stick-${project}-${id.slice(0, 12)}` : `pi-stick-run-${id.slice(0, 12)}`;
		items.push({ id, key, lastUsed });
		console.log(`${id} (${project ?? "unknown"}): workspace, scratch stack/volumes, reports and session`);
	}
	if (!items.length) {
		console.log("No eligible pi-stick runs.");
		return;
	}
	if (dry || (await prompt("Permanently delete listed pi-stick runs? [y/N] ")).toLowerCase() !== "y") return;
	for (const { id, key, lastUsed } of items) {
		const dir = runDir(id);
		let fd: number;
		try {
			fd = fs.openSync(runLock(id), "a");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw err;
		}
		try {
			if (!tryLock(fd) || eligibleLastUsed(dir) !== lastUsed) {
				console.log(`Skipping ${id}: active or changed since listing.`);
				continue;
			}
			const compose = join(dir, "compose.yaml");
			if (fs.existsSync(compose)) run(["docker", "compose", "-p", key, "-f", compose, "down", "--volumes"]);
			// Retire the run ID before recursive removal can unlink its lock file.
			const retired = join(runsDir, `.deleting-${id}`);
			fs.renameSync(dir, retired);
			fs.rmSync(retired, { recursive: true });
		} finally {
			fs.closeSync(fd);
		}
	}
}
