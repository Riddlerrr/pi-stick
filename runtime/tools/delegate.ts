import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type ConversationId, defineTool, type Task } from "@earendil-works/pi-durable";

export type DelegateTasks = Array<{ agent: string; prompt: string }>;

export type BatchResult = {
	results: Array<{ agent: string; ok: boolean; output: string }>;
	cleanlinessWarning?: string;
};

export function createDelegateTool(
	delegateBatch: Task<DelegateTasks, { phase: "run" }, BatchResult, object>,
	isOrchestrator: (id: ConversationId) => boolean,
) {
	return defineTool({
		name: "delegate",
		executionMode: "sequential",
		replay: "unsafe",
		description:
			"Run one or more configured subagents in parallel and collect their results. Each agent may appear only once per call. Multiple read-only subagents may run concurrently; read-write subagents must run one at a time.",
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
			if (!isOrchestrator(api.conversationId)) {
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
