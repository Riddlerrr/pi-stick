import { stat } from "node:fs/promises";
import { type ConversationId, defineTool } from "@earendil-works/pi-durable";
import { MAX_SEARCH_CHARS, scanRipgrep } from "./ripgrep.ts";

const MAX_FIND_RESULTS = 500;

function globToRegExp(pattern: string): RegExp {
	let re = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*" && pattern[i + 1] === "*") {
			re += ".*";
			i++;
			if (pattern[i + 1] === "/") i++;
		} else if (ch === "*") {
			re += "[^/]*";
		} else if (ch === "?") {
			re += "[^/]";
		} else if ("\\^$+?.()|[]{}".includes(ch)) {
			re += `\\${ch}`;
		} else {
			re += ch;
		}
	}
	return new RegExp(`^${re}$`);
}

export function createFindTool(repoDir: string, resolvePath: (path: string, conversationId: ConversationId) => string) {
	return defineTool({
		name: "find",
		description: `List files under a directory (defaults to ${repoDir}), optionally matching a glob or substring. Respects .gitignore and skips .git and node_modules.`,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: `Directory to search (defaults to ${repoDir}).` },
				query: { type: "string", description: "Optional glob pattern (e.g. '**/*.ts') or substring filter." },
				maxResults: { type: "integer", minimum: 1, maximum: 2000, description: "Max files to return (default 500)." },
			},
			additionalProperties: false,
		},
		replay: "safe",
		execute: async (args, api, context) => {
			const {
				path = repoDir,
				query,
				maxResults = MAX_FIND_RESULTS,
			} = args as {
				path?: string;
				query?: string;
				maxResults?: number;
			};
			try {
				const resolved = resolvePath(path, api.conversationId);
				if (!(await stat(resolved)).isDirectory()) return { output: [{ type: "text" as const, text: "(no files)" }] };
				const glob = query && /[*?]/.test(query) ? globToRegExp(query) : null;
				const files: string[] = [];
				let length = 0;
				const truncated = await scanRipgrep(
					resolved,
					["--files", "--null", "--", "."],
					"\0",
					(entry) => {
						const file = entry.replace(/^\.\//, "");
						// Positive ripgrep globs override .gitignore, so filter after discovery.
						if (query && !(glob ? glob.test(file) : file.includes(query))) return true;
						const display = file.replaceAll("\n", "\\n").replaceAll("\r", "\\r");
						length += display.length + (files.length ? 1 : 0);
						if (files.length === maxResults || length > MAX_SEARCH_CHARS) return false;
						files.push(display);
						return true;
					},
					context.abortSignal,
				);
				const suffix = truncated ? "\n[More files omitted; narrow the search.]" : "";
				return { output: [{ type: "text" as const, text: (files.join("\n") || "(no files)") + suffix }] };
			} catch (err) {
				return {
					output: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }],
					isError: true,
				};
			}
		},
	});
}
