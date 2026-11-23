import { defineTool } from "@earendil-works/pi-durable";
import type { AgentRpc } from "./rpc.ts";

export function createRestartTool(call: AgentRpc) {
	return defineTool({
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
			const res = await call("restart", args as Record<string, unknown>, api.conversationId);
			return { output: [{ type: "text" as const, text: res.text }], isError: !!res.error };
		},
	});
}
