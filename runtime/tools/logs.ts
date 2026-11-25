import { defineTool } from "@earendil-works/pi-durable";
import type { AgentRpc } from "./rpc.ts";

export function createLogsTool(call: AgentRpc) {
	return defineTool({
		name: "logs",
		description: "Fetch recent container logs from the running project Compose stack.",
		parameters: {
			type: "object",
			properties: {
				service: {
					type: "string",
					description: "Compose service name; omit to read logs from all permitted services.",
				},
				tail: { type: "integer", minimum: 1, maximum: 2000, description: "Number of lines (default 200)." },
			},
			additionalProperties: false,
		},
		replay: "safe",
		execute: async (args, api) => {
			const res = await call({ ...(args as { service?: string; tail?: number }), type: "logs" }, api.conversationId);
			return { output: [{ type: "text" as const, text: res.text }], isError: !!res.error };
		},
	});
}
