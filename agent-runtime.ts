import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
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
	defineTool,
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

import { type CredentialPayload, runtimeCredentials } from "./runtime-auth.ts";
import { createReadTool } from "./runtime-tools/read.ts";

const SESSIONS_DIR = process.env.PI_STICK_SESSIONS_DIR ?? "/sessions";
const CONTAINER_REPO_DIR = "/workspace/repo";
const WORKSPACE_DIR = process.env.PI_STICK_WORKSPACE_DIR ?? CONTAINER_REPO_DIR;
const SCRATCH_DIR = process.env.PI_STICK_SCRATCH_DIR ?? "/scratch";
const CONTEXT_DIR = process.env.PI_STICK_CONTEXT_DIR ?? "/context";
const MAX_SEARCH_CHARS = 32_000;
const MAX_FIND_RESULTS = 500;
const MAX_GREP_MATCHES = 2000;
const SEARCH_TIMEOUT_MS = 15_000;

interface AgentRuntimeSpec {
	name: string;
	description?: string;
	model: { provider: string; modelId: string };
	instructions: string;
	mode: "read-only" | "read-write";
	tools: string[];
	thinkingLevel?: ModelThinkingLevel;
	maxTurns?: number;
}

interface StageRuntimeSpec {
	name: string;
	parallel: string[];
	prompt?: string;
}

interface Job {
	id: string;
	check?: boolean;
	models?: Record<string, Model<Api>[]>;
	credentials?: Record<string, CredentialPayload>;
	orchestrator?: AgentRuntimeSpec;
	agents?: Record<string, AgentRuntimeSpec>;
	stageContext?: "previous" | "all";
	stages?: StageRuntimeSpec[];
	prompt?: string;
	requestId?: string;
	continueRun?: boolean;
}

interface RpcResponseMessage {
	rpc: number;
	result?: { text: string; error?: boolean };
}

interface AgentContext {
	name: string;
	label: string;
	mode: "read-only" | "read-write";
	scratchDir: string;
}

const send = (data: unknown) => {
	process.stdout.write(`${JSON.stringify(data)}\n`);
};

const rl = createInterface({ input: process.stdin });
const pendingRpc = new Map<
	number,
	{ resolve: (res: { text: string; error?: boolean }) => void; reject: (err: Error) => void }
>();
let rpcSeq = 0;

function readInitialJob(): Promise<Job> {
	return new Promise((resolve, reject) => {
		let gotFirst = false;
		rl.on("line", (line) => {
			let msg: unknown;
			try {
				msg = JSON.parse(line);
			} catch (err) {
				if (!gotFirst) reject(err instanceof Error ? err : Error(String(err)));
				return;
			}
			if (!gotFirst) {
				gotFirst = true;
				resolve(msg as Job);
				return;
			}
			const reply = msg as RpcResponseMessage;
			if (typeof reply?.rpc === "number") {
				const pending = pendingRpc.get(reply.rpc);
				if (pending) {
					pendingRpc.delete(reply.rpc);
					if (reply.result && typeof reply.result.text === "string") pending.resolve(reply.result);
					else pending.reject(Error("Invalid RPC reply from host"));
				}
			}
		});
		rl.on("close", () => {
			if (!gotFirst) reject(Error("Host launcher disconnected before job initialization"));
			for (const [id, pending] of pendingRpc) {
				pendingRpc.delete(id);
				pending.reject(Error("Host launcher disconnected"));
			}
		});
	});
}

function callHostRpc(
	method: string,
	params: Record<string, unknown>,
	agent?: string,
): Promise<{ text: string; error?: boolean }> {
	const id = ++rpcSeq;
	return new Promise((resolve, reject) => {
		pendingRpc.set(id, { resolve, reject });
		send({ rpc: id, method, params, ...(agent ? { agent } : {}) });
	});
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
	const realRoot = canonicalBase(root);
	const resolved = nearestExistingRealpath(target);
	const rel = relative(realRoot, resolved);
	if (rel.startsWith("..") || isAbsolute(rel)) throw Error(`Path escapes allowed ${label} directory`);
	return resolved;
}

