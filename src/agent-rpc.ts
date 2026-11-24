import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { UsageState } from "@earendil-works/pi-durable";
import { type ActionJob, type HostMessage, readRuntime } from "../runtime-tools/protocol.ts";
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
	refreshToken: (provider: unknown) => Promise<string>,
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
	const commands = new Map<string, AbortController>();
	let receivedMessage = false;
	let report: string | undefined;
	let outputs: Record<string, string> | undefined;

	try {
		await send(jobPayload);
		for await (const line of lines) {
			const msg = readRuntime(line);
			receivedMessage = true;
			if (msg.type === "cancel_exec") {
				commands.get(msg.id)?.abort();
				continue;
			}
			if (msg.type === "progress") {
				onProgress(msg.message, msg.agent);
				continue;
			}
			if (msg.type === "response") {
				if (msg.id !== task.id || (msg.success && "ready" in msg.data)) throw Error("Unexpected run response");
				if (msg.data && "usage" in msg.data && msg.data.usage) onUsage(msg.data.usage);
				if (msg.success && "report" in msg.data) {
					report = msg.data.report;
					outputs = msg.data.outputs;
				}
				break;
			}

			const rpcId = msg.id;
			const method = msg.type;
			if (commands.has(rpcId)) throw Error("Duplicate RPC id");
			const controller = method === "exec" ? new AbortController() : undefined;
			if (controller) commands.set(rpcId, controller);
			const agentName = msg.agent;
			const work = (async () => {
				let result: { text: string; error?: boolean };
				try {
					result =
						method === "refresh_token" && !agentName
							? { text: await refreshToken(msg.provider) }
							: await task.handleRpc(
									method,
									msg,
									resolvePolicy(agentName),
									(chunk) => send({ type: "exec_chunk", id: rpcId, chunk: chunk.toString("base64") }),
									controller?.signal,
								);
				} catch (err) {
					result = {
						text: err instanceof Error ? err.message : "RPC operation failed",
						error: true,
					};
				}
				commands.delete(rpcId);
				await send({
					type: "response",
					id: rpcId,
					command: method,
					...(result.error ? { success: false, error: result.text } : { success: true, data: result }),
				});
			})();
			inflight.add(work);
			work.then(
				() => inflight.delete(work),
				() => inflight.delete(work),
			);
		}
		for (const controller of commands.values()) controller.abort();
		await Promise.allSettled(inflight);
		await writeQueue;
		child.stdin.end();
		const [code] = await exit;
		if (!receivedMessage)
			throw Error(
				"Agent exited before responding. Check Docker; for an incompatible image run pistick containers build.",
			);
		if (code !== 0 || !report?.trim()) throw Error("Agent container failed to return a report");
		return { report, outputs };
	} finally {
		for (const controller of commands.values()) controller.abort();
		lines.close();
		child.stdin.destroy();
		child.kill();
		await exit;
	}
}
