import type { ChildProcess, SpawnSyncOptionsWithBufferEncoding } from "node:child_process";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	closeSync,
	existsSync,
	futimesSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";

declare const PI_STICK_COMPILED: boolean;
export const compiled = typeof PI_STICK_COMPILED !== "undefined" && PI_STICK_COMPILED;

export const checkout = typeof PI_STICK_COMPILED === "undefined";

const explicitHome = process.env.PI_STICK_HOME;
if (explicitHome !== undefined && !isAbsolute(explicitHome)) throw Error("PI_STICK_HOME must be an absolute path");
const explicitDevHome = process.env.PI_STICK_DEV_HOME;
if (explicitDevHome !== undefined && !isAbsolute(explicitDevHome))
	throw Error("PI_STICK_DEV_HOME must be an absolute path");

const envDev = process.env.PI_STICK_DEV;
const argvDev = process.argv[2] === "--dev";
export const devMode =
	envDev === "1" || envDev === "true" || argvDev
		? true
		: envDev === "0" || envDev === "false"
			? false
			: checkout && explicitHome === undefined;

const assetsRoot = checkout
	? resolve(import.meta.dirname, "..")
	: join(compiled ? dirname(process.execPath) : import.meta.dirname, "share");
const dataRoot = devMode
	? (explicitDevHome ?? join(homedir(), "pi-stick-dev"))
	: (explicitHome ?? join(homedir(), "pi-stick"));

export function canonicalPath(input: string): string {
	const path = resolve(input);
	if (lstatSync(path, { throwIfNoEntry: false })) return realpathSync(path);
	return join(canonicalPath(dirname(path)), basename(path));
}

export const ASSETS = canonicalPath(assetsRoot);
export const ROOT = canonicalPath(dataRoot);
export const STATE = join(ROOT, "state");
export const read = (path: string) => readFileSync(path, "utf8");
export const json = (path: string) => JSON.parse(read(path));
export const writeJson = (path: string, value: unknown) => {
	const temp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	renameSync(temp, path);
};
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
	return join(ROOT, "settings.json");
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

// Kill on abort but settle only when the subprocess operation finishes, not when the signal fires.
export async function waitForChild<T>(child: ChildProcess, result: Promise<T>, signal?: AbortSignal): Promise<T> {
	const kill = () => child.kill("SIGKILL");
	if (signal?.aborted) kill();
	else signal?.addEventListener("abort", kill, { once: true });
	try {
		return await result;
	} finally {
		signal?.removeEventListener("abort", kill);
	}
}

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
