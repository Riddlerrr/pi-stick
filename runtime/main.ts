// biome-ignore assist/source/organizeImports: Reserve stdout before dependencies run their initialization code.
import { writeProtocol } from "./tools/protocol-stdout.ts";

import * as fs from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";

import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
	AssistantEntry,
	configure,
	type Conversation,
	type ConversationId,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTask,
	type DocumentReader,
	GenerationTask,
	Harness,
	hook,
	LiveDoc,
	type LiveState,
	type Submission,
	type SubmissionDraft,
	ROOT_CONVERSATION_ID,
	section,
	type TaskId,
	type ToolRegistration,
	ToolTask,
	type Tx,
	wrapTool,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { createFitImagesExtension } from "@earendil-works/pi-durable/images/fit";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import {
	type AccessLease,
	type Job,
	type AgentRuntimeSpec,
	type Method,
	type RefreshCall,
	type RpcCall,
	type RpcData,
	type ToolCall,
	type RuntimeMessage,
	RunFailure,
	readJob,
	readReply,
} from "./protocol.ts";
import { runtimeCredentials } from "./auth.ts";
import { type AgentContext, CONTAINER_REPO_DIR, SCRATCH_DIR, createPathResolver } from "./paths.ts";
import { AgentExecutionEnv } from "./tools/agent-execution-env.ts";
import { createBashTool } from "./tools/bash.ts";
import { type BatchResult, createDelegateTool, type DelegateTasks } from "./tools/delegate.ts";
import { editTool, withEditHandle } from "./tools/edit.ts";
import { createFindTool } from "./tools/find.ts";
import { createGrepTool } from "./tools/grep.ts";
import { createLogsTool } from "./tools/logs.ts";
import { createPsTool } from "./tools/ps.ts";
import { images, readTool, withReadDiagnostics } from "./tools/read.ts";
import { createRestartTool } from "./tools/restart.ts";
import type { AgentRpc } from "./tools/rpc.ts";
import { writeTool } from "./tools/write.ts";

const SESSIONS_DIR = process.env.PI_STICK_SESSIONS_DIR ?? "/sessions";
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
		resolve: (res: RpcData | AccessLease) => void;
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
			if (reply.success) pending.resolve(reply.data);
			else if (reply.command === "refresh_token") pending.reject(Error("Host could not renew OAuth token"));
			else pending.resolve({ text: reply.error, error: true });
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

function callHostRpc(request: RefreshCall): Promise<AccessLease>;
function callHostRpc(
	request: ToolCall & { agent?: string },
	onChunk?: (chunk: Buffer) => void,
	signal?: AbortSignal,
): Promise<RpcData>;
async function callHostRpc(
	request: RpcCall,
	onChunk?: (chunk: Buffer) => void,
	signal?: AbortSignal,
): Promise<RpcData | AccessLease> {
	protocol.signal.throwIfAborted();
	if (signal?.aborted) throw Error("Command aborted");
	const id = String(++rpcSeq);
	const cancel = () => send({ type: "cancel_exec", id: id });
	try {
		return await new Promise((resolve, reject) => {
			pendingRpc.set(id, { command: request.type, resolve, reject, onChunk });
			send({ ...request, id });
			signal?.addEventListener("abort", cancel, { once: true });
		});
	} finally {
		signal?.removeEventListener("abort", cancel);
	}
}

// Docker forwards EOF when the worker dies, even during an outstanding model request.
const hostDisconnected = () => {
	if (!protocol.signal.aborted) process.exit(1);
};
process.stdin.once("end", hostDisconnected);
const job = await readInitialJob();
protocol.signal.throwIfAborted();

const resolveAgentPath = createPathResolver();

