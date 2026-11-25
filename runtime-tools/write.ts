import { type ConversationId, defineTool } from "@earendil-works/pi-durable";
import { createWriteTool as createPiWriteTool } from "@earendil-works/pi-durable/tools";
import { AgentExecutionEnv } from "./agent-execution-env.ts";

const piWrite = createPiWriteTool();

export function createWriteTool(resolvePath: (path: string, conversationId: ConversationId) => string) {
	return defineTool({
		...piWrite,
		description: `${piWrite.description} In read-only mode, writes are restricted to your agent scratch directory.`,
		async execute(input, api, context) {
			context.abortSignal?.throwIfAborted();
			const env = new AgentExecutionEnv((path) => resolvePath(path, api.conversationId));
			return piWrite.execute(input, { ...api, env }, context);
		},
	});
}
