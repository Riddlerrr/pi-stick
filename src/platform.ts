import type { SpawnSyncOptionsWithBufferEncoding } from "node:child_process";
import { spawnSync } from "node:child_process";
import { closeSync, futimesSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

export const ROOT = resolve(import.meta.dirname, "..");
export const STATE = join(ROOT, "state");
export const read = (path: string) => readFileSync(path, "utf8");
export const json = (path: string) => JSON.parse(read(path));
export const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
export function touch(path: string) {
	const fd = openSync(path, "a");
	try {
		const now = new Date();
		futimesSync(fd, now, now);
	} finally {
		closeSync(fd);
	}
}

export function command(argv: string[], opts: SpawnSyncOptionsWithBufferEncoding = {}, allowed = [0]) {
	const r = spawnSync(argv[0], argv.slice(1), {
		stdio: ["pipe", "pipe", "inherit"],
		maxBuffer: 256 * 1024 * 1024,
		...opts,
	});
	if (r.error) throw r.error;
	if (r.status === null || !allowed.includes(r.status)) throw Error(`${argv[0]} failed (${r.status ?? r.signal})`);
	return r.stdout;
}
export const output = (argv: string[], input?: string) => command(argv, { input }).toString().trim();
export const run = (argv: string[], opts: SpawnSyncOptionsWithBufferEncoding = {}) =>
	command(argv, { stdio: "inherit", ...opts });

export async function prompt(label: string) {
	process.stdout.write(label);
	const rl = createInterface({ input: process.stdin });
	try {
		for await (const line of rl) return line.trim();
	} finally {
		rl.close();
	}
	throw Error("No input received");
}
