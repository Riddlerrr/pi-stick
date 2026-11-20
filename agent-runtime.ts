import * as fs from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Api, Credential, Model } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
	AssistantEntry,
	type ConversationId,
	createRegistry,
	defineExtension,
	defineTool,
	GenerationTask,
	Harness,
	hook,
	ROOT_CONVERSATION_ID,
	type ToolRegistration,
	ToolTask,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const SESSIONS_DIR = process.env.PI_STICK_SESSIONS_DIR ?? "/sessions";
const WORKSPACE_DIR = process.env.PI_STICK_WORKSPACE_DIR ?? "/workspace";
const SCRATCH_DIR = process.env.PI_STICK_SCRATCH_DIR ?? "/scratch";
const CONTEXT_DIR = process.env.PI_STICK_CONTEXT_DIR ?? "/context";
const MAX_READ_CHARS = 32_000;
const MAX_FIND_RESULTS = 500;
const SKIP_DIRS = new Set([".git", "node_modules"]);

interface CredentialPayload {
	token: string;
	authType?: "oauth" | "api_key";
}

interface AgentRuntimeSpec {
	name: string;
	description?: string;
	model: { provider: string; modelId: string };
	instructions: string;
	mode: "read-only" | "read-write";
	tools: string[];
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
	const sub =
		rawPath === "/workspace" ? "" : rawPath.startsWith("/workspace/") ? rawPath.slice("/workspace/".length) : rawPath;
	if (isAbsolute(sub)) throw Error("Absolute paths must be under /workspace, /scratch, or /context");
	if (forWrite && agentCtx.mode === "read-only") {
		throw Error(
			`Write/edit in /workspace is disabled in read-only mode. Write temporary files under /scratch/${agentCtx.name} instead.`,
		);
	}
	return assertWithin(resolve(WORKSPACE_DIR, sub), WORKSPACE_DIR, "workspace");
}

function isBinary(buf: Buffer): boolean {
	const len = Math.min(buf.length, 4096);
	for (let i = 0; i < len; i++) {
		if (buf[i] === 0) return true;
	}
	return false;
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

function walkFiles(dir: string, root: string, out: string[], limit: number) {
	if (out.length >= limit) return;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (out.length >= limit) return;
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walkFiles(join(dir, entry.name), root, out, limit);
		} else if (entry.isFile()) {
			out.push(relative(root, join(dir, entry.name)));
		}
	}
}

const job = await readInitialJob();
if (!/^[0-9a-f]{32}$/.test(job.id)) throw Error("Invalid run ID");

const credentialMap = new Map<string, Credential>();
const allProviders = builtinProviders();
const providerById = new Map(allProviders.map((p) => [p.id, p]));

for (const [providerId, payload] of Object.entries(job.credentials ?? {})) {
	const provider = providerById.get(providerId);
	const useOAuth =
		payload.authType === "oauth" ||
		(payload.authType !== "api_key" && !provider?.auth.apiKey && !!provider?.auth.oauth);
	if (useOAuth) {
		credentialMap.set(providerId, {
			type: "oauth",
			access: payload.token,
			refresh: "",
			expires: Date.now() + 3600_000,
		});
	} else {
		credentialMap.set(providerId, {
			type: "api_key",
			key: payload.token,
		});
	}
}
delete job.credentials;

const models = createModels({
	credentials: {
		list: async () => [...credentialMap.entries()].map(([providerId, cred]) => ({ providerId, type: cred.type })),
		delete: async () => {
			throw Error("Agent runtime credentials are read-only");
		},
		read: async (id) => credentialMap.get(id),
		modify: async (id, fn) => fn(credentialMap.get(id)),
	},
});

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

const activeSubagents: Record<string, AgentRuntimeSpec> = { ...(job.agents ?? {}) };
const agentOutputs: Record<string, string> = {};
let activeHarness: Harness | undefined;

function recordAgentOutput(agentName: string, text: string) {
	if (agentOutputs[agentName]) agentOutputs[agentName] = `${agentOutputs[agentName]}\n\n---\n\n${text}`;
	else agentOutputs[agentName] = text;
}