function resolveAgentPath(rawPath: string, agentCtx: AgentContext, forWrite: boolean): string {
	if (!rawPath || rawPath.includes("\0") || rawPath.length > 2048) throw Error("Invalid path");
	if (rawPath === "/context" || rawPath.startsWith("/context/")) {
		if (forWrite) throw Error("/context is read-only");
		const sub = rawPath === "/context" ? "" : rawPath.slice("/context/".length);
		return assertWithin(resolve(CONTEXT_DIR, sub), CONTEXT_DIR, "context");
	}
	if (rawPath === "/scratch" || rawPath.startsWith("/scratch/")) {
		const sub = rawPath === "/scratch" ? "" : rawPath.slice("/scratch/".length);
		const candidate = resolve(SCRATCH_DIR, sub);
		if (forWrite) {
			fs.mkdirSync(agentCtx.scratchDir, { recursive: true });
			return assertWithin(candidate, agentCtx.scratchDir, `agent scratch (/scratch/${agentCtx.name})`);
		}
		return assertWithin(candidate, SCRATCH_DIR, "scratch");
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
	return assertWithin(resolve(WORKSPACE_DIR, sub), WORKSPACE_DIR, "workspace");
}

function globToRegExp(pattern: string): RegExp {
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*" && pattern[i + 1] === "*") {
			re += ".*";
			i++;
			if (pattern[i + 1] === "/") i++;
		} else if (ch === "*") {
			re += "[^/]*";
		} else if (ch === "?") {
			re += "[^/]";
		} else if ("\\^$+?.()|[]{}".includes(ch)) {
			re += `\\${ch}`;
		} else {
			re += ch;
		}
	}
	return new RegExp(`^${re}$`);
}

async function scanRipgrep(
	cwd: string,
	args: string[],
	separator: string,
	accept: (record: string) => boolean,
	abortSignal: AbortSignal | undefined,
): Promise<boolean> {
	const deadline = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	const child = spawn(
		"rg",
		[
			"--no-config",
			"--hidden",
			"--no-require-git",
			"--no-ignore-global",
			"--no-ignore-dot",
			"--sort=path",
			"--glob=!.git",
			"--glob=!node_modules",
			...args,
		],
		{
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			signal: abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline,
			killSignal: "SIGKILL",
		},
	);
	const closed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
	void closed.catch(() => {}); // The child can fail while stdout is being drained.
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(0, 2000);
	});
	try {
		let pending = "";
		let truncated = false;
		for await (const chunk of child.stdout.setEncoding("utf8") as AsyncIterable<string>) {
			const records = (pending + chunk).split(separator);
			pending = records.pop() ?? "";
			if (records.every(accept)) continue;
			truncated = true;
			child.kill("SIGKILL");
			break;
		}
		const [code, signal] = await closed;
		if (code !== 0 && code !== 1 && !(truncated && signal === "SIGKILL")) {
			throw Error(stderr.trim() || `ripgrep failed (${code ?? signal})`);
		}
		return truncated;
	} catch (err) {
		if (deadline.aborted && !abortSignal?.aborted) throw Error("Search timed out; narrow the search path.");
		throw err;
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
}

// Docker forwards EOF when the worker dies, even during an outstanding model request.
const hostDisconnected = () => process.exit(1);
process.stdin.once("end", hostDisconnected);
const job = await readInitialJob();
if (!/^[0-9a-f]{32}$/.test(job.id)) throw Error("Invalid run ID");

const allProviders = builtinProviders();
const models = createModels({
	credentials: runtimeCredentials(job.credentials ?? {}, allProviders, async (provider) => {
		const result = await callHostRpc("refresh_token", { provider });
		if (result.error) throw Error("Host could not renew OAuth token");
		return JSON.parse(result.text);
	}),
});
delete job.credentials;

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
			send({ progress: message });
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
	else send({ progress: line, ...(label ? { agent: label } : {}) });
};

const stageProgressLabel = job.check || job.orchestrator ? "orchestrator" : undefined;
const activeSubagents: Record<string, AgentRuntimeSpec> = { ...(job.agents ?? {}) };
const agentOutputs: Record<string, string> = {};
type BatchResult = {
	results: Array<{ agent: string; ok: boolean; output: string }>;
	cleanlinessWarning?: string;
};

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
		const res = await callHostRpc("check_clean", {});
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

