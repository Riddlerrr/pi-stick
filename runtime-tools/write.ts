import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { createWriteTool as createPiWriteTool, type WriteToolInput } from "@earendil-works/pi-coding-agent";
import { type ConversationId, defineTool } from "@earendil-works/pi-durable";

const piWrite = createPiWriteTool("/");
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

// resolvePath supplies a canonical absolute path. Pin each parent so concurrent changes cannot redirect mkdir/open.
async function openDestination(path: string) {
	const parts = path.slice(1).split("/");
	const name = parts.pop();
	if (!name) throw Error("Expected a file path");
	let parent = await open("/", directoryFlags);
	try {
		for (const part of parts) {
			const child = `/proc/self/fd/${parent.fd}/${part}`;
			const next = await open(child, directoryFlags).catch(async (err: NodeJS.ErrnoException) => {
				if (err.code !== "ENOENT") throw err;
				await mkdir(child).catch((e: NodeJS.ErrnoException) => {
					if (e.code !== "EEXIST") throw e;
				});
				return open(child, directoryFlags);
			});
			await parent.close();
			parent = next;
		}
		return await open(
			`/proc/self/fd/${parent.fd}/${name}`,
			constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} finally {
		await parent.close();
	}
}

export function createWriteTool(resolvePath: (path: string, conversationId: ConversationId) => string) {
	return defineTool({
		name: piWrite.name,
		description: `${piWrite.description} In read-only mode, writes are restricted to your agent scratch directory.`,
		parameters: piWrite.parameters,
		async execute(input, api, context) {
			const { path, content } = input as WriteToolInput;
			context.abortSignal?.throwIfAborted();
			const resolved = resolvePath(path.replace(/^@/, ""), api.conversationId);
			const tool = createPiWriteTool("/", {
				operations: {
					mkdir: async () => {}, // openDestination creates parents through pinned descriptors.
					writeFile: async () => {
						const file = await openDestination(resolved);
						try {
							if (!(await file.stat()).isFile()) throw Error(`Cannot write ${path}: not a regular file`);
							context.abortSignal?.throwIfAborted();
							await file.truncate(0);
							await file.writeFile(content, "utf8");
						} finally {
							await file.close();
						}
					},
				},
			});
			await tool.execute(api.callId, { path: resolved, content }, context.abortSignal);
			return { output: [{ type: "text" as const, text: `Successfully wrote to ${path}` }] };
		},
	});
}
