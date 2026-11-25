import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { type ConversationId, defineTool } from "@earendil-works/pi-durable";
import { ExecutionError } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool as createDurableBash } from "@earendil-works/pi-durable/tools";
import type { RpcCall, RpcData } from "./protocol.ts";

const bash = createDurableBash();
const SPILL_BYTES = 32 * 1024 * 1024;

type BashArgs = Omit<Extract<RpcCall, { type: "exec" }>, "type" | "agent">;
type RunCommand = (
	args: BashArgs,
	id: ConversationId,
	onChunk: (chunk: Buffer) => void,
	signal?: AbortSignal,
) => Promise<RpcData>;

export function createBashTool(run: RunCommand, scratch: (id: ConversationId) => string) {
	return defineTool({
		...bash,
		description: `${bash.description} Runs in runner (/workspace/repo) or an allowed Compose service's working directory. Logs in agent scratch are limited to the first 32 MiB.`,
		parameters: {
			...bash.parameters,
			properties: {
				...(bash.parameters.properties as object),
				service: { type: "string", description: "Target Compose service (default: runner)." },
			},
		},
		async execute(input, api, context) {
			const { service } = input as BashArgs;
			const env = new NodeExecutionEnv({ cwd: "/workspace/repo" });
			env.exec = async (command, options, ctx) => {
				if (typeof command !== "string") throw Error("Compose bash requires a command string");
				const decoder = new TextDecoder();
				const pending: Buffer[] = [];
				let size = 0;
				let lines = 0;
				let fd: number | undefined;
				let path: string | undefined;
				let fullOutputPath: string | undefined;
				const emit = (s: string) => {
					if (s) options?.onOutput?.(s, ctx, { stream: "stdout" });
				};
				const startSpill = () => {
					path = join(scratch(api.conversationId), `pi-bash-${randomUUID()}.log`);
					fd = fs.openSync(path, "wx", 0o600);
					fs.writeFileSync(fd, Buffer.concat(pending));
					pending.length = 0;
					return fd;
				};
				const flush = () => {
					const tail = decoder.decode();
					if (!tail) return;
					emit(tail);
					// A final replacement character can exceed the decoded limit while all raw bytes still fit.
					if (pending.length && fd === undefined && api.retainedOutput().truncated) {
						startSpill();
						fullOutputPath = path;
					}
				};
				try {
					const result = await run(
						{ command, service, timeout: options?.timeout },
						api.conversationId,
						(chunk) => {
							if (!chunk.length) return;
							fullOutputPath = undefined;
							emit(decoder.decode(chunk, { stream: true }));
							const spill = options?.spill;
							if (!spill) return;
							const offset = size;
							size += chunk.length;
							if (fd === undefined) {
								for (const byte of chunk) if (byte === 10) lines++;
								if (
									size <= spill.afterBytes &&
									lines + Number(chunk.at(-1) !== 10) <= spill.afterLines &&
									!api.retainedOutput().truncated
								) {
									pending.push(chunk);
									return;
								}
								fd = startSpill();
							}
							if (offset < SPILL_BYTES) fs.writeFileSync(fd, chunk.subarray(0, SPILL_BYTES - offset));
							if (size <= SPILL_BYTES) fullOutputPath = path;
							else if (offset <= SPILL_BYTES)
								api.diagnostic({
									severity: "warn",
									code: "spill_limit",
									message: `Log limited to the first 32 MiB: ${path}`,
								});
						},
						ctx.abortSignal,
					);
					if (result.error || result.exitCode === undefined) throw Error(result.text || "Missing bash exit code");
					flush();
					return {
						ok: true,
						value: { exitCode: result.exitCode, spillPath: fullOutputPath },
					};
				} catch (cause) {
					try {
						flush();
					} catch {
						// A failed final flush must not replace the broker's error or advertise an incomplete log.
						fullOutputPath = undefined;
					}
					const error = new ExecutionError(
						ctx.abortSignal?.aborted ? "aborted" : "unknown",
						cause instanceof Error ? cause.message : String(cause),
					);
					error.spillPath = fullOutputPath;
					return { ok: false, error };
				} finally {
					if (fd !== undefined) fs.closeSync(fd);
				}
			};
			return bash.execute(input, { ...api, env }, context);
		},
	});
}
