// biome-ignore assist/source/organizeImports: Reserve stdout before dependencies run their initialization code.
import { writeProtocol } from "./runtime-tools/protocol-stdout.ts";

import * as fs from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";

import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
	AssistantEntry,
	type ConversationId,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	GenerationTask,
	Harness,
	hook,
	ROOT_CONVERSATION_ID,
	type TaskId,
	type ToolRegistration,
	ToolTask,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import {
	type Job,
	type AgentRuntimeSpec,
	type Method,
	type RpcCall,
	type RpcData,
	type RuntimeMessage,
	RunFailure,
	readJob,
	readReply,
} from "./runtime-tools/protocol.ts";
import { runtimeCredentials } from "./runtime-auth.ts";
import { createBashTool } from "./runtime-tools/bash.ts";
import { type BatchResult, createDelegateTool, type DelegateTasks } from "./runtime-tools/delegate.ts";
import { createEditTool } from "./runtime-tools/edit.ts";
import { createFindTool } from "./runtime-tools/find.ts";
import { createGrepTool } from "./runtime-tools/grep.ts";
import { createLogsTool } from "./runtime-tools/logs.ts";
import { createPsTool } from "./runtime-tools/ps.ts";
import { createReadTool } from "./runtime-tools/read.ts";
import { createRestartTool } from "./runtime-tools/restart.ts";
import type { AgentRpc } from "./runtime-tools/rpc.ts";
import { createWriteTool } from "./runtime-tools/write.ts";

const SESSIONS_DIR = process.env.PI_STICK_SESSIONS_DIR ?? "/sessions";
const CONTAINER_REPO_DIR = "/workspace/repo";
const WORKSPACE_DIR = process.env.PI_STICK_WORKSPACE_DIR ?? CONTAINER_REPO_DIR;
const SCRATCH_DIR = process.env.PI_STICK_SCRATCH_DIR ?? "/scratch";
const CONTEXT_DIR = process.env.PI_STICK_CONTEXT_DIR ?? "/context";

interface AgentContext {
	name: string;
	label: string;
	mode: "read-only" | "read-write";
	scratchDir: string;
}

const protocol = new AbortController();
const ctx = withAbortSignal(protocol.signal, BACKGROUND_CONTEXT);
const send = (data: RuntimeMessage) => {
	if (protocol.signal.aborted) return;
	writeProtocol(`${JSON.stringify(data)}\n`);
};

const rl = createInterface({ input: process.stdin });
const pendingRpc = new Map<
	string,
	{
		command: Method;
		resolve: (res: RpcData) => void;
		reject: (err: Error) => void;
		onChunk?: (chunk: Buffer) => void;
	}
>();
let rpcSeq = 0;

function readInitialJob(): Promise<Job> {
	return new Promise((resolve, reject) => {
		let gotFirst = false;
		rl.on("line", (line) => {
			if (!gotFirst) {
				gotFirst = true;
				try {
					resolve(readJob(line));
				} catch (err) {
					reject(err);
				}
				return;
			}
			if (protocol.signal.aborted) return;
			let reply: ReturnType<typeof readReply>;
			try {
				reply = readReply(line, pendingRpc);
			} catch (err) {
				protocol.abort(err);
				rl.close();
				return;
			}
			const pending = pendingRpc.get(reply.id)!;
			if (reply.type === "exec_chunk") {
				try {
					pending.onChunk?.(Buffer.from(reply.chunk, "base64"));
				} catch (err) {
					send({ type: "cancel_exec", id: reply.id });
					pending.reject(err as Error);
					pending.onChunk = undefined;
				}
				return;
			}
			pendingRpc.delete(reply.id);
			pending.resolve(reply.success ? reply.data : { text: reply.error, error: true });
		});
		rl.on("close", () => {
			if (!gotFirst) reject(Error("Host launcher disconnected before job initialization"));
			for (const [id, pending] of pendingRpc) {
				pendingRpc.delete(id);
				pending.reject(protocol.signal.reason ?? Error("Host launcher disconnected"));
			}
		});
	});
}

