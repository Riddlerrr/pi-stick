import { defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { agentEnv } from "./agent-execution-env.ts";
import type { AgentRpc } from "./rpc.ts";

export function createRestartTool(call: AgentRpc) {
	return defineTool({
		name: "restart",
		description: "Restart a service in the project Compose stack.",
		parameters: obj({ service: str({ description: "Compose service name to restart." }) }),
		callers: ["model"],
		execute: async (args, api) => {
			const res = await call({ ...args, type: "restart" }, agentEnv(api).name);
			return { output: [{ type: "text" as const, text: res.text }], isError: !!res.error };
		},
	});
}