const writeTool = defineTool({
	name: "write",
	description:
		"Create or overwrite a UTF-8 file. In read-only mode, writes are restricted to your agent scratch directory (/scratch/<agent>).",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Destination file path." },
			content: { type: "string", description: "Full UTF-8 file contents." },
		},
		required: ["path", "content"],
		additionalProperties: false,
	},
	callers: ["model"],
	execute: async (args, api) => {
		const { path, content } = args as { path: string; content: string };
		try {
			const resolved = resolveAgentPath(path, getAgentCtx(api.conversationId), true);
			fs.mkdirSync(dirname(resolved), { recursive: true });
			fs.writeFileSync(resolved, content, "utf8");
			return { output: [{ type: "text" as const, text: `Wrote ${content.length} chars to ${path}` }] };
		} catch (err) {
			return {
				output: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
				isError: true,
			};
		}
	},
});

const editTool = defineTool({
	name: "edit",
	description:
		"Replace an exact target string in an existing file. In read-only mode, edits are restricted to /scratch/<agent>.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "File path to modify." },
			target: { type: "string", description: "Exact substring to replace." },
			replacement: { type: "string", description: "Replacement text." },
			replaceAll: { type: "boolean", description: "Replace all occurrences instead of requiring a unique match." },
		},
		required: ["path", "target", "replacement"],
		additionalProperties: false,
	},
	callers: ["model"],
	execute: async (args, api) => {
		const {
			path,
			target,
			replacement,
			replaceAll = false,
		} = args as {
			path: string;
			target: string;
			replacement: string;
			replaceAll?: boolean;
		};
		try {
			if (!target.length) throw Error("target must not be empty");
			const resolved = resolveAgentPath(path, getAgentCtx(api.conversationId), true);
			const original = fs.readFileSync(resolved, "utf8");
			const first = original.indexOf(target);
			if (first < 0) throw Error("Target text not found in file");
			if (!replaceAll && original.indexOf(target, first + 1) >= 0)
				throw Error("Target text appears multiple times; provide more surrounding context or set replaceAll: true");
			const updated = replaceAll
				? original.replaceAll(target, () => replacement)
				: original.replace(target, () => replacement);
			fs.writeFileSync(resolved, updated, "utf8");
			return { output: [{ type: "text" as const, text: `Edited ${path}` }] };
		} catch (err) {
			return {
				output: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
				isError: true,
			};
		}
	},
});

const grepTool = defineTool({
	name: "grep",
	description:
		"Search for a literal substring or ripgrep regex. Directory searches respect .gitignore and skip .git and node_modules.",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Substring (or regex when regex=true) to match." },
			path: { type: "string", description: `Optional directory or file path (defaults to ${CONTAINER_REPO_DIR}).` },
			regex: { type: "boolean", description: "Use ripgrep's default regular expression syntax." },
			offset: { type: "integer", minimum: 0, description: "Character offset into results." },
		},
		required: ["pattern"],
		additionalProperties: false,
	},
	replay: "safe",
	execute: async (args, api, context) => {
		const {
			pattern,
			path = CONTAINER_REPO_DIR,
			regex = false,
			offset = 0,
		} = args as {
			pattern: string;
			path?: string;
			regex?: boolean;
			offset?: number;
		};
		try {
			const resolved = resolveAgentPath(path, getAgentCtx(api.conversationId), false);
			const info = await stat(resolved);
			const directory = info.isDirectory();
			if (!directory && !info.isFile()) throw Error("Search path must be a regular file or directory.");
			if (!directory && info.size > 2 * 1024 * 1024)
				return { output: [{ type: "text" as const, text: "(no matches)" }] };
			const matches: string[] = [];
			const end = offset + MAX_SEARCH_CHARS;
			let length = 0;
			const truncated = await scanRipgrep(
				directory ? resolved : dirname(resolved),
				[
					"--line-number",
					directory ? "--with-filename" : "--no-filename",
					"--color=never",
					"--max-columns=400",
					"--max-columns-preview",
					"--max-filesize=2M",
					...(regex ? [] : ["--fixed-strings"]),
					"-e",
					pattern,
					"--",
					directory ? "." : `./${basename(resolved)}`,
				],
				"\n",
				(line) => {
					if (!directory && !/^\d+:/.test(line)) return true; // ripgrep can report a binary file without a line number.
					if (matches.length === MAX_GREP_MATCHES) return false;
					const match = directory ? line.replace(/^\.\//, "") : `${path}:${line}`;
					length += match.length + (matches.length ? 1 : 0);
					matches.push(match);
					return length <= end;
				},
				context.abortSignal,
			);
			const text = matches.join("\n") || "(no matches)";
			const suffix =
				text.length > end
					? `\n[more at offset ${end}]`
					: truncated
						? "\n[More matches omitted; narrow the search.]"
						: "";
			const slice = text.slice(offset, end) + suffix;
			return { output: [{ type: "text" as const, text: slice }] };
		} catch (err) {
			return {
				output: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
				isError: true,
			};
		}
	},
});

