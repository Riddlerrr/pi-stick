import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { defineTool } from "@earendil-works/pi-durable";
import { arr, bool, obj, opt, str } from "@earendil-works/pi-schema";
import { agentEnv } from "./agent-execution-env.ts";
import { MAX_SEARCH_CHARS, scanRipgrep } from "./ripgrep.ts";

const MAX_GREP_MATCHES = 2000;

export function createGrepTool(repoDir: string) {
	return defineTool({
		name: "grep",
		description:
			"Search for a literal substring or ripgrep regex. Directory searches respect .gitignore and skip .git and node_modules. Narrow the search if truncated.",
		parameters: obj({
			pattern: str({ description: "Substring (or regex when regex=true) to match." }),
			path: opt(str({ description: `Directory or file to search (defaults to ${repoDir}).` })),
			regex: opt(bool({ description: "Use ripgrep's default regular expression syntax." })),
		}),
		structuredOutputSchema: obj({ matches: arr(str()), truncated: bool() }),
		replay: "safe",
		execute: async ({ pattern, path = repoDir, regex = false }, api, context) => {
			const resolved = agentEnv(api).resolve(path, false);
			const info = await stat(resolved);
			const directory = info.isDirectory();
			if (!directory && !info.isFile()) throw Error("Search path must be a regular file or directory.");
			const matches: string[] = [];
			let length = 0;
			const truncated =
				(directory || info.size <= 2 * 1024 * 1024) &&
				(await scanRipgrep(
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
						const match = directory ? line.replace(/^\.\//, "") : `${path}:${line}`;
						length += match.length + (matches.length ? 1 : 0);
						if (matches.length === MAX_GREP_MATCHES || length > MAX_SEARCH_CHARS) return false;
						matches.push(match);
						return true;
					},
					context.abortSignal,
				));
			const text =
				(matches.join("\n") || "(no matches)") + (truncated ? "\n[More matches omitted; narrow the search.]" : "");
			return { output: [{ type: "text", text }], structuredOutput: { matches, truncated } };
		},
	});
}
