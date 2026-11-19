import { createInterface } from "node:readline";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Model } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
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

const ID = "gpt-6.2-sol",
	provider = "openai-codex";
const input = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const next = async () => {
	const { done, value } = await input.next();
	if (done) throw Error("Host launcher disconnected");
	return JSON.parse(value);
};
const send = (data: unknown) => console.log(JSON.stringify(data));
interface Job {
	id: string;
	model: Model<"openai-codex-responses">;
	instructions: string;
	prompt: string;
	token?: string;
	check?: boolean;
}
const job: Job = await next();
const p = openaiCodexProvider();
if (
	job.model.id !== ID ||
	job.model.provider !== provider ||
	job.model.api !== "openai-codex-responses" ||
	job.model.baseUrl !== p.baseUrl ||
	typeof job.token !== "string" ||
	!/^[0-9a-f]{32}$/.test(job.id)
)
	throw Error("Unexpected review configuration");
// Use the exact host catalog entry. This release predates 6.2-sol in its static list.
const credential = { type: "oauth" as const, access: job.token, refresh: "", expires: Date.now() + 3600_000 };
const models = createModels({
	credentials: {
		list: async () => [{ providerId: provider, type: "oauth" }],
		delete: async () => {
			throw Error("Reviewer credentials are read-only");
		},
		read: async (id) => (id === provider ? credential : undefined),
		modify: async (id, fn) => fn(id === provider ? credential : undefined),
	},
});
models.setProvider({ ...p, getModels: () => [job.model], getAllModels: () => [job.model] });
delete job.token;
if (!(job.check && credential.access === "offline-fixture") && !(await models.getAuth(provider))?.auth?.apiKey)
	throw Error("Pi subscription credential unavailable");
const registry = createRegistry();
let queue = Promise.resolve();
const names = {
	read: "Read committed text by repository-relative path, or @diff, @manifest, @threads, @discussion, @pr. Supply offset in characters.",
	search: "Search the committed checkout for a literal substring. Supply offset in characters.",
	test: "Run one affected committed test file in the project runner. Supply its exact repository-relative path.",
};
const probeEvents: string[] = [];
const progress = (line: string) => (job.check ? probeEvents.push(line) : send({ progress: line }));
registry.install(
	defineExtension({
		name: "pi-stick",
		hooks: [
			hook(GenerationTask, {
				afterResponse(message) {
					// The host displays the final answer once the report passes freshness checks.
					if (message.content.some((b) => b.type === "toolCall"))
						for (const b of message.content) if (b.type === "text" && b.text.trim()) progress(`Agent: ${b.text}`);
				},
			}),
			hook(ToolTask, {
				beforeTool(call) {
					if (call.parent) return;
					if (call.name === "codemode") progress("codemode");
					else if (Object.hasOwn(names, call.name) && typeof call.arguments?.value === "string")
						progress(`${call.name}: ${JSON.stringify(call.arguments.value.slice(0, 1024))}`);
				},
			}),
		],
		tools: Object.entries(names).map(([name, description]) =>
			defineTool({
				name,
				description,
				parameters: {
					type: "object",
					properties: { value: { type: "string" }, offset: { type: "integer", minimum: 0 } },
					required: ["value"],
					additionalProperties: false,
				},
				...(name === "test" ? { callers: ["model"] } : { replay: "safe" }),
				execute: async (args) => {
					const result = queue.then(async () => {
						if (job.check) return { output: [{ type: "text" as const, text: "offline fixture" }] };
						send({ tool: name, args });
						const response = await next();
						if (typeof response?.text !== "string") throw Error("Invalid tool reply from host");
						return { output: [{ type: "text" as const, text: response.text }], isError: !!response.error };
					});
					queue = result.then(
						() => {},
						() => {},
					);
					return result;
				},
			}),
		),
	}),
);
const sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
registry.install(createCodemodeExtension({ sandbox, models: false }));
const h = await Harness.open(await openNodeSqliteStorage(`/sessions/${job.id}.sqlite`), { models, registry }, ctx);
try {
	const c = await h.root(ctx, {
		agent: { model: { provider, modelId: ID }, instructions: job.instructions },
	});
	if (job.check) {
		// Exercise a complete tool/answer round trip in the candidate, never the subscription.
		const { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai");
		const faux = fauxProvider();
		models.setProvider(faux.provider);
		const code =
			"if (ALL_TOOLS.map(t=>t.name).sort().join(',') !== 'read,search') throw Error('unexpected tools'); return (await tools.read({value:'@manifest'})).toUpperCase()";
		faux.setResponses([
			fauxAssistantMessage([fauxText("Checking the manifest."), fauxToolCall("codemode", { code })], {
				stopReason: "toolUse",
			}),
			(transcript) => {
				const result = transcript.messages.at(-1);
				const ok =
					result?.role === "toolResult" &&
					!result.isError &&
					result.content.some((b) => b.type === "text" && b.text.includes("OFFLINE FIXTURE"));
				return fauxAssistantMessage([fauxText(ok ? "ready" : "Code Mode probe failed")]);
			},
		]);
		const d = await h.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: { provider: faux.provider.id, modelId: faux.getModel().id } },
			},
			ctx,
		);
		const sub = await d.submit({ type: "input", content: "Offline fixture" }, ctx);
		const s = await sub.wait(ctx);
		if (s.status !== "done" || s.type !== "input" || faux.state.callCount !== 2)
			throw Error(`Offline tool round trip failed: ${JSON.stringify({ settled: s, calls: faux.state.callCount })}`);
		const answer = await d.commit((tx) => tx.entry(AssistantEntry, s.answer), ctx);
		const message = answer?.model?.[0];
		if (message?.role !== "assistant" || !message.content.some((b) => b.type === "text" && b.text === "ready"))
			throw Error("Cannot extract the report");
		if (JSON.stringify(probeEvents) !== JSON.stringify(["Agent: Checking the manifest.", "codemode"]))
			throw Error("Unexpected CLI progress");
		send({ ready: true });
	} else {
		const request = await c.submit({ type: "input", content: job.prompt, requestId: job.id }, ctx);
		const settled = await request.wait(ctx);
		if (settled.status !== "done" || settled.type !== "input")
			throw Error(`Review submission did not complete: ${settled.status}`);
		const entry = await c.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
		const message = entry?.model?.[0];
		if (message?.role !== "assistant") throw Error("Missing assistant answer");
		const report = message.content
			.filter((b) => b.type === "text")
			.map((b) => b.text)
			.join("\n")
			.trim();
		if (!report) throw Error("Reviewer returned no report");
		send({ report });
	}
} finally {
	await sandbox.close();
	await h.close(ctx);
}
// Flush a potentially large final JSON line before exiting the SDK process.
await new Promise<void>((resolve, reject) => process.stdout.write("", (err) => (err ? reject(err) : resolve())));
process.exit(0);
