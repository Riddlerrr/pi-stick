import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { UsageState } from "@earendil-works/pi-durable";
import { closed } from "./platform.ts";
import { ephemeralArgs } from "./system.ts";
import type { RpcPolicy, TaskEnv } from "./tasks.ts";

function isUsageSnapshot(value: unknown): value is UsageState {
	const record = (v: unknown): v is Record<string, unknown> =>
		v !== null && typeof v === "object" && !Array.isArray(v);
	const amount = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
	if (!record(value) || Object.keys(value).length !== 2 || !record(value.models) || !record(value.tools)) return false;
	const common = ["input", "output", "cacheRead", "cacheWrite"];
	const tokens = [...common, "totalTokens"];
	const costs = [...common, "total"];
	return [value.models, value.tools].every((bucket) =>
		Object.values(bucket).every((entry) => {
			if (!record(entry) || !record(entry.cost)) return false;
			const cost = entry.cost;
			return (
				tokens.every((k) => amount(entry[k])) &&
				Object.entries(entry).every(
					([k, v]) =>
						k === "cost" || tokens.includes(k) || ((k === "cacheWrite1h" || k === "reasoning") && amount(v)),
				) &&
				costs.every((k) => amount(cost[k])) &&
				Object.entries(cost).every(([k, v]) =>
					k === "totalFromProvider" ? typeof v === "boolean" : costs.includes(k),
				)
			);
		}),
	);
}

export interface AgentRunResult {
	report: string;
	outputs?: Record<string, string>;
}

export async function executeAgentContainer(
	task: TaskEnv,
	jobPayload: Record<string, unknown>,
	resolvePolicy: (agent?: string) => RpcPolicy,
	onProgress: (line: string, agent?: string) => void,
	refreshToken: (provider: unknown) => Promise<string>,
	onUsage: (usage: UsageState) => void,
): Promise<AgentRunResult> {
	const argv = ephemeralArgs({
		runId: task.id,
		network: task.network(),
		repo: task.repo,
		scratch: task.scratch,
		context: task.context,
		sessions: join(task.dir, "session"),
	});
	const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
	const exit = closed(child);
	exit.catch(() => {});
	child.stdin.on("error", () => {});

	let writeQueue = Promise.resolve();
	const send = (value: unknown) => {
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
	const commands = new Map<number, AbortController>();
	let report: string | undefined;
	let outputs: Record<string, string> | undefined;

	try {
		await send(jobPayload);
		for await (const line of lines) {
			const msg = JSON.parse(line);
			if (typeof msg.cancelRpc === "number") {
				commands.get(msg.cancelRpc)?.abort();
				continue;
			}
			if (typeof msg.progress === "string") {
				onProgress(msg.progress, typeof msg.agent === "string" ? msg.agent : undefined);
				continue;
			}
			if (typeof msg.report === "string" || Object.hasOwn(msg, "usage")) {
				if (Object.hasOwn(msg, "usage")) {
					if (!isUsageSnapshot(msg.usage)) throw Error("Invalid agent usage snapshot");
					onUsage(msg.usage);
				}
				report = typeof msg.report === "string" ? msg.report : undefined;
				if (msg.outputs && typeof msg.outputs === "object") outputs = msg.outputs as Record<string, string>;
				break;
			}
			if (typeof msg.rpc === "number" && typeof msg.method === "string") {
				const rpcId = msg.rpc as number;
				const method = msg.method as string;
				if (commands.has(rpcId)) throw Error("Duplicate RPC id");
				const controller = method === "exec" ? new AbortController() : undefined;
				if (controller) commands.set(rpcId, controller);
				const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
				const agentName = typeof msg.agent === "string" ? msg.agent : undefined;
				const work = (async () => {
					let result: { text: string; error?: boolean };
					try {
						result =
							method === "refresh_token" && !agentName
								? { text: await refreshToken(params.provider) }
								: await task.handleRpc(
										method,
										params,
										resolvePolicy(agentName),
										(chunk) => send({ rpc: rpcId, chunk: chunk.toString("base64") }),
										controller?.signal,
									);
					} catch (err) {
						result = {
							text: err instanceof Error ? err.message : "RPC operation failed",
							error: true,
						};
					}
					commands.delete(rpcId);
					await send({ rpc: rpcId, result });
				})();
				inflight.add(work);
				work.then(
					() => inflight.delete(work),
					() => inflight.delete(work),
				);
				continue;
			}
			throw Error("Unexpected message from agent container");
		}
		for (const controller of commands.values()) controller.abort();
		await Promise.allSettled(inflight);
		await writeQueue;
		child.stdin.end();
		const [code] = await exit;
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
