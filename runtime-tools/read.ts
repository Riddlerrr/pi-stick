import { type ConversationId, defineTool } from "@earendil-works/pi-durable";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { createReadTool as createPiReadTool } from "@earendil-works/pi-durable/tools";

import { AgentExecutionEnv } from "./agent-execution-env.ts";

const piRead = createPiReadTool({ images: await createNodePhotonImages() });

export function createReadTool(repoDir: string, resolvePath: (path: string, conversationId: ConversationId) => string) {
	return defineTool({
		...piRead,
		description: `${piRead.description} Use bash or find for directories. Relative paths start at ${repoDir}; /scratch/... and /context/... are also readable.`,
		replay: "safe",
		execute: async (args, api, context) => {
			const resolve = (path: string) => resolvePath(path, api.conversationId);
			context.abortSignal?.throwIfAborted();
			const env = new AgentExecutionEnv(repoDir, resolve);
			const result = await piRead.execute(args, { ...api, env }, context);
			if (!("structuredOutput" in result)) return result;
			const value = result.structuredOutput;
			const note = result.diagnostics?.map((d) => d.message).join("\n");
			if (typeof value === "string" && note) return { ...result, structuredOutput: `${value}\n\n[${note}]` };
			if (value && typeof value === "object" && !Array.isArray(value) && value.type === "image")
				return { ...result, structuredOutput: { ...value, note: note ?? "" } };
			return result;
		},
	});
}
