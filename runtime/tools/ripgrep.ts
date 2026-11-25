import { spawn } from "node:child_process";
import { once } from "node:events";

export const MAX_SEARCH_CHARS = 32_000;
const SEARCH_TIMEOUT_MS = 15_000;

export async function scanRipgrep(
	cwd: string,
	args: string[],
	separator: string,
	accept: (record: string) => boolean,
	abortSignal: AbortSignal | undefined,
): Promise<boolean> {
	const deadline = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	const child = spawn(
		"rg",
		[
			"--no-config",
			"--hidden",
			"--no-require-git",
			"--no-ignore-global",
			"--no-ignore-dot",
			"--sort=path",
			"--glob=!.git",
			"--glob=!node_modules",
			...args,
		],
		{
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			signal: abortSignal ? AbortSignal.any([abortSignal, deadline]) : deadline,
			killSignal: "SIGKILL",
		},
	);
	const closed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
	void closed.catch(() => {}); // The child can fail while stdout is being drained.
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(0, 2000);
	});
	try {
		let pending = "";
		let truncated = false;
		for await (const chunk of child.stdout.setEncoding("utf8") as AsyncIterable<string>) {
			const records = (pending + chunk).split(separator);
			pending = records.pop() ?? "";
			if (records.every(accept)) continue;
			truncated = true;
			child.kill("SIGKILL");
			break;
		}
		const [code, signal] = await closed;
		if (code !== 0 && code !== 1 && !(truncated && signal === "SIGKILL")) {
			throw Error(stderr.trim() || `ripgrep failed (${code ?? signal})`);
		}
		return truncated;
	} catch (err) {
		if (deadline.aborted && !abortSignal?.aborted) throw Error("Search timed out; narrow the search path.");
		throw err;
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
}
