import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Api, Credential, Model } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
	AssistantEntry,
	createRegistry,
	defineExtension,
	defineTool,
	GenerationTask,
	Harness,
	hook,
	ToolTask,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const SESSIONS_DIR = process.env.PI_STICK_SESSIONS_DIR ?? "/sessions";

interface CredentialPayload {
	token: string;
	authType?: "oauth" | "api_key";
}

interface Job {
	id: string;
	check?: boolean;
	models?: Record<string, Model<Api>[]>;
	credentials?: Record<string, CredentialPayload>;
	model?: { provider: string; modelId: string };
	instructions?: string;
	prompt?: string;
	requestId?: string;
	allowedServices?: string[];
}

interface RpcResponseMessage {
	rpc: number;
	result?: { text: string; error?: boolean };
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
// Clear raw tokens from job payload immediately.
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

const probeEvents: string[] = [];
const emitProgress = (line: string, agent?: string) => {
	if (job.check) probeEvents.push(agent ? `[${agent}] ${line}` : line);
	else send({ progress: line, ...(agent ? { agent } : {}) });
};

const registry = createRegistry();

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
	callers: ["model", "tools"],
	execute: async (args) => {
		const res = await callHostRpc("exec", args as Record<string, unknown>);
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
	execute: async (args) => {
		const res = await callHostRpc("logs", args as Record<string, unknown>);
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
	execute: async () => {
		const res = await callHostRpc("ps", {});
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
	execute: async (args) => {
		const res = await callHostRpc("restart", args as Record<string, unknown>);
		return { output: [{ type: "text" as const, text: res.text }], isError: !!res.error };
	},
});

registry.install(
	defineExtension({
		name: "pi-stick",
		hooks: [
			hook(GenerationTask, {
				afterResponse(message) {
					if (message.content.some((b) => b.type === "toolCall")) {
						for (const b of message.content) {
							if (b.type === "text" && b.text.trim()) emitProgress(b.text.trim());
						}
					}
				},
			}),
			hook(ToolTask, {
				beforeTool(call) {
					if (call.parent) return;
					if (call.name === "codemode") emitProgress("codemode");
					else if (call.name === "exec" && typeof call.arguments?.command === "string")
						emitProgress(`exec: ${JSON.stringify(call.arguments.command.slice(0, 200))}`);
					else emitProgress(`${call.name}`);
				},
			}),
		],
		tools: [execTool, logsTool, psTool, restartTool],
	}),
);

const sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
registry.install(createCodemodeExtension({ sandbox, models: false }));

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
		if (JSON.stringify(probeEvents) !== JSON.stringify(["Probing runtime.", "codemode"]))
			throw Error(`Unexpected probe progress events: ${JSON.stringify(probeEvents)}`);
		send({ ready: true });
	} else {
		if (!job.model || !job.prompt) throw Error("Missing model or prompt in job configuration");
		const root = await h.root(ctx, {
			agent: { model: job.model, instructions: job.instructions },
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
