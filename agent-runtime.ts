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

interface Job {
	id: string;
	check?: boolean;
	models?: Record<string, Model<Api>[]>;
	credentials?: Record<string, CredentialPayload>;
	orchestrator?: AgentRuntimeSpec;
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
	mode: job.orchestrator?.mode ?? "read-write",
	scratchDir: join(SCRATCH_DIR, "orchestrator"),
};
agentByConv.set(ROOT_CONVERSATION_ID, defaultAgentCtx);

function getAgentCtx(conversationId: ConversationId): AgentContext {
	return agentByConv.get(conversationId) ?? defaultAgentCtx;
}

const probeEvents: string[] = [];
const emitProgress = (line: string, agent?: string) => {
	if (job.check) probeEvents.push(agent ? `[${agent}] ${line}` : line);
	else send({ progress: line, ...(agent ? { agent } : {}) });
};

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
]);

const registry = createRegistry();
const mainExtension = defineExtension({
	name: "pi-stick",
	hooks: [
		hook(GenerationTask, {
			afterResponse(message, api) {
				const agentName = getAgentCtx(api.conversationId).name;
				if (message.content.some((b) => b.type === "toolCall")) {
					for (const b of message.content) {
						if (b.type === "text" && b.text.trim()) emitProgress(b.text.trim(), agentName);
					}
				}
			},
		}),
		hook(ToolTask, {
			beforeTool(call, api) {
				if (call.parent) return;
				const agentName = getAgentCtx(api.conversationId).name;
				if (call.name === "codemode") emitProgress("codemode", agentName);
				else if (call.name === "exec" && typeof call.arguments?.command === "string")
					emitProgress(`exec: ${JSON.stringify(call.arguments.command.slice(0, 200))}`, agentName);
				else if (typeof call.arguments?.path === "string")
					emitProgress(`${call.name}: ${JSON.stringify(call.arguments.path.slice(0, 200))}`, agentName);
				else emitProgress(call.name, agentName);
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

try {
	if (job.check) {
		// Offline self-check: exercise Codemode + multiplexed host RPC + SQLite durability without hitting any LLM.
		const { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai");
		const faux = fauxProvider();
		models.setProvider(faux.provider);
		const code = `const [a, b] = await Promise.all([tools.ps({}), tools.logs({ tail: 5 })]); return a + '|' + b;`;
		faux.setResponses([
			fauxAssistantMessage([fauxText("Probing runtime."), fauxToolCall("codemode", { code })], {
				stopReason: "toolUse",
			}),
			(transcript) => {
				const result = transcript.messages.at(-1);
				const ok =
					result?.role === "toolResult" &&
					!result.isError &&
					result.content.some(
						(b) => b.type === "text" && b.text.includes("probe-ok:ps") && b.text.includes("probe-ok:logs"),
					);
				return fauxAssistantMessage([fauxText(ok ? "ready" : "Self-check probe failed")]);
			},
		]);
		const conv = await h.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
			},
			ctx,
		);
		const sub = await conv.submit({ type: "input", content: "Offline self-check" }, ctx);
		const settled = await sub.wait(ctx);
		if (settled.status !== "done" || settled.type !== "input" || faux.state.callCount !== 2)
			throw Error(`Offline self-check failed: ${JSON.stringify({ settled, calls: faux.state.callCount })}`);
		const answer = await conv.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
		const message = answer?.model?.[0];
		if (message?.role !== "assistant" || !message.content.some((b) => b.type === "text" && b.text === "ready"))
			throw Error("Offline self-check did not produce expected answer");
		if (
			JSON.stringify(probeEvents) !== JSON.stringify(["[orchestrator] Probing runtime.", "[orchestrator] codemode"])
		)
			throw Error(`Unexpected probe progress events: ${JSON.stringify(probeEvents)}`);
		send({ ready: true });
	} else {
		const spec = job.orchestrator;
		if (!spec || !job.prompt) throw Error("Missing orchestrator configuration or prompt");
		fs.mkdirSync(defaultAgentCtx.scratchDir, { recursive: true });
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
		const sub = await root.submit({ type: "input", content: job.prompt, requestId: job.requestId ?? job.id }, ctx);
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
		send({ report });
	}
} finally {
	rl.close();
	await sandbox.close();
	await h.close(ctx);
}

await new Promise<void>((resolve, reject) => process.stdout.write("", (err) => (err ? reject(err) : resolve())));
process.exit(0);
