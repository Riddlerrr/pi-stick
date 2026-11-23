import { defineTool } from "@earendil-works/pi-durable";
import type { AgentRpc } from "./rpc.ts";

export function createBashTool(repoDir: string, call: AgentRpc) {
	return defineTool({
		name: "bash",
		description: `Run a Bash command (sh if Bash is unavailable) inside a running project container ('runner' at ${repoDir}). Returns exit status and output tail.`,
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to execute inside the container." },
				timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)." },
			},
			required: ["command"],
			additionalProperties: false,
		},
		callers: ["model"],
		execute: async (args, api) => {
			const res = await call("exec", args as Record<string, unknown>, api.conversationId);
			return { output: [{ type: "text" as const, text: res.text }], isError: !!res.error };
		},
	});
}