async function runSubagent(
	spec: AgentRuntimeSpec,
	promptText: string,
): Promise<{ agent: string; ok: boolean; output: string }> {
	if (!activeHarness) throw Error("Harness not initialized");
	const scratchDir = join(SCRATCH_DIR, spec.name);
	fs.mkdirSync(scratchDir, { recursive: true });
	const subTools = spec.tools.filter((t) => t !== "delegate");
	const { extensions, tools } = selectToolsAndExtensions(subTools);
	const conv = await activeHarness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: {
				model: spec.model,
				instructions: spec.instructions,
				extensions,
				tools,
				...(spec.maxTurns ? { maxTurns: spec.maxTurns } : {}),
			},
		},
		ctx,
	);
	const label = `agent:${spec.name}`;
	agentByConv.set(conv.id, {
		name: spec.name,
		label,
		mode: spec.mode,
		scratchDir,
	});
	emitProgress("started", label);
	try {
		const sub = await conv.submit({ type: "input", content: promptText }, ctx);
		const settled = await sub.wait(ctx);
		if (settled.status !== "done" || settled.type !== "input") {
			const msg = `Subagent '${spec.name}' did not complete (${settled.status})`;
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
		const final = text || "(empty output)";
		recordAgentOutput(spec.name, final);
		emitProgress("completed", label);
		return { agent: spec.name, ok: true, output: final };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		emitProgress(`error: ${msg}`, label);
		return { agent: spec.name, ok: false, output: `Error: ${msg}` };
	}
}

async function runParallelBatch(
	batch: Array<{ spec: AgentRuntimeSpec; prompt: string }>,
	batchLabel: string,
): Promise<{ results: Array<{ agent: string; ok: boolean; output: string }>; cleanlinessWarning?: string }> {
	const rwCount = batch.filter((b) => b.spec.mode === "read-write").length;
	if (rwCount > 1) {
		throw Error(
			`Cannot run ${rwCount} read-write subagents in parallel in '${batchLabel}'; run read-write subagents sequentially or use read-only subagents for parallel execution.`,
		);
	}
	const allReadOnly = batch.every((b) => b.spec.mode === "read-only");
	let beforeClean: string | undefined;
	if (allReadOnly) {
		const res = await callHostRpc("check_clean", {});
		if (!res.error) beforeClean = res.text;
	}
	const results = await Promise.all(batch.map((item) => runSubagent(item.spec, item.prompt)));
	let cleanlinessWarning: string | undefined;
	if (allReadOnly && beforeClean !== undefined) {
		const after = await callHostRpc("check_clean", {});
		if (!after.error && after.text !== beforeClean) {
			cleanlinessWarning = `WARNING: Tracked repository files changed during read-only round '${batchLabel}':\n${after.text.trim()}`;
			emitProgress(cleanlinessWarning, "orchestrator");
		}
	}
	return { results, cleanlinessWarning };
}