const findTool = defineTool({
	name: "find",
	description: `List files under a directory (defaults to ${CONTAINER_REPO_DIR}), optionally matching a glob or substring. Respects .gitignore and skips .git and node_modules.`,
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: `Directory to search (defaults to ${CONTAINER_REPO_DIR}).` },
			query: { type: "string", description: "Optional glob pattern (e.g. '**/*.ts') or substring filter." },
			maxResults: { type: "integer", minimum: 1, maximum: 2000, description: "Max files to return (default 500)." },
		},
		additionalProperties: false,
	},
	replay: "safe",
	execute: async (args, api, context) => {
		const {
			path = CONTAINER_REPO_DIR,
			query,
			maxResults = MAX_FIND_RESULTS,
		} = args as {
			path?: string;
			query?: string;
			maxResults?: number;
		};
		try {
			const resolved = resolveAgentPath(path, getAgentCtx(api.conversationId), false);
			if (!(await stat(resolved)).isDirectory()) return { output: [{ type: "text" as const, text: "(no files)" }] };
			const glob = query && /[*?]/.test(query) ? globToRegExp(query) : null;
			const files: string[] = [];
			let length = 0;
			const truncated = await scanRipgrep(
				resolved,
				["--files", "--null", "--", "."],
				"\0",
				(entry) => {
					const file = entry.replace(/^\.\//, "");
					// Positive ripgrep globs override .gitignore, so filter after discovery.
					if (query && !(glob ? glob.test(file) : file.includes(query))) return true;
					const display = file.replaceAll("\n", "\\n").replaceAll("\r", "\\r");
					length += display.length + (files.length ? 1 : 0);
					if (files.length === maxResults || length > MAX_SEARCH_CHARS) return false;
					files.push(display);
					return true;
				},
				context.abortSignal,
			);
			const suffix = truncated ? "\n[More files omitted; narrow the search.]" : "";
			return { output: [{ type: "text" as const, text: (files.join("\n") || "(no files)") + suffix }] };
		} catch (err) {
			return {
				output: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
				isError: true,
			};
		}
	},
});

const execTool = defineTool({
	name: "exec",
	description: `Run a shell command inside a running project container (defaults to 'runner' at ${CONTAINER_REPO_DIR}). Returns exit status and output tail.`,
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "Shell command to execute inside the container." },
			service: { type: "string", description: "Compose service name (defaults to 'runner')." },
			workdir: { type: "string", description: `Working directory inside ${CONTAINER_REPO_DIR} or /scratch.` },
			timeout: { type: "integer", minimum: 1, maximum: 900, description: "Timeout in seconds (default 300)." },
		},
		required: ["command"],
		additionalProperties: false,
	},
	callers: ["model"],
	execute: async (args, api) => {
		const agentCtx = getAgentCtx(api.conversationId);
		const res = await callHostRpc("exec", args as Record<string, unknown>, agentCtx.name);
		return { output: [{ type: "text" as const, text: res.text }], isError: !!res.error };
	},
});

