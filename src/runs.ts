import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { closed, isLocked, json, prompt, read, STATE, touch, tryLock, writeJson } from "./platform.ts";
import { ephemeralArgs } from "./system.ts";
import type { RpcPolicy } from "./tasks.ts";
import { TaskEnv } from "./tasks.ts";
import { getProject } from "./workspace.ts";

export const VALID_ID = /^[0-9a-f]{32}$/;

export interface RunMeta {
	id: string;
	project: string;
	action: string;
	ref?: string;
	baseHead?: string;
	keepUp?: boolean;
	createdAt: string;
	updatedAt: string;
	status: "preparing" | "running" | "done" | "failed";
}

export function runDir(id: string) {
	if (!VALID_ID.test(id)) throw Error("Invalid run ID");
	return join(STATE, "runs", id);
}

export function runLock(id: string) {
	return join(runDir(id), "lock");
}

export function activeRunIds(): string[] {
	const runsDir = join(STATE, "runs");
	if (!fs.existsSync(runsDir)) return [];
	const active: string[] = [];
	for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || !VALID_ID.test(entry.name)) continue;
		if (isLocked(join(runsDir, entry.name, "lock"))) active.push(entry.name);
	}
	return active;
}

export function readMeta(id: string): RunMeta {
	const file = join(runDir(id), "meta.json");
	if (!fs.existsSync(file)) throw Error(`Unknown run: ${id}`);
	return json(file) as RunMeta;
}

export function writeMeta(id: string, meta: RunMeta) {
	writeJson(join(runDir(id), "meta.json"), { ...meta, updatedAt: new Date().toISOString() });
}

export function status(dir: string, msg: string, agent?: string) {
	const prefix = agent ? `[${agent}] ` : "";
	const safe = `${prefix}${msg}`.replace(/[\p{C}\p{Z}]/gu, (c) => {
		if (" \t\n".includes(c)) return c;
		if (c === "\r") return "\\r";
		const n = c.codePointAt(0)!;
		return (
			(n < 256 ? "\\x" : n <= 65535 ? "\\u" : "\\U") + n.toString(16).padStart(n < 256 ? 2 : n <= 65535 ? 4 : 8, "0")
		);
	});
	fs.appendFileSync(join(dir, "progress"), `${safe}\n`);
}

