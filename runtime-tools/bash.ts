import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { type ConversationId, defineTool } from "@earendil-works/pi-durable";

const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;
const PROGRAM_BYTES = 1024 * 1024;

type RunCommand = (
	args: Record<string, unknown>,
	id: ConversationId,
	onChunk: (chunk: Buffer) => void,
	signal?: AbortSignal,
) => Promise<{ text: string; error?: boolean; exitCode?: number }>;

export function createBashTool(run: RunCommand, scratch: (id: ConversationId) => string) {
	return defineTool({
		name: "bash",
		description:
			"Execute a Bash command in runner (/workspace/repo) or in the working directory of an allowed Compose service. Returns combined stdout and stderr. Output is truncated to the last 2000 lines or 50 KiB; full output is saved to a temporary file when truncated.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string" },
				service: { type: "string", description: "Target Compose service (default: runner)." },
				timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)." },
			},
			required: ["command"],
			additionalProperties: false,
		},
		callers: ["model", "tools"],
		outputLimits: { retain: "tail", maxBytes: MAX_BYTES, maxLines: MAX_LINES },
		structuredOutputSchema: {
			type: "object",
			properties: {
				output: { type: "string" },
				truncated: { type: "boolean" },
				full_output_path: { type: "string" },
				exit_code: { type: "number" },
				wall_time_seconds: { type: "number" },
			},
			required: ["output", "truncated", "exit_code", "wall_time_seconds"],
		},
		execute: async (args, api, ctx) => {
			const start = performance.now();
			const decoder = new TextDecoder();
			const pending: Buffer[] = [];
			let size = 0;
			let lines = 0;
			let fd: number | undefined;
			let path: string | undefined;
			try {
				const result = await run(
					args as Record<string, unknown>,
					api.conversationId,
					(chunk) => {
						size += chunk.length;
						api.output(decoder.decode(chunk, { stream: true }));
						if (fd === undefined) {
							for (const byte of chunk) if (byte === 10) lines++;
							if (
								size <= MAX_BYTES &&
								lines + Number(chunk.at(-1) !== 10) <= MAX_LINES &&
								!api.retainedOutput().truncated
							) {
								pending.push(chunk);
								return;
							}
							path = join(scratch(api.conversationId), `pi-bash-${randomUUID()}.log`);
							fd = fs.openSync(path, "wx+", 0o600);
							fs.writeFileSync(fd, Buffer.concat(pending));
							pending.length = 0;
							api.diagnostic({ severity: "info", code: "full_output", message: `Full output: ${path}` });
						}
						fs.writeFileSync(fd, chunk);
					},
					ctx.abortSignal,
				);
				api.output(decoder.decode());
				if (result.error || result.exitCode === undefined) throw Error(result.text || "Missing bash exit code");
				const read = (offset: number, length: number) => {
					const buf = Buffer.alloc(length);
					let done = 0;
					while (done < length && fd !== undefined) {
						const n = fs.readSync(fd, buf, done, length - done, offset + done);
						if (!n) throw Error("Incomplete bash log");
						done += n;
					}
					return buf;
				};
				let output: string;
				const truncated = size > PROGRAM_BYTES;
				if (!truncated) output = (fd === undefined ? Buffer.concat(pending) : read(0, size)).toString("utf8");
				else {
					const half = PROGRAM_BYTES / 2;
					const tail = read(size - half, half);
					let i = 0;
					while ((tail[i] & 0xc0) === 0x80) i++;
					output = `${new TextDecoder().decode(read(0, half), { stream: true })}\n\n[... ${size - PROGRAM_BYTES} bytes omitted ...]\n\n${tail.subarray(i).toString("utf8")}`;
				}
				if (!size) api.output("(no output)");
				if (result.exitCode !== 0)
					api.diagnostic({
						severity: "error",
						code: "exit_code",
						message: `Command exited with code ${result.exitCode}`,
					});
				return {
					structuredOutput: {
						output,
						truncated,
						...(truncated && path ? { full_output_path: path } : {}),
						exit_code: result.exitCode,
						wall_time_seconds: Math.round((performance.now() - start) / 100) / 10,
					},
					isError: result.exitCode !== 0,
				};
			} finally {
				if (fd !== undefined) fs.closeSync(fd);
			}
		},
	});
}
