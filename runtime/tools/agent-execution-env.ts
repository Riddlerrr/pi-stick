import { constants } from "node:fs";
import { type FileHandle, mkdir, open, readFile } from "node:fs/promises";
import type { Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

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

// Private to one tool call; keep Pi's filename variants virtual until each access passes the agent's policy.
export class AgentExecutionEnv extends NodeExecutionEnv {
	private readonly resolve: (path: string) => string;

	private editFile?: FileHandle;

	constructor(resolve: (path: string) => string) {
		super({ cwd: "/" });
		this.resolve = resolve;
	}

	override async absolutePath(path: string) {
		return { ok: true as const, value: path };
	}

	// resolveAgentPath already canonicalizes missing targets through their nearest existing parent.
	override async canonicalPath(path: string) {
		return { ok: true as const, value: this.resolve(path) };
	}

	override fileInfo(path: string, context: Context) {
		return super.fileInfo(this.resolve(path), context);
	}

	private async openFile(path: string, create: boolean) {
		const resolved = this.resolve(path);
		try {
			return await openDestination(resolved, create);
		} catch (cause) {
			if (!(cause instanceof Error) || !("code" in cause)) throw cause;
			throw Error(`Cannot ${create ? "write" : "edit"} ${JSON.stringify(path)}: ${cause.code}`, { cause });
		}
	}

	override async readTextFile(path: string, context: Context) {
		context.abortSignal?.throwIfAborted();
		this.editFile = await this.openFile(path, false);
		if (!(await this.editFile.stat()).isFile()) throw Error(`Cannot edit ${path}: not a regular file`);
		return { ok: true as const, value: await readFile(`/proc/self/fd/${this.editFile.fd}`, "utf8") };
	}

	override async writeFile(path: string, content: string | Uint8Array, context: Context) {
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

	async closeEdit() {
		await this.editFile?.close();
	}

	override openBinaryReader(path: string, _options: { noFollow?: boolean } | undefined, context: Context) {
		return super.openBinaryReader(this.resolve(path), { noFollow: true }, context);
	}
}
