import { stat } from "node:fs/promises";
import { defineTool } from "@earendil-works/pi-durable";
import { arr, bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import { agentEnv } from "./agent-execution-env.ts";
import { MAX_SEARCH_CHARS, scanRipgrep } from "./ripgrep.ts";

export function createFindTool(repoDir: string) {
	return defineTool({
		name: "find",
		description:
			"List relative file paths under a directory. Respects .gitignore and skips .git and node_modules. Narrow the search if truncated.",
		parameters: obj({
			path: opt(str({ description: `Directory to search (defaults to ${repoDir}).` })),
			query: opt(str({ description: "Literal substring of the relative path." })),
			maxResults: opt(int({ minimum: 1, maximum: 2000, description: "Max files to return (default 500)." })),
		}),
		structuredOutputSchema: obj({ files: arr(str()), truncated: bool() }),
		replay: "safe",
		execute: async ({ path = repoDir, query = "", maxResults = 500 }, api, context) => {
			const resolved = agentEnv(api).resolve(path, false);
			const files: string[] = [];
			let listing = "";
			const truncated =
				(await stat(resolved)).isDirectory() &&
				(await scanRipgrep(
					resolved,
					["--files", "--null", "--", "."],
					"\0",
					(entry) => {
						const file = entry.replace(/^\.\//, "");
						if (!file.includes(query)) return true;
						const line = (files.length ? "\n" : "") + file.replaceAll("\n", "\\n").replaceAll("\r", "\\r");
						if (files.length === maxResults || listing.length + line.length > MAX_SEARCH_CHARS) return false;
						listing += line;
						files.push(file);
						return true;
					},
					context.abortSignal,
				));
			const text = (listing || "(no files)") + (truncated ? "\n[More files omitted; narrow the search.]" : "");
			return { output: [{ type: "text", text }], structuredOutput: { files, truncated } };
		},
	});
}
