import * as fs from "node:fs";
import { type ConversationId, defineTool } from "@earendil-works/pi-durable";

export function createEditTool(resolvePath: (path: string, conversationId: ConversationId) => string) {
	return defineTool({
		name: "edit",
		description:
			"Replace an exact target string in an existing file. In read-only mode, edits are restricted to /scratch/<agent>.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path to modify." },
				target: { type: "string", description: "Exact substring to replace." },
				replacement: { type: "string", description: "Replacement text." },
				replaceAll: {
					type: "boolean",
					description: "Replace all occurrences instead of requiring a unique match.",
				},
			},
			required: ["path", "target", "replacement"],
			additionalProperties: false,
		},
		callers: ["model"],
		execute: async (args, api) => {
			const {
				path,
				target,
				replacement,
				replaceAll = false,
			} = args as {
				path: string;
				target: string;
				replacement: string;
				replaceAll?: boolean;
			};
			try {
				if (!target.length) throw Error("target must not be empty");
				const resolved = resolvePath(path, api.conversationId);
				const original = fs.readFileSync(resolved, "utf8");
				const first = original.indexOf(target);
				if (first < 0) throw Error("Target text not found in file");
				if (!replaceAll && original.indexOf(target, first + 1) >= 0)
					throw Error(
						"Target text appears multiple times; provide more surrounding context or set replaceAll: true",
					);
				const updated = replaceAll
					? original.replaceAll(target, () => replacement)
					: original.replace(target, () => replacement);
				fs.writeFileSync(resolved, updated, "utf8");
				return { output: [{ type: "text" as const, text: `Edited ${path}` }] };
			} catch (err) {
				return {
					output: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
					isError: true,
				};
			}
		},
	});
}
