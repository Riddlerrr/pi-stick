import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { type ActionJob, RUN, RunFailure } from "../runtime-tools/protocol.ts";
import { readActionSnapshot, saveActionSnapshot } from "./action-snapshot.ts";
import { type LoadedAction, loadAction, type ResolvedAgentSpec, resolveInputs, runHook } from "./actions.ts";
import { executeAgentContainer } from "./agent-rpc.ts";
import { agentName } from "./container.ts";
import {
	command,
	compiled,
	devMode,
	isLocked,
	output,
	prompt,
	read,
	run,
	runId,
	STATE,
	touch,
	tryLock,
} from "./platform.ts";
import { needsSession, type Phase, pendingEffect, readState, saveState, tryReadState } from "./run-state.ts";
import { exportAccessLease, parseModelSpec, resolveModels } from "./system.ts";
import { CONTAINER_REPO_DIR, type RpcPolicy, TaskEnv } from "./tasks.ts";
import { getProject, type ProjectInfo } from "./workspace.ts";

export const VALID_ID = /^[0-9a-f]{32}$/;

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

async function spawnWorker(id: string, fd: number, freshContinue = false) {
	const dir = runDir(id);
	touch(join(dir, "last-used"));
	const fifo = join(dir, "kill.fifo");
	fs.rmSync(fifo, { force: true });
	command(["mkfifo", "-m", "600", fifo]);
	const control = fs.openSync(fifo, fs.constants.O_RDWR);
	const log = fs.openSync(join(dir, "worker.log"), "a");
	try {
		const args = ["_worker", id];
		if (freshContinue) args.push("--continue");
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
	if (!fs.statSync(project.repo, { throwIfNoEntry: false })?.isDirectory())
		throw Error(`Project repository not found at ${project.repo}`);
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
		saveState(task.dir, {
			version: 1,
			id,
			project: project.name,
			action: action.name,
			ref: opts.ref,
			createdAt: now,
			updatedAt: now,
			inputs,
			prompt: buildInitialPrompt(action, opts.promptText, inputs),
			keepUp: opts.keepUp,
			requestId: id,
			mode: "run",
			phase: "checkout",
			actionDigest,
		});
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
	if (!fs.existsSync(dir)) throw Error(`Unknown run: ${id}`);
	const fd = fs.openSync(runLock(id), "a");
	try {
		if (!tryLock(fd)) throw Error(`Run ${id} is currently active; use 'pistick follow ${id}'`);
		const cfg = readState(dir);
		if (cfg.exitCode === 0) throw Error("Run already completed; use 'pistick continue' for follow-up instructions");
		readActionSnapshot(dir, cfg.actionDigest);
		if (needsSession(cfg)) requireSession(id);
		const effect = pendingEffect(cfg.phase);
		if (effect && !retryHook)
			throw Error(`Outcome of ${effect} unknown; verify its side effects before using resume --retry-hook`);
		if (cfg.phase === "agent-started") removeOrphanAgent(id);
		delete cfg.exitCode;
		saveState(dir, cfg);
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
	if (!fs.existsSync(dir)) throw Error(`Unknown run: ${id}`);
	const fd = fs.openSync(runLock(id), "a");
	try {
		if (!tryLock(fd)) throw Error(`Run ${id} is currently active; wait for it to finish first`);
		const cfg = readState(dir);
		if (!readActionSnapshot(dir, cfg.actionDigest).orchestrator)
			throw Error("Cannot continue a run without an orchestrator");
		const project = getProject(cfg.project);
		const task = new TaskEnv(id, project);
		if (!fs.existsSync(task.repo)) throw Error(`Workspace for run ${id} is no longer present`);
		requireSession(id);
		if (cfg.exitCode !== 0) throw Error(`Current turn did not finish successfully; use 'pistick resume ${id}'`);
		cfg.phase = "agent";
		delete cfg.exitCode;
		cfg.mode = "continue";
		cfg.prompt = promptText.trim();
		cfg.requestId = runId();
		if (keepUp !== undefined) cfg.keepUp = keepUp;
		saveState(dir, cfg);
		await spawnWorker(id, fd, true);
	} finally {
		fs.closeSync(fd);
	}
	console.log(`Continuing: ${id}\nFollow: pistick follow ${id}`);
	return id;
}

export async function worker(id: string, freshContinue: boolean): Promise<number> {
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
	const cfg = readState(dir);
	const advance = (phase: Phase) => {
		cfg.phase = phase;
		saveState(dir, cfg);
	};
	const project = getProject(cfg.project);
	const action = readActionSnapshot(dir, cfg.actionDigest);
	const task = new TaskEnv(id, project);
	let code = 1;
	let stackStartAttempted = false;

	try {
		if (cfg.phase === "checkout") {
			status(dir, `Preparing isolated workspace for ${project.name}…`);
			cfg.baseHead = task.prepareWorkspace(cfg.ref).baseHead;
			advance("prepare");
		}
		if (cfg.phase === "prepare" || cfg.phase === "preparing-hook") {
			if (action.hooks.prepare) {
				advance("preparing-hook");
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
					baseHead: cfg.baseHead,
					prompt: cfg.prompt,
					inputs: cfg.inputs,
				});
				cfg.baseHead = task.inspectGit("rev-parse", "HEAD").trim();
			}
			advance("setup");
		}
		let services: string[] = [];
		if (cfg.phase !== "stop") {
			if (cfg.phase === "setup" || !fs.existsSync(task.composeFile)) task.materializeCompose();
			services = task.services();
			stackStartAttempted = true;
			if (cfg.phase === "setup" || cfg.phase === "setting-up") task.up();
			else {
				try {
					task.start();
				} catch (err) {
					if (!freshContinue) throw err;
					task.up();
				}
			}
		}
		if (cfg.phase === "setup" || cfg.phase === "setting-up") {
			advance("setting-up");
			task.setup();
			advance("agent");
		}

		const reportFile = join(dir, "report.md");
		const outputsDir = join(dir, "outputs");
		const patchFile = join(dir, "changes.patch");
		if (cfg.phase === "agent" || cfg.phase === "agent-started") {
			const contextFiles = fs.existsSync(task.context) ? fs.readdirSync(task.context).sort() : [];
			const modelSpecs = Object.values(action.agents).map((a) => a.model);
			if (action.orchestrator) modelSpecs.unshift(action.orchestrator.model);
			const auth = await resolveModels(modelSpecs);

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

			const jobPayload = {
				type: RUN,
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
			} satisfies ActionJob;

			if (needsSession(cfg)) requireSession(id);
			else fs.mkdirSync(join(dir, "session"), { recursive: true, mode: 0o700 });
			advance("agent-started");
			const result = await executeAgentContainer(
				task,
				jobPayload,
				(agentName) => policyForAgent(action, agentName),
				(line, agentName) => status(dir, line, agentName),
				(provider, signal) => {
					const spec = modelSpecs.find((s) => parseModelSpec(s).provider === provider);
					if (!spec || auth.credentials[provider].authType !== "oauth") throw Error("OAuth refresh not permitted");
					return exportAccessLease(spec, "oauth", signal);
				},
				(usage) => {
					cfg.usage = usage;
					saveState(dir, cfg);
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

			const { patchFile, untracked } = task.captureDiff(cfg.baseHead);
			status(dir, result.report, action.orchestrator ? "orchestrator" : `agent:${reporter.name}`);
			status(dir, `Wrote: ${reportFile}`);
			if (patchFile) status(dir, `Patch: ${patchFile}`);
			if (untracked.length) status(dir, `Untracked files: ${untracked.length}`);

			advance(action.hooks.after ? "after" : "stop");
		}

		if (cfg.phase === "after" || cfg.phase === "after-hook") {
			if (!action.hooks.after) throw Error("Missing after hook");
			advance("after-hook");
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
				baseHead: cfg.baseHead,
				prompt: cfg.prompt,
				inputs: cfg.inputs,
				exitCode: 0,
				reportFile,
				patchFile: fs.existsSync(patchFile) ? patchFile : undefined,
				outputsDir: fs.existsSync(outputsDir) ? outputsDir : undefined,
			});
			advance("stop");
		}
		code = 0;
	} catch (err) {
		const summary = err instanceof RunFailure ? `Failed: ${err.message}` : "Failed";
		status(dir, `${summary}; see private log: ${join(dir, "worker.log")}`);
		console.error(err);
	} finally {
		if ((stackStartAttempted || cfg.phase === "stop") && !cfg.keepUp) {
			try {
				task.stop();
			} catch (err) {
				code = 1;
				status(dir, `Failed to stop project stack; see private log: ${join(dir, "worker.log")}`);
				console.error("Failed to stop project stack:", err);
			}
		}
		touch(join(dir, "last-used"));
		cfg.exitCode = code === 0 ? 0 : 1;
		saveState(dir, cfg);
	}
	return code;
}

