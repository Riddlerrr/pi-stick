import { defineTool } from "@earendil-works/pi-durable";
import type { AgentRpc } from "./rpc.ts";

export function createPsTool(call: AgentRpc) {
	return defineTool({
		name: "ps",
		description: "List running services and health statuses in the project Compose stack.",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		replay: "safe",
		execute: async (_args, api) => {
			const res = await call("ps", {}, api.conversationId);
			return { output: [{ type: "text" as const, text: res.text }], isError: !!res.error };
		},
	});
}
