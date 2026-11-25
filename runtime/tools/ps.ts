import { defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { agentEnv } from "./agent-execution-env.ts";
import type { AgentRpc } from "./rpc.ts";

export function createPsTool(call: AgentRpc) {
	return defineTool({
		name: "ps",
		description: "List running services and health statuses in the project Compose stack.",
		parameters: obj({}),
		replay: "safe",
		execute: async (_args, api) => {
			const res = await call({ type: "ps" }, agentEnv(api).name);
			return { output: [{ type: "text" as const, text: res.text }], isError: !!res.error };
		},
	});
}