const allProviders = builtinProviders();
const models = createModels({
	credentials: runtimeCredentials(job.credentials, allProviders, (provider) =>
		callHostRpc({ type: "refresh_token", provider }),
	),
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

const rootAgentCtx: AgentContext = {
	name: "orchestrator",
	label: "orchestrator",
	mode: job.orchestrator?.mode ?? "read-write",
	scratchDir: join(SCRATCH_DIR, "orchestrator"),
};
async function getAgentCtx(id: ConversationId, read: DocumentReader, context: Context): Promise<AgentContext> {
	if (id === ROOT_CONVERSATION_ID) return rootAgentCtx;
	const agent = (await read.snapshot(workflow, context))?.agents[id];
	if (!agent) throw Error(`Missing agent context for conversation ${id}`);
	return { ...agent, label: `agent:${agent.name}`, scratchDir: join(SCRATCH_DIR, agent.name) };
}

const probeEvents: string[] = [];
const emitProgress = (line: string, label?: string) => {
	if (job.check) probeEvents.push(label ? `[${label}] ${line}` : line);
	else send({ type: "progress", message: line, ...(label ? { agent: label } : {}) });
};

const stageProgressLabel = job.check || job.orchestrator ? "orchestrator" : undefined;
const activeSubagents: Record<string, AgentRuntimeSpec> = { ...(job.agents ?? {}) };
const agentOutputs: Record<string, string> = {};

type Batch = Array<{ spec: AgentRuntimeSpec; prompt: string; requireReport?: boolean }>;
type PreparedBatch = { conversations: ConversationId[]; baseline?: RpcData };
type StageBatch = PreparedBatch & { result?: BatchResult };

const workflow = defineDoc<{
	agents: Record<string, { name: string; mode: "read-only" | "read-write" }>;
	stages: Record<string, StageBatch>;
	delegates?: { requestId: string; tasks: TaskId<BatchResult>[] };
	rootCheck?: { turn: string; baseline: RpcData };
}>({
	kind: "pi-stick.workflow",
	version: 2,
	scope: "session",
	initial: () => ({ agents: {}, stages: {} }),
	checkpointWhen: () => false,
});

function recordAgentOutput(agentName: string, text: string) {
	if (agentOutputs[agentName]) agentOutputs[agentName] = `${agentOutputs[agentName]}\n\n---\n\n${text}`;
	else agentOutputs[agentName] = text;
}

async function prepareConversations(
	tx: Tx,
	batch: Batch,
	owner?: TaskId,
	prior?: StageBatch,
): Promise<ConversationId[]> {
	const state = await tx.doc(workflow);
	const ids: ConversationId[] = [];
	for (const [i, { spec }] of batch.entries()) {
		if (prior?.result?.results[i].ok) {
			ids.push(prior.conversations[i]);
			continue;
		}
		const { id } = await tx.createConversation({
			ownership: owner === undefined ? { kind: "ownerless" } : { kind: "task", taskId: owner },
		});
		await configure(tx, id, {
			...selectToolsAndExtensions(spec.tools.filter((t) => t !== "delegate")),
			model: spec.model,
			instructions: spec.instructions,
			thinkingLevel: spec.thinkingLevel ?? null,
			maxTurns: spec.maxTurns ?? null,
		});
		state.agents[id] = { name: spec.name, mode: spec.mode };
		ids.push(id);
	}
	return ids;
}

// Submission reasons are arbitrary strings in durable storage; only expose known codes.
function safeReason(reason: string) {
	return [
		"turn_limit",
		"model_error",
		"restart_limit",
		"interrupted",
		"no_model",
		"aborted",
		"reset",
		"faulted",
		"orphaned",
		"nothing_to_answer",
		"stale",
		"run_failed",
	].includes(reason)
		? reason
		: "unknown";
}

async function waitForAnswer(sub: Submission, id: ConversationId, label: string, context: Context) {
	let previous: LiveState | undefined;
	const progress = (live: LiveState) => {
		const retry = live.generation?.retry;
		if (retry && retry.at !== previous?.generation?.retry?.at)
			emitProgress(`Model retry in ${Math.max(0, Math.ceil((retry.at - Date.now()) / 1000))}s`, label);
		for (const task of live.compactions ?? []) {
			if (!previous?.compactions?.some((prior) => prior.taskId === task.taskId))
				emitProgress("Compacting context", label);
		}
		previous = live;
	};
	const observation = await h.observeDoc(
		LiveDoc,
		id,
		{
			advance(call) {
				if (call.kind === "value") progress(call.value);
			},
			end() {},
		},
		context,
	);
	try {
		// An update can arrive before attachment resolves; don't then replay the older initial state.
		if (observation && !previous) progress(observation.value);
		return await sub.wait(context);
	} finally {
		observation?.detach();
	}
}

const reportPrompt = "Write the final report now, using the work already done.";

async function answerText(
	conv: Conversation,
	label: string,
	context: Context,
	initial: SubmissionDraft,
	reminder?: SubmissionDraft,
): Promise<string | RunFailure> {
	for (const draft of [initial, reminder]) {
		if (!draft) return "";
		if (draft === reminder) emitProgress("Empty report; requesting final text", label);
		const sub = await conv.submit(draft, context);
		const settled = await waitForAnswer(sub, conv.id, label, context);
		if (settled.status !== "done" || settled.type === "write")
			return new RunFailure(
				`${label} submission did not complete: ${settled.reason ? safeReason(settled.reason) : settled.status}`,
			);
		const entry = await conv.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		const message = entry?.model?.[0];
		if (message?.role !== "assistant") return new RunFailure(`${label} returned no assistant answer`);
		const text = message.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return new RunFailure(`${label} returned an empty report after one reminder`);
}

async function runSubagent(
	{ spec, prompt, requireReport }: Batch[number],
	id: ConversationId,
	context: Context,
): Promise<BatchResult["results"][number]> {
	const scratchDir = join(SCRATCH_DIR, spec.name);
	fs.mkdirSync(scratchDir, { recursive: true });
	const conv = await h.conversation(id, context);
	if (!conv) throw Error(`Missing subagent conversation: ${id}`);
	const label = `agent:${spec.name}`;
	emitProgress("started", label);
	const text = await answerText(
		conv,
		label,
		context,
		{ type: "input", content: prompt, requestId: "work" },
		requireReport ? { type: "input", content: reportPrompt, requestId: "work:report" } : undefined,
	);
	if (text instanceof RunFailure) {
		emitProgress(text.message, label);
		return { agent: spec.name, ok: false, output: text.message };
	}
	emitProgress("completed", label);
	return { agent: spec.name, ok: true, output: text || "(empty output)" };
}

async function prepareBatch(batch: Batch, batchLabel: string): Promise<Pick<PreparedBatch, "baseline">> {
	const names = new Set<string>();
	for (const { spec } of batch) {
		if (names.has(spec.name)) throw Error(`Batch '${batchLabel}' repeats agent '${spec.name}'`);
		names.add(spec.name);
	}
	const rwCount = batch.filter((b) => b.spec.mode === "read-write").length;
	if (rwCount > 1) {
		throw Error(
			`Cannot run ${rwCount} read-write subagents in parallel in '${batchLabel}'; run read-write subagents sequentially or use read-only subagents for parallel execution.`,
		);
	}
	return rwCount ? {} : { baseline: await callHostRpc({ type: "check_clean" }) };
}

async function checkCleanliness(baseline: RpcData | undefined, batchLabel: string) {
	let cleanlinessWarning: string | undefined;
	if (baseline) {
		const after = baseline.error ? baseline : await callHostRpc({ type: "check_clean" });
		if (after.error)
			cleanlinessWarning = `WARNING: Could not verify tracked files in read-only round '${batchLabel}': ${after.text}`;
		else if (after.text !== baseline.text)
			cleanlinessWarning = `WARNING: Tracked repository files changed during read-only round '${batchLabel}':\n${after.text.trim()}`;
	}
	if (cleanlinessWarning) emitProgress(cleanlinessWarning, stageProgressLabel);
	return cleanlinessWarning;
}

async function runParallelBatch(
	batch: Batch,
	batchLabel: string,
	{ conversations, baseline }: PreparedBatch,
	context: Context,
): Promise<BatchResult> {
	const results = await Promise.all(batch.map((item, i) => runSubagent(item, conversations[i], context)));
	const cleanlinessWarning = await checkCleanliness(baseline, batchLabel);
	return { results, ...(cleanlinessWarning ? { cleanlinessWarning } : {}) };
}

async function runStage(batch: Batch, label: string, key: string): Promise<BatchResult> {
	let stage = (await h.snapshot(workflow, ctx))?.stages[key];
	if (stage?.result?.results.every((r) => r.ok)) {
		emitProgress(`Restored completed ${label}`, stageProgressLabel);
		return stage.result;
	}
	if (!stage || stage.result) {
		const prior = stage;
		const baseline = await prepareBatch(batch, label);
		stage = await h.commit(async (tx) => {
			const conversations = await prepareConversations(tx, batch, undefined, prior);
			const prepared = { conversations, ...baseline };
			(await tx.doc(workflow)).stages[key] = prepared;
			return prepared;
		}, ctx);
	}
	const result = await runParallelBatch(batch, label, stage, ctx);
	await h.commit(async (tx) => {
		(await tx.doc(workflow)).stages[key].result = result;
	}, ctx);
	return result;
}

function delegatedAgents(tasks: DelegateTasks): Batch {
	return tasks.map(({ agent, prompt }) => {
		const spec = activeSubagents[agent];
		if (!spec)
			throw Error(`Unknown subagent '${agent}'. Available: ${Object.keys(activeSubagents).join(", ") || "(none)"}`);
		return { spec, prompt };
	});
}

type DelegatePhase = { phase: "prepare" } | ({ phase: "run" } & PreparedBatch);
const delegateBatch = defineTask<DelegateTasks, DelegatePhase, BatchResult>({
	name: "pi-stick.delegate-batch",
	version: 2,
	initial: () => ({ phase: "prepare" }),
	phases: {
		prepare: async (task, runtime, context) => {
			const batch = delegatedAgents(task.input);
			const baseline = await prepareBatch(batch, "delegate");
			await runtime.commit(async (tx) => {
				const conversations = await prepareConversations(tx, batch, runtime.taskId);
				return { status: "running", checkpoint: { phase: "run", conversations, ...baseline } };
			}, context);
		},
		run: async (task, runtime, context) => {
			const result = await runParallelBatch(delegatedAgents(task.input), "delegate", task.state.checkpoint, context);
			await runtime.commit(async (tx) => {
				const state = await tx.doc(workflow);
				if (state.delegates?.requestId !== turnKey) state.delegates = { requestId: turnKey, tasks: [] };
				state.delegates.tasks.push(runtime.taskId);
				return { status: "terminal", outcome: { status: "completed", result } };
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
	},
});

const agentRpc: AgentRpc = (request, agent) => callHostRpc({ ...request, agent });

const toolMap = new Map<string, ToolRegistration>([
	["read", readTool],
	["write", writeTool],
	["edit", editTool],
	["grep", createGrepTool(CONTAINER_REPO_DIR)],
	["find", createFindTool(CONTAINER_REPO_DIR)],
	[
		"bash",
		createBashTool((args, agent, onChunk, signal) => callHostRpc({ ...args, type: "exec", agent }, onChunk, signal)),
	],
	["logs", createLogsTool(agentRpc)],
	["ps", createPsTool(agentRpc)],
	["restart", createRestartTool(agentRpc)],
	["delegate", createDelegateTool(delegateBatch)],
]);

const registry = createRegistry();
const mainExtension = defineExtension({
	tasks: [delegateBatch],
	wraps: [wrapTool(readTool, withReadDiagnostics), wrapTool(editTool, withEditHandle)],
	name: "pi-stick",
	sections: job.check
		? []
		: [
				section("workspace", async ({ conversationId, read }, context) => {
					const { name, mode } = await getAgentCtx(conversationId, read, context);
					return (
						`You are agent '${name}' in project '${job.project}'. Repository: ${CONTAINER_REPO_DIR} (${mode}), shared with the runner. Your writable scratch directory is /scratch/${name}.` +
						(mode === "read-only"
							? " Do not modify repository files; put temporary work in your scratch directory."
							: "")
					);
				}),
				section("project-notes", () =>
					job.projectNotes?.trim() ? `Project AGENTS.md:\n${job.projectNotes.trim()}` : undefined,
				),
				section("services", () =>
					job.services.length ? `Compose services on your network: ${job.services.join(", ")}.` : undefined,
				),
				section("context-files", () =>
					job.contextFiles.length ? `Read-only files in /context: ${job.contextFiles.join(", ")}.` : undefined,
				),
				section("subagents", ({ conversationId }) => {
					if (conversationId !== ROOT_CONVERSATION_ID || !job.orchestrator?.tools.includes("delegate")) return;
					return (
						Object.values(job.agents)
							.map(
								(a) =>
									`- ${a.name} (${a.mode}, ${a.model.provider}/${a.model.modelId})${a.description ? `: ${a.description}` : ""}`,
							)
							.join("\n") || undefined
					);
				}),
			],
	hooks: [
		hook(GenerationTask, {
			async afterResponse(message, api, context) {
				if (message.content.some((b) => b.type === "toolCall")) {
					const agentLabel = (await getAgentCtx(api.conversationId, api, context)).label;
					for (const b of message.content) {
						if (b.type === "text" && b.text.trim()) emitProgress(b.text.trim(), agentLabel);
					}
				}
			},
		}),
		hook(ToolTask, {
			async beforeTool(call, api, context) {
				if (call.parent) return;
				const agentLabel = (await getAgentCtx(api.conversationId, api, context)).label;
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
const fitImagesExtension = createFitImagesExtension(images);
registry.install(fitImagesExtension);

function selectToolsAndExtensions(toolNames: string[]) {
	const wantCodemode = toolNames.includes("codemode");
	const extensions = [mainExtension, ...(wantCodemode ? [codemodeExtension] : []), fitImagesExtension];
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
// Inspect before opening the harness: only retry failures that predate this launch.
async function rootRequest(key: string) {
	let requestId = key;
	let resume = false;
	for (let attempt = 1; ; attempt++) {
		const prior = await storage.submissionByRequest(ROOT_CONVERSATION_ID, requestId, BACKGROUND_CONTEXT);
		if (prior?.status !== "unanswered") break;
		emitProgress(`Root attempt ${attempt} was unanswered: ${safeReason(prior.reason)}`, "orchestrator");
		resume = prior.type === "continue" || prior.entry !== undefined;
		requestId = `${key}:retry:${attempt}`;
	}
	return (content: string): SubmissionDraft =>
		resume ? { type: "continue", requestId } : { type: "input", content, requestId };
}
const rootInput = await rootRequest(turnKey);
const rootReminder = (await rootRequest(`${turnKey}:report`))(reportPrompt);
const h = await Harness.open(
	storage,
	{
		models,
		registry,
		onReport(report) {
			// Never log the error itself, even to the private worker log.
			const reason =
				report.kind === "task_faulted" || report.kind === "task_interrupted" ? `: ${report.reason}` : "";
			const count = report.kind === "task_interrupted" ? ` (restarts: ${report.restarts})` : "";
			console.error(`Durable ${report.kind}${reason}${count}`);
		},
		async env({ conversationId, read }, context) {
			const agent = await getAgentCtx(conversationId, read, context);
			return new AgentExecutionEnv(agent.name, (path, write) => resolveAgentPath(path, agent, write));
		},
	},
	BACKGROUND_CONTEXT,
);
try {
	protocol.signal.throwIfAborted();
	if (job.check) {
		const { selfCheck } = await import("./self-check.ts");
		await selfCheck(h, ctx, models, activeSubagents, probeEvents);
		send({ type: "response", command: "run", id: job.id, success: true, data: { ready: true } });
	} else {
		let result: string | RunFailure;
		try {
			result = await runAction();
		} catch (err) {
			if (err instanceof RunFailure) result = err;
			else {
				console.error(unexpectedActionDiagnostic(err));
				result = new RunFailure("Action failed");
			}
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

function unexpectedActionDiagnostic(err: unknown): string {
	const kind = err instanceof TypeError ? "TypeError" : err instanceof RangeError ? "RangeError" : "error";
	const summary = `Unexpected ${kind}`;
	try {
		const stack = err instanceof Error ? err.stack : undefined;
		if (typeof stack === "string") {
			// Only emit coordinates in this module, never arbitrary stack or message text.
			for (const frame of stack.matchAll(/^ {4}at (?:[^\n]* \()?([^\s()]+):(\d{1,6}):(\d{1,6})\)?$/gm)) {
				if (frame[1] === import.meta.url) return `${summary} at runtime/main.ts:${frame[2]}:${frame[3]}`;
			}
		}
	} catch {
		// A custom stack getter can throw.
	}
	return summary;
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
			const { results, cleanlinessWarning } = await runStage(
				batch,
				`stage:${stage.name}`,
				`${turnKey}:${index}:${stage.name}`,
			);
			for (const r of results) if (r.ok) recordAgentOutput(r.agent, r.output);
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
	fs.mkdirSync(rootAgentCtx.scratchDir, { recursive: true });
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
	let baseline: RpcData | undefined;
	if (spec.mode === "read-only" && !spec.tools.includes("delegate")) {
		const saved = (await h.snapshot(workflow, ctx))?.rootCheck;
		if (saved?.turn === turnKey) baseline = saved.baseline;
		else {
			// Keep the original baseline if the worker dies during the submission.
			const check = { turn: turnKey, baseline: await callHostRpc({ type: "check_clean" }) };
			await h.commit(async (tx) => {
				(await tx.doc(workflow)).rootCheck = check;
			}, ctx);
			baseline = check.baseline;
		}
	}
	let report: string | RunFailure;
	try {
		report = await answerText(root, "orchestrator", ctx, rootInput(finalPrompt), rootReminder);
	} finally {
		await checkCleanliness(baseline, "orchestrator");
	}
	if (report instanceof RunFailure) throw report;
	const delegates = (await h.snapshot(workflow, ctx))?.delegates;
	if (delegates?.requestId === turnKey) {
		for (const id of delegates.tasks) {
			const task = await h.getTask(id, ctx);
			if (task?.state.status !== "terminal" || task.state.outcome.status !== "completed")
				throw new RunFailure("Missing completed delegate result");
			for (const r of task.state.outcome.result.results) if (r.ok) recordAgentOutput(r.agent, r.output);
		}
	}
	return report;
}

await new Promise<void>((resolve, reject) => writeProtocol("", (err) => (err ? reject(err) : resolve())));
process.exit(0);
