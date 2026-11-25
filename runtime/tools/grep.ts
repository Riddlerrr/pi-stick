import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { defineTool } from "@earendil-works/pi-durable";
import { agentEnv } from "./agent-execution-env.ts";
import { MAX_SEARCH_CHARS, scanRipgrep } from "./ripgrep.ts";

const MAX_GREP_MATCHES = 2000;

export function createGrepTool(repoDir: string) {
	return defineTool({
		name: "grep",
		description:
			"Search for a literal substring or ripgrep regex. Directory searches respect .gitignore and skip .git and node_modules.",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Substring (or regex when regex=true) to match." },
				path: { type: "string", description: `Optional directory or file path (defaults to ${repoDir}).` },
				regex: { type: "boolean", description: "Use ripgrep's default regular expression syntax." },
				offset: { type: "integer", minimum: 0, description: "Character offset into results." },
			},
			required: ["pattern"],
			additionalProperties: false,
		},
		replay: "safe",
		execute: async (args, api, context) => {
			const {
				pattern,
				path = repoDir,
				regex = false,
				offset = 0,
			} = args as {
				pattern: string;
				path?: string;
				regex?: boolean;
				offset?: number;
			};
			try {
				const resolved = agentEnv(api).resolve(path, false);
				const info = await stat(resolved);
				const directory = info.isDirectory();
				if (!directory && !info.isFile()) throw Error("Search path must be a regular file or directory.");
				if (!directory && info.size > 2 * 1024 * 1024)
					return { output: [{ type: "text" as const, text: "(no matches)" }] };
				const matches: string[] = [];
				const end = offset + MAX_SEARCH_CHARS;
				let length = 0;
				const truncated = await scanRipgrep(
					directory ? resolved : dirname(resolved),
					[
						"--line-number",
						directory ? "--with-filename" : "--no-filename",
						"--color=never",
						"--max-columns=400",
						"--max-columns-preview",
						"--max-filesize=2M",
						...(regex ? [] : ["--fixed-strings"]),
						"-e",
						pattern,
						"--",
						directory ? "." : `./${basename(resolved)}`,
					],
					"\n",
					(line) => {
						if (!directory && !/^\d+:/.test(line)) return true; // ripgrep can report a binary file without a line number.
						if (matches.length === MAX_GREP_MATCHES) return false;
						const match = directory ? line.replace(/^\.\//, "") : `${path}:${line}`;
						length += match.length + (matches.length ? 1 : 0);
						matches.push(match);
						return length <= end;
					},
					context.abortSignal,
				);
				const text = matches.join("\n") || "(no matches)";
				const suffix =
					text.length > end
						? `\n[more at offset ${end}]`
						: truncated
							? "\n[More matches omitted; narrow the search.]"
							: "";
				const slice = text.slice(offset, end) + suffix;
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
