import * as fs from "node:fs";
import { type ConversationId, defineTool } from "@earendil-works/pi-durable";

const MAX_READ_CHARS = 32_000;

function isBinary(buf: Buffer): boolean {
	const len = Math.min(buf.length, 4096);
	for (let i = 0; i < len; i++) {
		if (buf[i] === 0) return true;
	}
	return false;
}

export function createReadTool(repoDir: string, resolvePath: (path: string, conversationId: ConversationId) => string) {
	return defineTool({
		name: "read",
		description: `Read a UTF-8 file or list a directory. Relative paths start at ${repoDir}; /scratch/... and /context/... are also readable.`,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "File or directory path." },
				offset: { type: "integer", minimum: 0, description: "Character offset to start reading from." },
				limit: { type: "integer", minimum: 1, maximum: 100000, description: "Max characters to return." },
			},
			required: ["path"],
			additionalProperties: false,
		},
		replay: "safe",
		execute: async (args, api) => {
			const {
				path,
				offset = 0,
				limit = MAX_READ_CHARS,
			} = args as {
				path: string;
				offset?: number;
				limit?: number;
			};
			try {
				const resolved = resolvePath(path, api.conversationId);
				const stat = fs.statSync(resolved);
				if (stat.isDirectory()) {
					const entries = fs
						.readdirSync(resolved, { withFileTypes: true })
						.sort((a, b) => a.name.localeCompare(b.name))
						.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
						.join("\n");
					return { output: [{ type: "text" as const, text: entries || "(empty directory)" }] };
				}
				const buf = fs.readFileSync(resolved);
				if (isBinary(buf))
					return {
						output: [{ type: "text" as const, text: "Binary file cannot be read as text." }],
						isError: true,
					};
				const text = buf.toString("utf8");
				const end = offset + Math.min(limit, 100_000);
				const slice = text.slice(offset, end) + (text.length > end ? `\n[more at offset ${end}]` : "");
				return { output: [{ type: "text" as const, text: slice }] };
			} catch (err) {
				return {
					output: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
					isError: true,
				};
			}
		},
	});
}
