import { defineTool, ROOT_CONVERSATION_ID, type Task } from "@earendil-works/pi-durable";
import { arr, obj, type Static, str } from "@earendil-works/pi-schema";

const delegateTasks = arr(
	obj({
		agent: str({ description: "Configured subagent name." }),
		prompt: str({ description: "Specific task or question for this subagent." }),
	}),
	{ minItems: 1, maxItems: 16 },
);
export type DelegateTasks = Static<typeof delegateTasks>;

export type BatchResult = {
	results: Array<{ agent: string; ok: boolean; output: string }>;
	cleanlinessWarning?: string;
};

export function createDelegateTool<S extends { phase: string }>(
	delegateBatch: Task<DelegateTasks, S, BatchResult, object>,
) {
	return defineTool({
		name: "delegate",
		executionMode: "sequential",
		replay: "safe",
		description:
			"Run one or more configured subagents in parallel and collect their results. Each agent may appear only once per call. Multiple read-only subagents may run concurrently; read-write subagents must run one at a time.",
		parameters: obj({ tasks: delegateTasks }),
		callers: ["model"],
		execute: async ({ tasks }, api, ctx) => {
			if (api.conversationId !== ROOT_CONVERSATION_ID) {
				return {
					output: [{ type: "text" as const, text: "Only the orchestrator may call delegate." }],
					isError: true,
				};
			}
			try {
				const id = await api.createTask(
					delegateBatch,
					tasks,
					{ ownership: { kind: "task", taskId: api.taskId }, key: "batch" },
					ctx,
				);
				if (!api.wake) return { kind: "wait", on: [id], policy: "allSettled" };
				const { outcome } = (await api.waitForTask(id, ctx)).state;
				if (outcome.status !== "completed")
					throw Error(outcome.error?.message ?? `Delegate batch ${outcome.status}`);
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
}