export async function follow(id: string) {
	const dir = runDir(id);

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
			const { exitCode } = readState(dir);
			if (exitCode !== undefined) {
				await drain();
				return exitCode;
			}
			const fd = fs.openSync(lockPath, "a");
			try {
				if (tryLock(fd) && readState(dir).exitCode === undefined)
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
		const meta = tryReadState(dir);
		const state = active
			? "running"
			: !meta
				? "unsupported"
				: meta.exitCode === 0
					? "done"
					: meta.exitCode === 1
						? "failed"
						: "interrupted";
		if (!all && state !== "running") continue;
		rows.push({
			id,
			state,
			project: meta?.project ?? "-",
			action: meta?.action ?? "-",
			updatedAt: meta?.updatedAt ?? "-",
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
	const meta = readState(runDir(id));
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
			if (attempt.dev !== current.dev || attempt.ino !== current.ino || readState(dir).exitCode !== undefined)
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
	const meta = readState(runDir(id));
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

export async function diffRun(id: string) {
	const meta = readState(runDir(id));
	const task = new TaskEnv(id, getProject(meta.project));
	const saved = join(task.dir, "changes.patch");
	const { patchFile, untracked } = fs.existsSync(task.repo)
		? task.captureDiff(meta.baseHead)
		: { patchFile: fs.existsSync(saved) ? saved : undefined, untracked: [] };
	if (patchFile) await pipeline(fs.createReadStream(patchFile), process.stdout, { end: false });
	if (untracked.length) {
		console.log(`\nUntracked files:\n${untracked.map((f) => `  ${f}`).join("\n")}`);
	}
	if (!patchFile && !untracked.length) console.log("No changes.");
}

export async function cleanup(days: number, dry: boolean) {
	const runsDir = join(STATE, "runs");
	const cutoff = Date.now() - days * 86400000;
	if (!fs.existsSync(runsDir)) {
		console.log("No eligible pi-stick runs.");
		return;
	}
	const isInterrupted = (dir: string) => readState(dir).exitCode === undefined;
	function eligibleLastUsed(dir: string, interrupted: boolean) {
		const last =
			fs.statSync(join(dir, "last-used"), { throwIfNoEntry: false }) ??
			(interrupted ? fs.statSync(join(dir, "run.json"), { throwIfNoEntry: false }) : undefined);
		return last?.isFile() && last.mtimeMs <= cutoff ? last.mtimeMs : undefined;
	}
	const items: Array<{ id: string; key: string; lastUsed: number; interrupted: boolean }> = [];
	for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
		const id = entry.name;
		if (!entry.isDirectory() || !VALID_ID.test(id)) continue;
		const dir = join(runsDir, id);
		if (isLocked(join(dir, "lock"))) continue;
		const state = tryReadState(dir);
		if (!state) {
			console.log(`Skipping ${id}: unsupported or unreadable checkpoint.`);
			continue;
		}
		const interrupted = state.exitCode === undefined;
		const lastUsed = eligibleLastUsed(dir, interrupted);
		if (lastUsed === undefined) continue;
		const project = state.project;
		const key = `pi-stick-${project}-${id.slice(0, 12)}`;
		items.push({ id, key, lastUsed, interrupted });
		console.log(
			`${id} (${project ?? "unknown"}${interrupted ? ", interrupted" : ""}): workspace, scratch stack/volumes, reports and session`,
		);
	}
	if (!items.length) {
		console.log("No eligible pi-stick runs.");
		return;
	}
	if (dry || (await prompt("Permanently delete listed pi-stick runs? [y/N] ")).toLowerCase() !== "y") return;
	for (const { id, key, lastUsed, interrupted } of items) {
		const dir = runDir(id);
		let fd: number;
		try {
			fd = fs.openSync(runLock(id), "a");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw err;
		}
		try {
			if (!tryLock(fd) || isInterrupted(dir) !== interrupted || eligibleLastUsed(dir, interrupted) !== lastUsed) {
				console.log(`Skipping ${id}: active or changed since listing.`);
				continue;
			}
			removeOrphanAgent(id);
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
