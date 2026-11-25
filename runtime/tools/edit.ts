import { createEditTool } from "@earendil-works/pi-durable/tools";
import { agentEnv } from "./agent-execution-env.ts";

export const editTool = createEditTool();

export function withEditHandle(edit: typeof editTool): typeof editTool {
	return {
		...edit,
		description: `${edit.description} In read-only mode, edits are restricted to your agent scratch directory.`,
		async execute(input, api, context) {
			const env = agentEnv(api);
			try {
				return await edit.execute(input, api, context);
			} finally {
				await env.cleanup();
			}
		},
	};
}
