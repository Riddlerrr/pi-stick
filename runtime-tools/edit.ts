import { type ConversationId, defineTool } from "@earendil-works/pi-durable";
import { createEditTool as createPiEditTool } from "@earendil-works/pi-durable/tools";
import { AgentExecutionEnv } from "./agent-execution-env.ts";

const piEdit = createPiEditTool();

export function createEditTool(resolvePath: (path: string, conversationId: ConversationId) => string) {
	return defineTool({
		...piEdit,
		description: `${piEdit.description} In read-only mode, edits are restricted to your agent scratch directory.`,
		async execute(input, api, context) {
			context.abortSignal?.throwIfAborted();
			const env = new AgentExecutionEnv("/", (path) => resolvePath(path, api.conversationId));
			try {
				return await piEdit.execute(input, { ...api, env }, context);
			} finally {
				await env.closeEdit();
			}
		},
	});
}
