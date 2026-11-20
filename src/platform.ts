import type { ChildProcess, SpawnSyncOptionsWithBufferEncoding } from "node:child_process";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, existsSync, futimesSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

declare const PI_STICK_COMPILED: boolean;
export const compiled = typeof PI_STICK_COMPILED !== "undefined" && PI_STICK_COMPILED;
const home = process.env.PI_STICK_HOME;
if (home !== undefined && !isAbsolute(home)) throw Error("PI_STICK_HOME must be an absolute path");
const root =
	home ??
	(typeof PI_STICK_COMPILED !== "undefined" ? join(homedir(), "pi-stick") : resolve(import.meta.dirname, ".."));
export const ROOT = existsSync(root) ? realpathSync(root) : root;
export const STATE = join(ROOT, "state");
export const read = (path: string) => readFileSync(path, "utf8");
export const json = (path: string) => JSON.parse(read(path));
export const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
export const runId = () => randomUUID().replaceAll("-", "");

export function touch(path: string) {
	const fd = openSync(path, "a");
	try {
		const now = new Date();
		futimesSync(fd, now, now);
	} finally {
		closeSync(fd);
	}
}

export interface UserSettings {
	projects_dir?: string;
	default_model?: string;
}

export function settingsPath() {
	return join(homedir(), ".config/pi-stick/settings.json");
}

export function userSettings(): UserSettings {
	const file = settingsPath();
	if (!existsSync(file)) return {};
	const config = json(file);
	if (!config || typeof config !== "object" || Array.isArray(config)) throw Error(`Expected an object in ${file}`);
	return config as UserSettings;
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

export const closed = (child: ChildProcess): Promise<[number | null, string | null]> =>
	once(child, "close") as Promise<[number | null, string | null]>;

// flock(1) locks the shared open file description. Closing the launcher does not unlock the worker's copy.
export function tryLock(fd: number) {
	const r = spawnSync("flock", ["-n", "-E", "75", "3"], { stdio: ["ignore", "ignore", "inherit", fd] });
	if (r.error) throw r.error;
	if (r.status === 75) return false;
	if (r.status !== 0) throw Error("Could not lock pi-stick state");
	return true;
}

export function isLocked(lockPath: string) {
	if (!existsSync(lockPath)) return false;
	const fd = openSync(lockPath, "a");
	try {
		return !tryLock(fd);
	} finally {
		closeSync(fd);
	}
}

export function gitCommand(repo: string) {
	return ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", repo];
}

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
