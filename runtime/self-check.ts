import * as fs from "node:fs";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { AssistantEntry, type Harness } from "@earendil-works/pi-durable";
import { CONTAINER_REPO_DIR, WORKSPACE_DIR } from "./paths.ts";
import type { AgentRuntimeSpec } from "./protocol.ts";

export async function selfCheck(
	h: Harness,
	ctx: Context,
	models: MutableModels,
	activeSubagents: Record<string, AgentRuntimeSpec>,
	probeEvents: string[],
) {
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
	const code = `const [a, b, cmd] = await Promise.all([tools.ps({}), tools.logs({ tail: 5 }), tools.bash({command: "exit 7"})]); const edit = await tools.edit({path: "probe-edit.txt", edits: [{oldText: "before", newText: "after"}]}); return [a,b,edit, cmd.exitCode === 7 && !cmd.truncated && cmd.output === "probe-bash" ? "bash-ok" : "bash-failed"].join("|");`;
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
				fauxText(blockedWorkspace && readWorkspace && wroteScratch && grep ? "subagent-a-ok" : "subagent-a-fail"),
			]);
		}
		if (firstUser === "probe B") {
			if (last?.role === "user") {
				return fauxAssistantMessage(
					[
						fauxToolCall("find", { path: "probe-src", query: "**/*.ts", maxResults: 1 }),
						fauxToolCall("find", { path: "probe-src", maxResults: 1 }),
						fauxToolCall("codemode", {
							code: `// @options: {"max_output_tokens": 4}
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
				results.includes("z/.visible.ts") && results.includes("000.txt\n[More files omitted; narrow the search.]");
			return fauxAssistantMessage([
				fauxText(
					find && results.some((r) => r.includes("[Full output: /scratch/checker-b/pi-codemode-"))
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
}
