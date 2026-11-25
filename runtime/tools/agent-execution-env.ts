import { constants } from "node:fs";
import { type FileHandle, mkdir, mkdtemp, open, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { type ExecutionEnv, ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CONTAINER_REPO_DIR } from "../paths.ts";

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

// resolvePath supplies a canonical absolute path. Pin each parent so concurrent changes cannot redirect mkdir/open.
async function openDestination(path: string, create: boolean) {
	const parts = path.slice(1).split("/");
	const name = parts.pop();
	if (!name) throw Error("Expected a file path");
	let parent = await open("/", directoryFlags);
	try {
		for (const part of parts) {
			const child = `/proc/self/fd/${parent.fd}/${part}`;
			const next = await open(child, directoryFlags).catch(async (err: NodeJS.ErrnoException) => {
				if (!create || err.code !== "ENOENT") throw err;
				await mkdir(child).catch((e: NodeJS.ErrnoException) => {
					if (e.code !== "EEXIST") throw e;
				});
				return open(child, directoryFlags);
			});
			await parent.close();
			parent = next;
		}
		return await open(
			`/proc/self/fd/${parent.fd}/${name}`,
			(create ? constants.O_WRONLY | constants.O_CREAT : constants.O_RDWR) |
				constants.O_NOFOLLOW |
				constants.O_NONBLOCK,
		);
	} finally {
		await parent.close();
	}
}

const node = new NodeExecutionEnv({ cwd: CONTAINER_REPO_DIR });
async function unsupported() {
	return { ok: false as const, error: new FileError("not_supported", "Unsupported agent filesystem operation") };
}

export function agentEnv(api: { env: ExecutionEnv | undefined }): AgentExecutionEnv {
	if (!(api.env instanceof AgentExecutionEnv)) throw Error("Missing agent execution environment");
	return api.env;
}

// Private to one tool call; keep Pi's filename variants virtual until each access passes the agent's policy.
export class AgentExecutionEnv implements ExecutionEnv {
	readonly name: string;
	readonly resolve: (path: string, forWrite: boolean) => string;
	readonly cwd = CONTAINER_REPO_DIR;
	readonly id = node.id;

	// Do not expose unscoped Node filesystem operations or a local shell through the harness.
	openTextLineReader = unsupported;
	readTextLines = unsupported;
	readBinaryFile = unsupported;
	appendFile = unsupported;
	truncateFile = unsupported;
	flushFile = unsupported;
	renameFile = unsupported;
	listDir = unsupported;
	openDirReader = unsupported;
	watch = unsupported;
	joinPath = unsupported;
	createDir = unsupported;
	remove = unsupported;
	createTempFile = unsupported;

	exec: ExecutionEnv["exec"] = async () => {
		return { ok: false, error: new ExecutionError("shell_unavailable", "Use the brokered bash tool") };
	};

	private editFile?: FileHandle;

	constructor(name: string, resolve: (path: string, forWrite: boolean) => string) {
		this.name = name;
		this.resolve = resolve;
	}

	async absolutePath(path: string, context: Context) {
		context.abortSignal?.throwIfAborted();
		return { ok: true as const, value: path };
	}

	// resolveAgentPath already canonicalizes missing targets through their nearest existing parent.
	async canonicalPath(path: string) {
		return { ok: true as const, value: this.resolve(path, true) };
	}

	fileInfo(path: string, context: Context) {
		return node.fileInfo(this.resolve(path, false), context);
	}

	exists(path: string, context: Context) {
		return node.exists(this.resolve(path, false), context);
	}

	async createTempDir(prefix = "tmp-", context: Context) {
		context.abortSignal?.throwIfAborted();
		if (!/^[\w-]+$/.test(prefix)) throw Error("Invalid scratch directory prefix");
		const scratch = `/scratch/${this.name}`;
		const parent = await open(this.resolve(scratch, true), directoryFlags);
		try {
			const dir = await mkdtemp(`/proc/self/fd/${parent.fd}/${prefix}`);
			return { ok: true as const, value: join(scratch, basename(dir)) };
		} finally {
			await parent.close();
		}
	}

	private async openFile(path: string, create: boolean) {
		const resolved = this.resolve(path, true);
		try {
			return await openDestination(resolved, create);
		} catch (cause) {
			if (!(cause instanceof Error) || !("code" in cause)) throw cause;
			throw Error(`Cannot ${create ? "write" : "edit"} ${JSON.stringify(path)}: ${cause.code}`, { cause });
		}
	}

	async readTextFile(path: string, context: Context) {
		context.abortSignal?.throwIfAborted();
		this.editFile = await this.openFile(path, false);
		if (!(await this.editFile.stat()).isFile()) throw Error(`Cannot edit ${path}: not a regular file`);
		return { ok: true as const, value: await readFile(`/proc/self/fd/${this.editFile.fd}`, "utf8") };
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context) {
		const file = this.editFile ?? (await this.openFile(path, true));
		try {
			if (!(await file.stat()).isFile()) throw Error(`Cannot write ${path}: not a regular file`);
			context.abortSignal?.throwIfAborted();
			await file.truncate(0);
			await file.writeFile(content);
			return { ok: true as const, value: undefined };
		} finally {
			if (!this.editFile) await file.close();
		}
	}

	async cleanup() {
		await this.editFile?.close();
		this.editFile = undefined;
	}

	openBinaryReader(path: string, _options: { noFollow?: boolean } | undefined, context: Context) {
		return node.openBinaryReader(this.resolve(path, false), { noFollow: true }, context);
	}
}