async function callHostRpc(
	request: RpcCall,
	agent?: string,
	onChunk?: (chunk: Buffer) => void,
	signal?: AbortSignal,
): Promise<{ text: string; error?: boolean; exitCode?: number }> {
	protocol.signal.throwIfAborted();
	if (signal?.aborted) throw Error("Command aborted");
	const id = String(++rpcSeq);
	const cancel = () => send({ type: "cancel_exec", id: id });
	try {
		return await new Promise((resolve, reject) => {
			pendingRpc.set(id, { command: request.type, resolve, reject, onChunk });
			send({ ...request, agent, id });
			signal?.addEventListener("abort", cancel, { once: true });
		});
	} finally {
		signal?.removeEventListener("abort", cancel);
	}
}

function canonicalBase(dir: string): string {
	return fs.existsSync(dir) ? fs.realpathSync(dir) : resolve(dir);
}

function nearestExistingRealpath(target: string): string {
	let cur = target;
	const tail: string[] = [];
	while (!fs.existsSync(cur)) {
		const parent = dirname(cur);
		if (parent === cur) break;
		tail.unshift(cur.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
		cur = parent;
	}
	const real = fs.existsSync(cur) ? fs.realpathSync(cur) : cur;
	return tail.length ? join(real, ...tail) : real;
}

function assertWithin(target: string, root: string, label: string): string {
	const resolved = nearestExistingRealpath(target);
	const rel = relative(root, resolved);
	if (rel.startsWith("..") || isAbsolute(rel)) throw Error(`Path escapes allowed ${label} directory`);
	return resolved;
}

function resolveAgentPath(rawPath: string, agentCtx: AgentContext, forWrite: boolean): string {
	if (!rawPath || rawPath.includes("\0") || rawPath.length > 2048) throw Error("Invalid path");
	if (rawPath === "/context" || rawPath.startsWith("/context/")) {
		if (forWrite) throw Error("/context is read-only");
		const sub = rawPath === "/context" ? "" : rawPath.slice("/context/".length);
		return assertWithin(resolve(CONTEXT_DIR, sub), canonicalBase(CONTEXT_DIR), "context");
	}
	if (rawPath === "/scratch" || rawPath.startsWith("/scratch/")) {
		const sub = rawPath === "/scratch" ? "" : rawPath.slice("/scratch/".length);
		const candidate = resolve(SCRATCH_DIR, sub);
		if (forWrite) {
			fs.mkdirSync(agentCtx.scratchDir, { recursive: true });
			return assertWithin(
				candidate,
				canonicalBase(agentCtx.scratchDir),
				`agent scratch (/scratch/${agentCtx.name})`,
			);
		}
		return assertWithin(candidate, canonicalBase(SCRATCH_DIR), "scratch");
	}
	const prefix = `${CONTAINER_REPO_DIR}/`;
	const sub =
		rawPath === CONTAINER_REPO_DIR ? "" : rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : rawPath;
	if (isAbsolute(sub)) throw Error(`Absolute paths must be under ${CONTAINER_REPO_DIR}, /scratch, or /context`);
	if (forWrite && agentCtx.mode === "read-only") {
		throw Error(
			`Write/edit in ${CONTAINER_REPO_DIR} is disabled in read-only mode. Write temporary files under /scratch/${agentCtx.name} instead.`,
		);
	}
	return assertWithin(resolve(workspaceRoot, sub), workspaceRoot, "workspace");
}

// Docker forwards EOF when the worker dies, even during an outstanding model request.
const hostDisconnected = () => {
	if (!protocol.signal.aborted) process.exit(1);
};
process.stdin.once("end", hostDisconnected);
const job = await readInitialJob();
protocol.signal.throwIfAborted();

// Resolve only the mount parent so a replacement symlink cannot redefine the workspace boundary.
const workspaceRoot = join(canonicalBase(dirname(WORKSPACE_DIR)), basename(WORKSPACE_DIR));
if (!fs.lstatSync(workspaceRoot, { throwIfNoEntry: false })?.isDirectory())
	throw Error(`Expected a real checkout directory at ${WORKSPACE_DIR}`);

const allProviders = builtinProviders();
const models = createModels({
	credentials: runtimeCredentials(job.credentials, allProviders, async (provider) => {
		const result = await callHostRpc({ type: "refresh_token", provider });
		if (result.error) throw Error("Host could not renew OAuth token");
		return JSON.parse(result.text);
	}),
});
job.credentials = {};

for (const provider of allProviders) {
	const extra = job.models?.[provider.id];
	if (extra?.length) {
		const merged = [...provider.getModels()];
		for (const m of extra) {
			const idx = merged.findIndex((existing) => existing.id === m.id);
			if (idx >= 0) merged[idx] = m;
			else merged.push(m);
		}
		models.setProvider({
			...provider,
			getModels: () => merged,
			getAllModels: () => merged,
		});
	} else {
		models.setProvider(provider);
	}
}

for (const spec of [job.orchestrator, ...Object.values(job.agents ?? {})]) {
	if (!spec) continue;
	const model = models.getModel(spec.model.provider, spec.model.modelId);
	if (!model)
		throw Error(`Configured model unavailable for ${spec.name}: ${spec.model.provider}/${spec.model.modelId}`);
	if (spec.thinkingLevel !== undefined) {
		const supported = getSupportedThinkingLevels(model);
		if (!supported.includes(spec.thinkingLevel)) {
			const message = `${spec.name}: ${model.provider}/${model.id} does not support thinkingLevel "${spec.thinkingLevel}" (supported: ${supported.join(", ")})`;
			send({ type: "progress", message: message });
			throw Error(message);
		}
	}
}

const agentByConv = new Map<ConversationId, AgentContext>();
const defaultAgentCtx: AgentContext = {
	name: "orchestrator",
	label: "orchestrator",
	mode: job.orchestrator?.mode ?? "read-write",
	scratchDir: join(SCRATCH_DIR, "orchestrator"),
};
agentByConv.set(ROOT_CONVERSATION_ID, defaultAgentCtx);

function getAgentCtx(conversationId: ConversationId): AgentContext {
	return agentByConv.get(conversationId) ?? defaultAgentCtx;
}

const probeEvents: string[] = [];
const emitProgress = (line: string, label?: string) => {
	if (job.check) probeEvents.push(label ? `[${label}] ${line}` : line);
	else send({ type: "progress", message: line, ...(label ? { agent: label } : {}) });
};

const stageProgressLabel = job.check || job.orchestrator ? "orchestrator" : undefined;
const activeSubagents: Record<string, AgentRuntimeSpec> = { ...(job.agents ?? {}) };
const agentOutputs: Record<string, string> = {};

const workflow = defineDoc<{
	slots: Record<string, ConversationId>;
	agents: Record<string, { name: string; mode: "read-only" | "read-write" }>;
	stages: Record<string, BatchResult>;
}>({
	kind: "pi-stick.workflow",
	version: 1,
	scope: "session",
	initial: () => ({ slots: {}, agents: {}, stages: {} }),
	checkpointWhen: () => false,
});

function recordAgentOutput(agentName: string, text: string) {
	if (agentOutputs[agentName]) agentOutputs[agentName] = `${agentOutputs[agentName]}\n\n---\n\n${text}`;
	else agentOutputs[agentName] = text;
}

async function runSubagent(
	spec: AgentRuntimeSpec,
	promptText: string,
	slot?: string,
	ownerTaskId?: TaskId,
	requireReport = false,
): Promise<{ agent: string; ok: boolean; output: string }> {
	const scratchDir = join(SCRATCH_DIR, spec.name);
	fs.mkdirSync(scratchDir, { recursive: true });
	const subTools = spec.tools.filter((t) => t !== "delegate");
	const { extensions, tools } = selectToolsAndExtensions(subTools);
	const existing = slot && (await h.snapshot(workflow, ctx))?.slots[slot];
	const conv = existing
		? await h.conversation(existing, ctx)
		: await h.createConversation(
				{
					ownership: ownerTaskId === undefined ? { kind: "ownerless" } : { kind: "task", taskId: ownerTaskId },
					init: async (tx, id) => {
						const state = await tx.doc(workflow);
						state.agents[id] = { name: spec.name, mode: spec.mode };
						if (slot) state.slots[slot] = id;
					},
					agent: {
						model: spec.model,
						instructions: spec.instructions,
						extensions,
						tools,
						// Clear the owner’s setting for delegated agents without an explicit level.
						thinkingLevel: spec.thinkingLevel ?? null,
						maxTurns: spec.maxTurns ?? null,
					},
				},
				ctx,
			);
	if (!conv) throw Error(`Missing stage conversation: ${existing}`);
	const label = `agent:${spec.name}`;
	agentByConv.set(conv.id, {
		name: spec.name,
		label,
		mode: spec.mode,
		scratchDir,
	});
	emitProgress("started", label);
	try {
		const sub = await conv.submit({ type: "input", content: promptText, ...(slot ? { requestId: slot } : {}) }, ctx);
		const settled = await sub.wait(ctx);
		if (settled.status !== "done" || settled.type !== "input") {
			const msg = `Subagent '${spec.name}' did not complete (${settled.status}${settled.reason ? `: ${settled.reason}` : ""})`;
			emitProgress(msg, label);
			return { agent: spec.name, ok: false, output: msg };
		}
		const entry = await conv.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
		const message = entry?.model?.[0];
		if (message?.role !== "assistant") {
			const msg = `Subagent '${spec.name}' returned no assistant answer`;
			emitProgress(msg, label);
			return { agent: spec.name, ok: false, output: msg };
		}
		const text = message.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
		if (requireReport && !text) {
			const msg = `Final agent ${spec.name} returned an empty report`;
			emitProgress(msg, label);
			return { agent: spec.name, ok: false, output: msg };
		}
		const final = text || "(empty output)";
		recordAgentOutput(spec.name, final);
		emitProgress("completed", label);
		return { agent: spec.name, ok: true, output: final };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		emitProgress(`error: ${msg}`, label);
		if (slot) throw err; // Unknown submission outcome: resume the same slot.
		return { agent: spec.name, ok: false, output: `Error: ${msg}` };
	}
}

async function runParallelBatch(
	batch: Array<{ spec: AgentRuntimeSpec; prompt: string; requireReport?: boolean }>,
	batchLabel: string,
	recovery: { stageKey: string } | { taskId: TaskId },
): Promise<BatchResult> {
	const names = new Set<string>();
	for (const { spec } of batch) {
		if (names.has(spec.name)) throw Error(`Batch '${batchLabel}' repeats agent '${spec.name}'`);
		names.add(spec.name);
	}
	const stageKey = "stageKey" in recovery ? recovery.stageKey : undefined;
	const owner = "taskId" in recovery ? recovery.taskId : undefined;
	const cached = stageKey ? (await h.snapshot(workflow, ctx))?.stages[stageKey] : undefined;
	if (cached?.results.every((r) => r.ok)) {
		for (const r of cached.results) recordAgentOutput(r.agent, r.output);
		emitProgress(`Restored completed ${batchLabel}`, stageProgressLabel);
		return cached;
	}
	if (stageKey && cached) {
		// A settled failure needs a new conversation; successful siblings keep their durable submissions.
		await h.commit(async (tx) => {
			const state = await tx.doc(workflow);
			for (const [i, r] of cached.results.entries()) if (!r.ok) delete state.slots[`${stageKey}:${i}:${r.agent}`];
			delete state.stages[stageKey];
		}, ctx);
	}
	const rwCount = batch.filter((b) => b.spec.mode === "read-write").length;
	if (rwCount > 1) {
		throw Error(
			`Cannot run ${rwCount} read-write subagents in parallel in '${batchLabel}'; run read-write subagents sequentially or use read-only subagents for parallel execution.`,
		);
	}
	const allReadOnly = batch.every((b) => b.spec.mode === "read-only");
	let cleanlinessWarning: string | undefined;
	const trackedStatus = async () => {
		const res = await callHostRpc({ type: "check_clean" });
		if (!res.error) return res.text;
		cleanlinessWarning = `WARNING: Could not verify tracked files in read-only round '${batchLabel}': ${res.text}`;
		emitProgress(cleanlinessWarning, stageProgressLabel);
		return undefined;
	};
	const beforeClean = allReadOnly ? await trackedStatus() : undefined;
	const results = await Promise.all(
		batch.map((item, i) =>
			runSubagent(
				item.spec,
				item.prompt,
				stageKey && `${stageKey}:${i}:${item.spec.name}`,
				owner,
				item.requireReport,
			),
		),
	);
	if (beforeClean !== undefined) {
		const after = await trackedStatus();
		if (after !== undefined && after !== beforeClean) {
			cleanlinessWarning = `WARNING: Tracked repository files changed during read-only round '${batchLabel}':\n${after.trim()}`;
			emitProgress(cleanlinessWarning, stageProgressLabel);
		}
	}
	const result = { results, ...(cleanlinessWarning ? { cleanlinessWarning } : {}) };
	if (stageKey)
		await h.commit(async (tx) => {
			(await tx.doc(workflow)).stages[stageKey] = result;
		}, ctx);
	return result;
}

// An abandoned batch is marked before recovery dispatches any of its owned conversations.
const delegateBatch = defineTask<DelegateTasks, { phase: "run" }, BatchResult>({
	name: "pi-stick.delegate-batch",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, context) => {
			const batch = task.input.map(({ agent, prompt }) => {
				const spec = activeSubagents[agent];
				if (!spec)
					throw Error(
						`Unknown subagent '${agent}'. Available: ${Object.keys(activeSubagents).join(", ") || "(none)"}`,
					);
				return { spec, prompt };
			});
			const result = await runParallelBatch(batch, "delegate", { taskId: runtime.taskId });
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

const agentRpc: AgentRpc = (request, id) => callHostRpc(request, getAgentCtx(id).name);

const toolMap = new Map<string, ToolRegistration>([
	["read", createReadTool(CONTAINER_REPO_DIR, (path, id) => resolveAgentPath(path, getAgentCtx(id), false))],
	["write", createWriteTool((path, id) => resolveAgentPath(path, getAgentCtx(id), true))],
	["edit", createEditTool((path, id) => resolveAgentPath(path, getAgentCtx(id), true))],
	["grep", createGrepTool(CONTAINER_REPO_DIR, (path, id) => resolveAgentPath(path, getAgentCtx(id), false))],
	["find", createFindTool(CONTAINER_REPO_DIR, (path, id) => resolveAgentPath(path, getAgentCtx(id), false))],
	[
		"bash",
		createBashTool(
			(args, id, onChunk, signal) => callHostRpc({ ...args, type: "exec" }, getAgentCtx(id).name, onChunk, signal),
			(id) => resolveAgentPath(`/scratch/${getAgentCtx(id).name}`, getAgentCtx(id), true),
		),
	],
	["logs", createLogsTool(agentRpc)],
	["ps", createPsTool(agentRpc)],
	["restart", createRestartTool(agentRpc)],
	["delegate", createDelegateTool(delegateBatch, (id) => getAgentCtx(id).name === "orchestrator")],
]);

const registry = createRegistry();
const mainExtension = defineExtension({
	tasks: [delegateBatch],
	name: "pi-stick",
	hooks: [
		hook(GenerationTask, {
			afterResponse(message, api) {
				const agentLabel = getAgentCtx(api.conversationId).label;
				if (message.content.some((b) => b.type === "toolCall")) {
					for (const b of message.content) {
						if (b.type === "text" && b.text.trim()) emitProgress(b.text.trim(), agentLabel);
					}
				}
			},
		}),
		hook(ToolTask, {
			beforeTool(call, api) {
				if (call.parent) return;
				const agentLabel = getAgentCtx(api.conversationId).label;
				if (call.name === "codemode") emitProgress("codemode", agentLabel);
				else if (call.name === "delegate" && Array.isArray(call.arguments?.tasks)) {
					const names = (call.arguments.tasks as Array<{ agent?: string }>).map((t) => t.agent ?? "?").join(", ");
					emitProgress(`delegate: [${names}]`, agentLabel);
				} else if (call.name === "bash" && typeof call.arguments?.command === "string")
					emitProgress(`bash: ${JSON.stringify(call.arguments.command.slice(0, 200))}`, agentLabel);
				else if (typeof call.arguments?.path === "string")
					emitProgress(`${call.name}: ${JSON.stringify(call.arguments.path.slice(0, 200))}`, agentLabel);
				else emitProgress(call.name, agentLabel);
			},
		}),
	],
	tools: [...toolMap.values()],
});
registry.install(mainExtension);

const sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
const codemodeExtension = createCodemodeExtension({ sandbox, models: false });
registry.install(codemodeExtension);

function selectToolsAndExtensions(toolNames: string[]) {
	const wantCodemode = toolNames.includes("codemode");
	const extensions = wantCodemode ? [mainExtension, codemodeExtension] : [mainExtension];
	const selectedTools: ToolRegistration[] = [];
	for (const name of toolNames) {
		const t = toolMap.get(name);
		if (t) selectedTools.push(t);
	}
	if (wantCodemode) {
		const cm = codemodeExtension.tools?.[0];
		if (cm) selectedTools.push(cm);
	}
	return { extensions, tools: selectedTools };
}

const storage = await openNodeSqliteStorage(`${SESSIONS_DIR}/${job.id}.sqlite`);
const turnKey = job.requestId ?? job.id;
let rootRequestId = turnKey;
let continueRoot = false;
// Inspect before opening the harness: only retry failures that predate this launch.
for (let attempt = 1; ; attempt++) {
	const prior = await storage.submissionByRequest(ROOT_CONVERSATION_ID, rootRequestId, BACKGROUND_CONTEXT);
	if (prior?.status !== "unanswered") break;
	emitProgress(`Root attempt ${attempt} was unanswered: ${prior.reason}`, "orchestrator");
	continueRoot = prior.type === "continue" || prior.entry !== undefined;
	rootRequestId = `${turnKey}:retry:${attempt}`;
}
const h = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
try {
	protocol.signal.throwIfAborted();
	// Scheduling can resume siblings as soon as the first input is submitted.
	for (const [id, agent] of Object.entries((await h.snapshot(workflow, ctx))?.agents ?? {})) {
		agentByConv.set(Number(id) as ConversationId, {
			...agent,
			label: `agent:${agent.name}`,
			scratchDir: join(SCRATCH_DIR, agent.name),
		});
	}

	if (job.check) {
		// Offline self-check: exercise Codemode + multiplexed RPC + native file tools + read-only scratch + parallel multi-agent delegate + SQLite durability.
		const { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai");
		const faux = fauxProvider();
		models.setProvider(faux.provider);
		const fauxModel = { provider: faux.provider.id, modelId: faux.getModel().id };

		activeSubagents["checker-a"] = {
			name: "checker-a",
			model: fauxModel,
			instructions: "Offline read-only probe subagent A",
			mode: "read-only",
			tools: ["read", "write", "grep", "find"],
		};
		activeSubagents["checker-b"] = {
			name: "checker-b",
			model: fauxModel,
			instructions: "Offline read-only probe subagent B",
			mode: "read-only",
			tools: ["read", "write", "find", "codemode"],
		};

		for (const [path, data] of Object.entries({
			"probe.txt": "probe-workspace",
			"probe-edit.txt": "before",
			".gitignore": "/probe-src/vendor/\n",
			"probe-src/000.txt": "-probeXmarker\n",
			"probe-src/z/.visible.ts": "first line\n-probe.marker\n",
			"probe-src/vendor/ignored.ts": "-probe.marker\n",
			"probe-src/nested/.gitignore": "ignored.ts\n",
			"probe-src/nested/ignored.ts": "-probe.marker\n",
			"probe-src/node_modules/ignored.ts": "-probe.marker\n",
		})) {
			const file = join(WORKSPACE_DIR, path);
			fs.mkdirSync(dirname(file), { recursive: true });
			fs.writeFileSync(file, data, { flag: "wx" });
		}
		const code = `const [a, b, cmd] = await Promise.all([tools.ps({}), tools.logs({ tail: 5 }), tools.bash({command: "exit 7"})]); const edit = await tools.edit({path: "probe-edit.txt", edits: [{oldText: "before", newText: "after"}]}); return [a,b,edit, cmd.exit_code === 7 && !cmd.truncated && cmd.output === "probe-bash" ? "bash-ok" : "bash-failed"].join("|");`;
		const router = (transcript: {
			messages: Array<{ role: string; isError?: boolean; content: string | Array<{ type: string; text?: string }> }>;
		}) => {
			const msgText = (m: { content: string | Array<{ type: string; text?: string }> } | undefined) =>
				!m ? "" : typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("\n");
			const firstUser = msgText(transcript.messages.find((m) => m.role === "user"));
			const last = transcript.messages.at(-1);
			if (firstUser === "probe A") {
				if (last?.role === "user") {
					return fauxAssistantMessage(
						[
							fauxToolCall("read", { path: `${CONTAINER_REPO_DIR}/probe.txt` }),
							fauxToolCall("grep", { path: "probe-src", pattern: "-probe.marker" }),
							fauxToolCall("write", { path: `${CONTAINER_REPO_DIR}/should-fail.txt`, content: "nope" }),
							fauxToolCall("write", { path: "/scratch/checker-a/note.txt", content: "ok-a" }),
						],
						{ stopReason: "toolUse" },
					);
				}
				const results = transcript.messages.filter((m) => m.role === "toolResult");
				const blockedWorkspace = results.some((r) => r.isError && msgText(r).includes("read-only"));
				const readWorkspace = results.some((r) => !r.isError && msgText(r) === "probe-workspace");
				const grep = results.some((r) => !r.isError && msgText(r) === "z/.visible.ts:2:-probe.marker");
				const wroteScratch = results.some((r) => !r.isError && msgText(r).includes("/scratch/checker-a/note.txt"));
				return fauxAssistantMessage([
					fauxText(
						blockedWorkspace && readWorkspace && wroteScratch && grep ? "subagent-a-ok" : "subagent-a-fail",
					),
				]);
			}
			if (firstUser === "probe B") {
				if (last?.role === "user") {
					return fauxAssistantMessage(
						[
							fauxToolCall("find", { path: "probe-src", query: "**/*.ts", maxResults: 1 }),
							fauxToolCall("find", { path: "probe-src", maxResults: 1 }),
							fauxToolCall("codemode", {
								code: `
								const own = await tools.write({path: "/scratch/checker-b/note.txt", content: "ok-b"});
								for (const path of ["should-fail.txt", "/scratch/checker-a/forbidden.txt", "/context/forbidden.txt"]) {
									const [attempt] = await Promise.allSettled([tools.write({path, content: "nope"})]);
									if (attempt.status !== "rejected") throw Error("Unexpected write access: " + path);
								}
								return own;`,
							}),
						],
						{ stopReason: "toolUse" },
					);
				}
				const results = transcript.messages.filter((m) => m.role === "toolResult" && !m.isError).map(msgText);
				const find =
					results.includes("z/.visible.ts") &&
					results.includes("000.txt\n[More files omitted; narrow the search.]");
				return fauxAssistantMessage([
					fauxText(
						find && results.some((r) => r.includes("Successfully wrote to /scratch/checker-b/note.txt"))
							? "subagent-b-ok"
							: "subagent-b-fail",
					),
				]);
			}
			// Orchestrator sequence: (1) Codemode multiplexed RPC, (2) parallel delegate, (3) final ready
			const toolResults = transcript.messages.filter((m) => m.role === "toolResult");
			if (toolResults.length === 0) {
				return fauxAssistantMessage([fauxText("Probing runtime."), fauxToolCall("codemode", { code })], {
					stopReason: "toolUse",
				});
			}
			if (toolResults.length === 1) {
				const okRpc =
					!toolResults[0].isError &&
					msgText(toolResults[0]).includes("probe-ok:ps") &&
					msgText(toolResults[0]).includes("probe-ok:logs") &&
					msgText(toolResults[0]).includes("bash-ok") &&
					msgText(toolResults[0]).includes("Successfully replaced 1 block") &&
					fs.readFileSync(join(WORKSPACE_DIR, "probe-edit.txt"), "utf8") === "after";
				if (!okRpc) return fauxAssistantMessage([fauxText("rpc-probe-failed")]);
				return fauxAssistantMessage(
					[
						fauxToolCall("delegate", {
							tasks: [
								{ agent: "checker-a", prompt: "probe A" },
								{ agent: "checker-b", prompt: "probe B" },
							],
						}),
					],
					{ stopReason: "toolUse" },
				);
			}
			const del = toolResults[1];
			const okDel = !del.isError && msgText(del).includes("subagent-a-ok") && msgText(del).includes("subagent-b-ok");
			return fauxAssistantMessage([fauxText(okDel ? "ready" : `delegate-probe-failed:${msgText(del)}`)]);
		};
		faux.setResponses(Array.from({ length: 12 }, () => router as never));

		const root = await h.root(ctx, {
			agent: { model: fauxModel, instructions: "Offline orchestrator probe" },
		});
		const sub = await root.submit({ type: "input", content: "Offline self-check" }, ctx);
		const settled = await sub.wait(ctx);
		if (settled.status !== "done" || settled.type !== "input")
			throw Error(`Offline self-check failed: ${JSON.stringify(settled)}`);
		const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
		const message = answer?.model?.[0];
		if (message?.role !== "assistant" || !message.content.some((b) => b.type === "text" && b.text === "ready"))
			throw Error(`Offline self-check did not return ready: ${JSON.stringify(message?.content)}`);
		if (!probeEvents.includes("[orchestrator] Probing runtime.") || !probeEvents.includes("[orchestrator] codemode"))
			throw Error(`Unexpected probe progress events: ${JSON.stringify(probeEvents)}`);
		send({ type: "response", command: "run", id: job.id, success: true, data: { ready: true } });
	} else {
		let result: string | RunFailure;
		try {
			result = await runAction();
		} catch (err) {
			result = err instanceof RunFailure ? err : new RunFailure("Action failed");
		}
		protocol.signal.throwIfAborted();
		const usage = await h.usage(ctx).catch(() => {
			emitProgress("Warning: session usage snapshot unavailable");
			return undefined;
		});
		if (result instanceof RunFailure) {
			send({ type: "response", command: "run", id: job.id, success: false, error: result.message, data: { usage } });
			throw result;
		}
		send({
			type: "response",
			command: "run",
			id: job.id,
			success: true,
			data: { report: result, usage, ...(Object.keys(agentOutputs).length ? { outputs: agentOutputs } : {}) },
		});
	}
} finally {
	process.stdin.off("end", hostDisconnected);
	rl.close();
	await sandbox.close();
	await h.close(BACKGROUND_CONTEXT);
	protocol.signal.throwIfAborted();
}

async function runAction(): Promise<string> {
	const spec = job.orchestrator;
	if (!job.prompt) throw new RunFailure("Missing prompt");
	if (!spec && (job.continueRun || job.stages?.at(-1)?.parallel.length !== 1))
		throw new RunFailure("A run without an orchestrator requires a single final agent and cannot continue");

	let finalPrompt = job.prompt;
	if (!job.continueRun && job.stages?.length) {
		const stageSections: string[] = [];
		for (const [index, stage] of job.stages.entries()) {
			emitProgress(`Starting parallel stage '${stage.name}': ${stage.parallel.join(", ")}`, stageProgressLabel);
			let stagePrompt = stage.prompt ? `${stage.prompt}\n\nTask context:\n${job.prompt}` : job.prompt;
			if (index > 0) {
				const prior = job.stageContext === "all" ? stageSections.join("\n\n") : stageSections[index - 1];
				stagePrompt += `\n\n# Previous stage results\n\n${prior}`;
			}
			const requireReport = !spec && index === job.stages.length - 1;
			const batch = stage.parallel.map((agentName) => {
				const agentSpec = activeSubagents[agentName];
				if (!agentSpec) throw new RunFailure(`Stage '${stage.name}' references missing agent '${agentName}'`);
				return { spec: agentSpec, prompt: stagePrompt, requireReport };
			});
			const { results, cleanlinessWarning } = await runParallelBatch(batch, `stage:${stage.name}`, {
				stageKey: `${job.requestId}:${index}:${stage.name}`,
			});
			const failures = results.filter((r) => !r.ok);
			if (failures.length) {
				const message = `Stage '${stage.name}' failed: ${failures.map((r) => r.agent).join(", ")}`;
				throw new RunFailure(message);
			}
			if (requireReport) return results[0].output;
			const lines = [`## Stage: ${stage.name}`];
			for (const r of results) {
				lines.push(`### Agent: ${r.agent} (ok)\n\n${r.output}`);
			}
			if (cleanlinessWarning) lines.push(`### Repository Cleanliness Warning\n\n${cleanlinessWarning}`);
			stageSections.push(lines.join("\n\n"));
		}
		finalPrompt = `${job.prompt}\n\n---\n\n# Parallel Stage Results\n\n${stageSections.join("\n\n")}`;
	}

	if (!spec) throw new RunFailure("Missing orchestrator");
	fs.mkdirSync(defaultAgentCtx.scratchDir, { recursive: true });
	const { extensions, tools } = selectToolsAndExtensions(spec.tools);
	const root = await h.root(ctx, {
		agent: {
			model: spec.model,
			instructions: spec.instructions,
			extensions,
			tools,
			thinkingLevel: spec.thinkingLevel,
			...(spec.maxTurns ? { maxTurns: spec.maxTurns } : {}),
		},
	});
	if (job.continueRun) await root.configure({ instructions: spec.instructions }, ctx);
	const sub = await root.submit(
		continueRoot
			? { type: "continue", requestId: rootRequestId }
			: { type: "input", content: finalPrompt, requestId: rootRequestId },
		ctx,
	);
	const settled = await sub.wait(ctx);
	if (settled.status !== "done" || settled.type === "write")
		throw new RunFailure(`Orchestrator submission did not complete: ${settled.status}`);
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
	const message = entry?.model?.[0];
	if (message?.role !== "assistant") throw new RunFailure("Orchestrator returned no assistant answer");
	const report = message.content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
	if (!report) throw new RunFailure("Orchestrator returned an empty report");
	return report;
}

await new Promise<void>((resolve, reject) => writeProtocol("", (err) => (err ? reject(err) : resolve())));
process.exit(0);
