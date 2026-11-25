import { defineTool } from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";
import { agentEnv } from "./agent-execution-env.ts";
import type { AgentRpc } from "./rpc.ts";

export function createLogsTool(call: AgentRpc) {
	return defineTool({
		name: "logs",
		description: "Fetch recent container logs from the running project Compose stack.",
		parameters: obj({
			service: opt(str({ description: "Compose service name; omit to read logs from all permitted services." })),
			tail: opt(int({ minimum: 1, maximum: 2000, description: "Number of lines (default 200)." })),
		}),
		replay: "safe",
		execute: async (args, api) => {
			const res = await call({ ...args, type: "logs" }, agentEnv(api).name);
			return { output: [{ type: "text" as const, text: res.text }], isError: !!res.error };
		},
	});
}
