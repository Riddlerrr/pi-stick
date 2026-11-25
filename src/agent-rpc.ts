import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { UsageState } from "@earendil-works/pi-durable";
import type { AccessLease } from "../runtime/protocol.ts";
import { type ActionJob, type HostMessage, type RpcResponse, RunFailure, readRuntime } from "../runtime/protocol.ts";
import { closed } from "./platform.ts";
import { ephemeralArgs } from "./system.ts";
import type { RpcPolicy, TaskEnv } from "./tasks.ts";

export interface AgentRunResult {
	report: string;
	outputs?: Record<string, string>;
}

export async function executeAgentContainer(
	task: TaskEnv,
	jobPayload: ActionJob,
	resolvePolicy: (agent?: string) => RpcPolicy,
	onProgress: (line: string, agent?: string) => void,
	refreshToken: (provider: string, signal: AbortSignal) => Promise<AccessLease>,
	onUsage: (usage: UsageState) => void,
): Promise<AgentRunResult> {
	const argv = ephemeralArgs({
		runId: task.id,
		network: task.network(),
		workspace: task.workspace,
		scratch: task.scratch,
		context: task.context,
		sessions: join(task.dir, "session"),
	});
	const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
	const exit = closed(child);
	exit.catch(() => {});
	child.stdin.on("error", () => {});

	let writeQueue = Promise.resolve();
	const send = (value: HostMessage) => {
		const next = writeQueue.then(
			() =>
				new Promise<void>((resolve, reject) =>
					child.stdin.write(`${JSON.stringify(value)}\n`, (err) => (err ? reject(err) : resolve())),
				),
		);
		writeQueue = next.catch(() => {});
		return next;
	};

	const lines = createInterface({ input: child.stdout });
	const inflight = new Set<Promise<void>>();
	const commands = new Map<string, { method: string; controller: AbortController }>();
	let receivedMessage = false;
	let failure: string | undefined;
	let report: string | undefined;
	let outputs: Record<string, string> | undefined;

	try {
		await send(jobPayload);
		for await (const line of lines) {
			const msg = readRuntime(line);
			receivedMessage = true;
			if (msg.type === "cancel_exec") {
				const command = commands.get(msg.id);
				if (command?.method === "exec") command.controller.abort();
				continue;
			}
			if (msg.type === "progress") {
				onProgress(msg.message, msg.agent);
				continue;
			}
			if (msg.type === "response") {
				if (msg.id !== task.id || (msg.success && "ready" in msg.data)) throw Error("Unexpected run response");
				if (msg.data && "usage" in msg.data && msg.data.usage) onUsage(msg.data.usage);
				if (!msg.success) failure = msg.error || "Action failed";
				else if ("report" in msg.data) {
					report = msg.data.report;
					outputs = msg.data.outputs;
				}
				break;
			}

			const rpcId = msg.id;
			const method = msg.type;
			if (commands.has(rpcId)) throw Error("Duplicate RPC id");
			const controller = new AbortController();
			commands.set(rpcId, { method, controller });
			const work = (async () => {
				const base = { type: "response", id: rpcId } as const;
				let reply: RpcResponse;
				try {
					if (method === "refresh_token") {
						reply = {
							...base,
							command: method,
							success: true,
							data: await refreshToken(msg.provider, controller.signal),
						};
					} else {
						const result = await task.handleRpc(
							method,
							msg,
							resolvePolicy(msg.agent),
							(chunk) => send({ type: "exec_chunk", id: rpcId, chunk: chunk.toString("base64") }),
							controller.signal,
						);
						reply = result.error
							? { ...base, command: method, success: false, error: result.text }
							: { ...base, command: method, success: true, data: result };
					}
				} catch (err) {
					reply = {
						...base,
						command: method,
						success: false,
						error:
							method === "refresh_token"
								? "OAuth refresh failed"
								: err instanceof Error
									? err.message
									: "RPC operation failed",
					};
				}
				await send(reply);
			})().finally(() => commands.delete(rpcId));
			inflight.add(work);
			work.then(
				() => inflight.delete(work),
				() => inflight.delete(work),
			);
		}
	} catch (err) {
		child.kill();
		throw err;
	} finally {
		for (const { controller } of commands.values()) controller.abort();
		lines.close();
		child.stdin.destroy();
		await Promise.allSettled(inflight);
		await exit;
	}
	if (failure !== undefined) throw new RunFailure(failure);
	if (!receivedMessage)
		throw new RunFailure(
			"Agent exited before responding. Check Docker; for an incompatible image run pistick containers build.",
		);
	if (!report?.trim()) throw new RunFailure("Agent container failed to return a report");
	if (child.exitCode !== 0) throw new RunFailure("Agent container failed after returning its report");
	return { report, outputs };
}