const logsTool = defineTool({
	name: "logs",
	description: "Fetch recent container logs from the running project Compose stack.",
	parameters: {
		type: "object",
		properties: {
			service: { type: "string", description: "Optional Compose service name." },
			tail: { type: "integer", minimum: 1, maximum: 2000, description: "Number of lines (default 200)." },
		},
		additionalProperties: false,
	},
	replay: "safe",
	execute: async (args, api) => {
		const agentCtx = getAgentCtx(api.conversationId);
		const res = await callHostRpc("logs", args as Record<string, unknown>, agentCtx.name);
		return { output: [{ type: "text" as const, text: res.text }], isError: !!res.error };
	},
});

const psTool = defineTool({
	name: "ps",
	description: "List running services and health statuses in the project Compose stack.",
	parameters: {
		type: "object",
		properties: {},
		additionalProperties: false,
	},
	replay: "safe",
	execute: async (_args, api) => {
		const agentCtx = getAgentCtx(api.conversationId);
		const res = await callHostRpc("ps", {}, agentCtx.name);
		return { output: [{ type: "text" as const, text: res.text }], isError: !!res.error };
	},
});

const restartTool = defineTool({
	name: "restart",
	description: "Restart a service in the project Compose stack.",
	parameters: {
		type: "object",
		properties: {
			service: { type: "string", description: "Compose service name to restart." },
		},
		required: ["service"],
		additionalProperties: false,
	},
	callers: ["model"],
	execute: async (args, api) => {
		const agentCtx = getAgentCtx(api.conversationId);
		const res = await callHostRpc("restart", args as Record<string, unknown>, agentCtx.name);
		return { output: [{ type: "text" as const, text: res.text }], isError: !!res.error };
	},
});

type DelegateTasks = Array<{ agent: string; prompt: string }>;
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

const delegateTool = defineTool({
	name: "delegate",
	replay: "unsafe",
	description:
		"Run one or more configured subagents in parallel and collect their results. Multiple read-only subagents may run concurrently; read-write subagents must run one at a time.",
	parameters: {
		type: "object",
		properties: {
			tasks: {
				type: "array",
				minItems: 1,
				maxItems: 16,
				items: {
					type: "object",
					properties: {
						agent: { type: "string", description: "Configured subagent name." },
						prompt: { type: "string", description: "Specific task or question for this subagent." },
					},
					required: ["agent", "prompt"],
					additionalProperties: false,
				},
			},
		},
		required: ["tasks"],
		additionalProperties: false,
	},
	callers: ["model"],
	execute: async (args, api) => {
		const caller = getAgentCtx(api.conversationId);
		if (caller.name !== "orchestrator") {
			return {
				output: [{ type: "text" as const, text: "Only the orchestrator may call delegate." }],
				isError: true,
			};
		}
		const { tasks } = args as { tasks: DelegateTasks };
		try {
			const id = await api.createTask(
				delegateBatch,
				tasks,
				{ ownership: { kind: "task", taskId: api.taskId }, abandonOnRestart: true },
				ctx,
			);
			const { outcome } = (await api.waitForTask(id, ctx)).state;
			if (outcome.status !== "completed") throw Error(outcome.error?.message ?? `Delegate batch ${outcome.status}`);
			const { results, cleanlinessWarning } = outcome.result;
			const sections = results.map((r) => `### Agent: ${r.agent} (${r.ok ? "ok" : "error"})\n\n${r.output}`);
			if (cleanlinessWarning) sections.push(`### Repository Cleanliness Warning\n\n${cleanlinessWarning}`);
			return { output: [{ type: "text" as const, text: sections.join("\n\n") }] };
		} catch (err) {
			return {
				output: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
				isError: true,
			};
		}
	},
});

