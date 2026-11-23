import * as fs from "node:fs";
import { dirname } from "node:path";
import { type ConversationId, defineTool } from "@earendil-works/pi-durable";

export function createWriteTool(resolvePath: (path: string, conversationId: ConversationId) => string) {
	return defineTool({
		name: "write",
		description:
			"Create or overwrite a UTF-8 file. In read-only mode, writes are restricted to your agent scratch directory (/scratch/<agent>).",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Destination file path." },
				content: { type: "string", description: "Full UTF-8 file contents." },
			},
			required: ["path", "content"],
			additionalProperties: false,
		},
		callers: ["model"],
		execute: async (args, api) => {
			const { path, content } = args as { path: string; content: string };
			try {
				const resolved = resolvePath(path, api.conversationId);
				fs.mkdirSync(dirname(resolved), { recursive: true });
				fs.writeFileSync(resolved, content, "utf8");
				return { output: [{ type: "text" as const, text: `Wrote ${content.length} chars to ${path}` }] };
			} catch (err) {
				return {
					output: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
					isError: true,
				};
			}
		},
	});
}