export async function follow(id: string) {
	const dir = runDir(id);
	const exit = join(dir, "exit");
	const lockPath = join(dir, "lock");
	if (!fs.existsSync(dir)) throw Error("Unknown run");
	const file = fs.openSync(join(dir, "progress"), "r");
	const buf = Buffer.alloc(65536);
	async function drain() {
		for (;;) {
			const n = fs.readSync(file, buf);
			if (n <= 0) break;
			if (!process.stdout.write(Buffer.from(buf.subarray(0, n)))) await once(process.stdout, "drain");
		}
	}
	try {
		for (;;) {
			await drain();
			if (fs.existsSync(exit)) {
				await drain();
				return Number(read(exit));
			}
			const fd = fs.openSync(lockPath, "a");
			try {
				if (tryLock(fd) && !fs.existsSync(exit))
					throw Error("Worker interrupted; inspect worker.log or resume this run");
			} finally {
				fs.closeSync(fd);
			}
			await sleep(500);
		}
	} finally {
		fs.closeSync(file);
	}
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
): Promise<AgentRunResult> {
	const argv = ephemeralArgs({
		network: task.network(),
		repo: task.repo,
		scratch: task.scratch,
		context: task.context,
		sessions: join(STATE, "sessions"),
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
	let report: string | undefined;
	let outputs: Record<string, string> | undefined;
	let rpcCount = 0;

	try {
		await send(jobPayload);
		for await (const line of lines) {
			const msg = JSON.parse(line);
			if (typeof msg.progress === "string") {
				onProgress(msg.progress, typeof msg.agent === "string" ? msg.agent : undefined);
				continue;
			}
			if (typeof msg.report === "string") {
				report = msg.report;
				if (msg.outputs && typeof msg.outputs === "object") outputs = msg.outputs as Record<string, string>;
				break;
			}
			if (typeof msg.rpc === "number" && typeof msg.method === "string") {
				if (++rpcCount > 500) throw Error("RPC call limit exceeded");
				const rpcId = msg.rpc as number;
				const method = msg.method as string;
				const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
				const agentName = typeof msg.agent === "string" ? msg.agent : undefined;
				const work = (async () => {
					let result: { text: string; error?: boolean };
					try {
						result = await task.handleRpc(method, params, resolvePolicy(agentName));
					} catch (err) {
						result = {
							text: err instanceof Error ? err.message : "RPC operation failed",
							error: true,
						};
					}
					await send({ rpc: rpcId, result });
				})();
				inflight.add(work);
				work.finally(() => inflight.delete(work));
				continue;
			}
			throw Error("Unexpected message from agent container");
		}
		await Promise.allSettled(inflight);
		await writeQueue;
		child.stdin.end();
		const [code] = await exit;
		if (code !== 0 || !report?.trim()) throw Error("Agent container failed to return a report");
		return { report, outputs };
	} finally {
		lines.close();
		child.stdin.destroy();
		child.kill();
		await exit;
	}
}

export function listRuns(all: boolean) {
	const runsDir = join(STATE, "runs");
	if (!fs.existsSync(runsDir)) {
		console.log("No runs found.");
		return;
	}
	const rows: Array<{ id: string; state: string; project: string; action: string; updatedAt: string }> = [];
	for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
		if (!entry.isDirectory() || !VALID_ID.test(entry.name)) continue;
		const id = entry.name;
		const dir = join(runsDir, id);
		const active = isLocked(join(dir, "lock"));
		const metaFile = join(dir, "meta.json");
		const meta: Partial<RunMeta> = fs.existsSync(metaFile) ? json(metaFile) : {};
		const exitFile = join(dir, "exit");
		const state = active
			? "running"
			: fs.existsSync(exitFile)
				? read(exitFile).trim() === "0"
					? "done"
					: "failed"
				: "interrupted";
		if (!all && state !== "running") continue;
		rows.push({
			id,
			state,
			project: meta.project ?? "-",
			action: meta.action ?? "-",
			updatedAt: meta.updatedAt ?? meta.createdAt ?? "-",
		});
	}
	rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	if (!rows.length) {
		console.log(all ? "No runs found." : "No active runs. Use --all to list past runs.");
		return;
	}
	for (const r of rows) {
		console.log(`${r.id}  ${r.state.padEnd(11)}  ${r.project}  ${r.action}  ${r.updatedAt}`);
	}
}

export function stopRun(id: string) {
	const meta = readMeta(id);
	if (isLocked(runLock(id))) throw Error(`Run ${id} is currently active; wait for it to finish before stopping`);
	const task = new TaskEnv(id, getProject(meta.project));
	task.stop();
	touch(join(task.dir, "last-used"));
	console.log(`Stopped containers for run ${id}.`);
}

export function diffRun(id: string) {
	const meta = readMeta(id);
	const task = new TaskEnv(id, getProject(meta.project));
	if (!fs.existsSync(task.repo)) {
		const patchFile = join(task.dir, "changes.patch");
		if (fs.existsSync(patchFile)) {
			process.stdout.write(read(patchFile));
			return;
		}
		console.log("No changes.");
		return;
	}
	const { patch, untracked } = task.captureDiff(meta.baseHead);
	if (patch) process.stdout.write(patch);
	if (untracked.length) {
		console.log(`\nUntracked files:\n${untracked.map((f) => `  ${f}`).join("\n")}`);
	}
	if (!patch && !untracked.length) console.log("No changes.");
}

export async function cleanup(days: number, dry: boolean) {
	const runsDir = join(STATE, "runs");
	const cutoff = Date.now() - days * 86400000;
	if (!fs.existsSync(runsDir)) {
		console.log("No eligible pi-stick runs.");
		return;
	}
	const items: Array<{ id: string; dir: string; key: string; compose: string }> = [];
	for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
		const id = entry.name;
		if (!entry.isDirectory() || !VALID_ID.test(id)) continue;
		const dir = join(runsDir, id);
		if (isLocked(join(dir, "lock"))) continue;
		if (!fs.existsSync(join(dir, "exit"))) continue;
		const last = fs.statSync(join(dir, "last-used"), { throwIfNoEntry: false });
		if (!last?.isFile() || last.mtimeMs > cutoff) continue;
		const metaFile = join(dir, "meta.json");
		const project = fs.existsSync(metaFile) ? (json(metaFile) as Partial<RunMeta>).project : undefined;
		const key = project ? `pi-stick-${project}-${id.slice(0, 12)}` : `pi-stick-run-${id.slice(0, 12)}`;
		const compose = join(dir, "compose.yaml");
		items.push({ id, dir, key, compose });
		console.log(`${id} (${project ?? "unknown"}): workspace, scratch stack/volumes, reports and session`);
	}
	if (!items.length) {
		console.log("No eligible pi-stick runs.");
		return;
	}
	if (dry || (await prompt("Permanently delete listed pi-stick runs? [y/N] ")).toLowerCase() !== "y") return;
	for (const { id, dir, key, compose } of items) {
		if (fs.existsSync(compose)) {
			const res = spawn("docker", ["compose", "-p", key, "-f", compose, "down", "--volumes"], { stdio: "inherit" });
			await closed(res);
		}
		for (const ext of ["", "-wal", "-shm"]) fs.rmSync(join(STATE, "sessions", `${id}.sqlite${ext}`), { force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