const toolMap = new Map<string, ToolRegistration>([
	["read", createReadTool(CONTAINER_REPO_DIR, (path, id) => resolveAgentPath(path, getAgentCtx(id), false))],
	["write", writeTool],
	["edit", editTool],
	["grep", grepTool],
	["find", findTool],
	["exec", execTool],
	["logs", logsTool],
	["ps", psTool],
	["restart", restartTool],
	["delegate", delegateTool],
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
				} else if (call.name === "exec" && typeof call.arguments?.command === "string")
					emitProgress(`exec: ${JSON.stringify(call.arguments.command.slice(0, 200))}`, agentLabel);
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
	const prior = await storage.submissionByRequest(ROOT_CONVERSATION_ID, rootRequestId, ctx);
	if (prior?.status !== "unanswered") break;
	emitProgress(`Root attempt ${attempt} was unanswered: ${prior.reason}`, "orchestrator");
	continueRoot = prior.type === "continue" || prior.entry !== undefined;
	rootRequestId = `${turnKey}:retry:${attempt}`;
}
const h = await Harness.open(storage, { models, registry }, ctx);
// Scheduling can resume siblings as soon as the first input is submitted.
for (const [id, agent] of Object.entries((await h.snapshot(workflow, ctx))?.agents ?? {})) {
	agentByConv.set(Number(id) as ConversationId, {
		...agent,
		label: `agent:${agent.name}`,
		scratchDir: join(SCRATCH_DIR, agent.name),
	});
}

try {
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
			tools: ["read", "write", "find"],
		};

		for (const [path, data] of Object.entries({
			"probe.txt": "probe-workspace",
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
		const code = `const [a, b] = await Promise.all([tools.ps({}), tools.logs({ tail: 5 })]); return a + '|' + b;`;
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
							fauxToolCall("write", { path: "/scratch/checker-b/note.txt", content: "ok-b" }),
						],
						{ stopReason: "toolUse" },
					);
				}
				const results = transcript.messages.filter((m) => m.role === "toolResult" && !m.isError).map(msgText);
				const find =
					results.includes("z/.visible.ts") &&
					results.includes("000.txt\n[More files omitted; narrow the search.]");
				return fauxAssistantMessage([fauxText(find ? "subagent-b-ok" : "subagent-b-fail")]);
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
					msgText(toolResults[0]).includes("probe-ok:logs");
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
		send({ ready: true });
	} else {
		let report: string | undefined;
		try {
			report = await runAction();
		} finally {
			const usage = await h.usage(ctx).catch(() => {
				emitProgress("Warning: session usage snapshot unavailable");
				return undefined;
			});
			if (report !== undefined || usage) {
				send({ report, usage, ...(report && Object.keys(agentOutputs).length ? { outputs: agentOutputs } : {}) });
			}
		}
	}
} finally {
	process.stdin.off("end", hostDisconnected);
	rl.close();
	await sandbox.close();
	await h.close(ctx);
}

async function runAction(): Promise<string> {
	const spec = job.orchestrator;
	if (!job.prompt) throw Error("Missing prompt");
	if (!spec && (job.continueRun || job.stages?.at(-1)?.parallel.length !== 1))
		throw Error("A run without an orchestrator requires a single final agent and cannot continue");

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
				if (!agentSpec) throw Error(`Stage '${stage.name}' references missing agent '${agentName}'`);
				return { spec: agentSpec, prompt: stagePrompt, requireReport };
			});
			const { results, cleanlinessWarning } = await runParallelBatch(batch, `stage:${stage.name}`, {
				stageKey: `${job.requestId ?? job.id}:${index}:${stage.name}`,
			});
			const failures = results.filter((r) => !r.ok);
			if (failures.length) {
				const message = `Stage '${stage.name}' failed: ${failures.map((r) => r.agent).join(", ")}`;
				emitProgress(message, stageProgressLabel);
				throw Error(message);
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

	if (!spec) throw Error("Missing orchestrator");
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
		throw Error(`Task submission did not complete: ${settled.status}${settled.reason ? `: ${settled.reason}` : ""}`);
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
	const message = entry?.model?.[0];
	if (message?.role !== "assistant") throw Error("Missing assistant answer");
	const report = message.content
		.filter((b) => b.type === "text")
		.map((b) => b.text)
		.join("\n")
		.trim();
	if (!report) throw Error("Agent returned an empty report");
	return report;
}

await new Promise<void>((resolve, reject) => process.stdout.write("", (err) => (err ? reject(err) : resolve())));
process.exit(0);