const readTool = defineTool({
	name: "read",
	description:
		"Read a UTF-8 file or list a directory. Paths default to /workspace; /scratch/... and /context/... are also readable.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "File or directory path." },
			offset: { type: "integer", minimum: 0, description: "Character offset to start reading from." },
			limit: { type: "integer", minimum: 1, maximum: 100000, description: "Max characters to return." },
		},
		required: ["path"],
		additionalProperties: false,
	},
	replay: "safe",
	execute: async (args, api) => {
		const {
			path,
			offset = 0,
			limit = MAX_READ_CHARS,
		} = args as {
			path: string;
			offset?: number;
			limit?: number;
		};
		try {
			const resolved = resolveAgentPath(path, getAgentCtx(api.conversationId), false);
			const stat = fs.statSync(resolved);
			if (stat.isDirectory()) {
				const entries = fs
					.readdirSync(resolved, { withFileTypes: true })
					.sort((a, b) => a.name.localeCompare(b.name))
					.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
					.join("\n");
				return { output: [{ type: "text" as const, text: entries || "(empty directory)" }] };
			}
			const buf = fs.readFileSync(resolved);
			if (isBinary(buf))
				return { output: [{ type: "text" as const, text: "Binary file cannot be read as text." }], isError: true };
			const text = buf.toString("utf8");
			const end = offset + Math.min(limit, 100_000);
			const slice = text.slice(offset, end) + (text.length > end ? `\n[more at offset ${end}]` : "");
			return { output: [{ type: "text" as const, text: slice }] };
		} catch (err) {
			return {
				output: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
				isError: true,
			};
		}
	},
});

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
	description: "Search files for a literal substring or regular expression. Skips .git and node_modules.",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Substring (or regex when regex=true) to match." },
			path: { type: "string", description: "Optional directory or file path (defaults to /workspace)." },
			regex: { type: "boolean", description: "Interpret pattern as a regular expression." },
			offset: { type: "integer", minimum: 0, description: "Character offset into results." },
		},
		required: ["pattern"],
		additionalProperties: false,
	},
	replay: "safe",
	execute: async (args, api) => {
		const {
			pattern,
			path = "/workspace",
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
			const matcher = regex ? new RegExp(pattern) : null;
			const matches: string[] = [];
			const stat = fs.statSync(resolved);
			const files = stat.isDirectory() ? [] : [""];
			if (stat.isDirectory()) walkFiles(resolved, resolved, files, 5000);
			for (const rel of files) {
				const full = rel ? join(resolved, rel) : resolved;
				let buf: Buffer;
				try {
					const st = fs.statSync(full);
					if (st.size > 2 * 1024 * 1024) continue;
					buf = fs.readFileSync(full);
				} catch {
					continue;
				}
				if (isBinary(buf)) continue;
				const lines = buf.toString("utf8").split("\n");
				const label = rel || path;
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					if (matcher ? matcher.test(line) : line.includes(pattern)) {
						matches.push(`${label}:${i + 1}:${line.slice(0, 400)}`);
						if (matches.length >= 2000) break;
					}
				}
				if (matches.length >= 2000) break;
			}
			const text = matches.join("\n") || "(no matches)";
			const end = offset + MAX_READ_CHARS;
			const slice = text.slice(offset, end) + (text.length > end ? `\n[more at offset ${end}]` : "");
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
	description: "List files under a directory (defaults to /workspace), optionally matching a glob or substring.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Directory to search (defaults to /workspace)." },
			query: { type: "string", description: "Optional glob pattern (e.g. '**/*.ts') or substring filter." },
			maxResults: { type: "integer", minimum: 1, maximum: 2000, description: "Max files to return (default 500)." },
		},
		additionalProperties: false,
	},
	replay: "safe",
	execute: async (args, api) => {
		const {
			path = "/workspace",
			query,
			maxResults = MAX_FIND_RESULTS,
		} = args as {
			path?: string;
			query?: string;
			maxResults?: number;
		};
		try {
			const resolved = resolveAgentPath(path, getAgentCtx(api.conversationId), false);
			const files: string[] = [];
			walkFiles(resolved, resolved, files, 10_000);
			let filtered = files;
			if (query) {
				if (/[*?]/.test(query)) {
					const re = globToRegExp(query);
					filtered = files.filter((f) => re.test(f));
				} else {
					filtered = files.filter((f) => f.includes(query));
				}
			}
			const sliced = filtered.slice(0, maxResults);
			const suffix = filtered.length > maxResults ? `\n[${filtered.length - maxResults} more files omitted]` : "";
			return { output: [{ type: "text" as const, text: (sliced.join("\n") || "(no files)") + suffix }] };
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
	description:
		"Run a shell command inside a running project container (defaults to 'runner' at /workspace/repo). Returns exit status and output tail.",
	parameters: {
		type: "object",
		properties: {
			command: { type: "string", description: "Shell command to execute inside the container." },
			service: { type: "string", description: "Compose service name (defaults to 'runner')." },
			workdir: { type: "string", description: "Working directory inside /workspace/repo or /scratch." },
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

const delegateTool = defineTool({
	name: "delegate",
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
		const { tasks } = args as { tasks: Array<{ agent: string; prompt: string }> };
		try {
			const batch: Array<{ spec: AgentRuntimeSpec; prompt: string }> = [];
			for (const t of tasks) {
				const spec = activeSubagents[t.agent];
				if (!spec) {
					const available = Object.keys(activeSubagents).join(", ") || "(none)";
					throw Error(`Unknown subagent '${t.agent}'. Available: ${available}`);
				}
				batch.push({ spec, prompt: t.prompt });
			}
			const { results, cleanlinessWarning } = await runParallelBatch(batch, "delegate");
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
	["read", readTool],
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

const h = await Harness.open(
	await openNodeSqliteStorage(`${SESSIONS_DIR}/${job.id}.sqlite`),
	{ models, registry },
	ctx,
);
activeHarness = h;

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
			tools: ["read", "write"],
		};

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
					// Verify read-only subagent is blocked from writing to /workspace AND allowed to write to /scratch/checker-a
					return fauxAssistantMessage(
						[
							fauxToolCall("write", { path: "/workspace/should-fail.txt", content: "nope" }),
							fauxToolCall("write", { path: "/scratch/checker-a/note.txt", content: "ok-a" }),
						],
						{ stopReason: "toolUse" },
					);
				}
				const results = transcript.messages.filter((m) => m.role === "toolResult");
				const blockedWorkspace = results.some((r) => r.isError && msgText(r).includes("read-only"));
				const wroteScratch = results.some((r) => !r.isError);
				return fauxAssistantMessage([
					fauxText(blockedWorkspace && wroteScratch ? "subagent-a-ok" : "subagent-a-fail"),
				]);
			}
			if (firstUser === "probe B") {
				if (last?.role === "user") {
					return fauxAssistantMessage(
						[fauxToolCall("write", { path: "/scratch/checker-b/note.txt", content: "ok-b" })],
						{ stopReason: "toolUse" },
					);
				}
				return fauxAssistantMessage([fauxText("subagent-b-ok")]);
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
		const spec = job.orchestrator;
		if (!spec || !job.prompt) throw Error("Missing orchestrator configuration or prompt");
		fs.mkdirSync(defaultAgentCtx.scratchDir, { recursive: true });

		let finalPrompt = job.prompt;
		if (!job.continueRun && job.stages?.length) {
			const stageSections: string[] = [];
			for (const stage of job.stages) {
				emitProgress(`Starting parallel stage '${stage.name}': ${stage.parallel.join(", ")}`, "orchestrator");
				const stagePrompt = stage.prompt ? `${stage.prompt}\n\nTask context:\n${job.prompt}` : job.prompt;
				const batch = stage.parallel.map((agentName) => {
					const agentSpec = activeSubagents[agentName];
					if (!agentSpec) throw Error(`Stage '${stage.name}' references missing agent '${agentName}'`);
					return { spec: agentSpec, prompt: stagePrompt };
				});
				const { results, cleanlinessWarning } = await runParallelBatch(batch, `stage:${stage.name}`);
				const lines = [`## Stage: ${stage.name}`];
				for (const r of results) {
					lines.push(`### Agent: ${r.agent} (${r.ok ? "ok" : "error"})\n\n${r.output}`);
				}
				if (cleanlinessWarning) lines.push(`### Repository Cleanliness Warning\n\n${cleanlinessWarning}`);
				stageSections.push(lines.join("\n\n"));
			}
			finalPrompt = `${job.prompt}\n\n---\n\n# Parallel Stage Results\n\n${stageSections.join("\n\n")}`;
		}

		const { extensions, tools } = selectToolsAndExtensions(spec.tools);
		const root = await h.root(ctx, {
			agent: {
				model: spec.model,
				instructions: spec.instructions,
				extensions,
				tools,
				...(spec.maxTurns ? { maxTurns: spec.maxTurns } : {}),
			},
		});
		const sub = await root.submit({ type: "input", content: finalPrompt, requestId: job.requestId ?? job.id }, ctx);
		const settled = await sub.wait(ctx);
		if (settled.status !== "done" || settled.type !== "input")
			throw Error(`Task submission did not complete: ${settled.status}`);
		const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
		const message = entry?.model?.[0];
		if (message?.role !== "assistant") throw Error("Missing assistant answer");
		const report = message.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
		if (!report) throw Error("Agent returned an empty report");
		send({ report, ...(Object.keys(agentOutputs).length ? { outputs: agentOutputs } : {}) });
	}
} finally {
	rl.close();
	await sandbox.close();
	await h.close(ctx);
}

await new Promise<void>((resolve, reject) => process.stdout.write("", (err) => (err ? reject(err) : resolve())));
process.exit(0);
