import { constants } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import { createEditTool as createPiEditTool, type EditToolInput } from "@earendil-works/pi-coding-agent";
import { type ConversationId, defineTool } from "@earendil-works/pi-durable";

const piEdit = createPiEditTool("/");

export function createEditTool(resolvePath: (path: string, conversationId: ConversationId) => string) {
	return defineTool({
		name: piEdit.name,
		description: `${piEdit.description} In read-only mode, edits are restricted to your agent scratch directory.`,
		parameters: piEdit.parameters,
		prepareArguments: piEdit.prepareArguments,
		executionMode: "sequential",
		async execute(input, api, context) {
			const { path, edits } = input as EditToolInput;
			context.abortSignal?.throwIfAborted();
			const resolved = resolvePath(path.replace(/^@/, ""), api.conversationId);
			const file = await open(resolved, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				if (!(await file.stat()).isFile()) throw Error(`Cannot edit ${path}: not a regular file`);
				// Pin Pi's file operations to the authorized inode even if the workspace path is replaced.
				const pinned = `/proc/self/fd/${file.fd}`;
				const tool = createPiEditTool("/", {
					operations: {
						access: async () => {},
						readFile: () => readFile(pinned),
						writeFile: (_, content) => writeFile(pinned, content),
					},
				});
				const result = await tool.execute(api.callId, { path: resolved, edits }, context.abortSignal);
				return { output: result.content, details: result.details };
			} finally {
				await file.close();
			}
		},
	});
}
