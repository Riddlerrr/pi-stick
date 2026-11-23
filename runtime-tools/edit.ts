import { constants } from "node:fs";
import { type FileHandle, open, readFile, writeFile } from "node:fs/promises";
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
			let file: FileHandle | undefined;
			try {
				const tool = createPiEditTool("/", {
					operations: {
						// Open inside Pi's queue: an earlier write may be creating this file.
						access: async () => {
							file = await open(
								resolvePath(path.replace(/^@/, ""), api.conversationId),
								constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
							);
							if (!(await file.stat()).isFile()) throw Error(`Cannot edit ${path}: not a regular file`);
						},
						readFile: () => readFile(`/proc/self/fd/${file!.fd}`),
						writeFile: (_, content) => writeFile(`/proc/self/fd/${file!.fd}`, content),
					},
				});
				const result = await tool.execute(api.callId, { path: resolved, edits }, context.abortSignal);
				return { output: result.content, details: result.details };
			} finally {
				await file?.close();
			}
		},
	});
}
