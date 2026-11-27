import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join, relative } from "node:path";
import type { LoadedAction } from "./actions.ts";
import { ASSETS, ROOT, read } from "./platform.ts";

const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

type Snapshot = Pick<
	LoadedAction,
	"name" | "scope" | "orchestrator" | "agents" | "stageContext" | "stages" | "hooks"
> & {
	version: 2;
	systemPrompt?: string; // Absent in runs created before operator prompts.
	projectNotes: string | null;
	treeHash: string;
};

// Hash the same entries and bytes that we copy, including empty directories.
function treeHash(dir: string, copyTo?: string): string {
	if (!fs.lstatSync(dir).isDirectory()) throw Error(`Not a directory: ${dir}`);
	if (copyTo) fs.mkdirSync(copyTo, { mode: 0o700 });
	const entries = fs
		.readdirSync(dir)
		.sort()
		.map((name) => {
			const path = join(dir, name);
			const target = copyTo && join(copyTo, name);
			const stat = fs.lstatSync(path);
			if (stat.isDirectory()) return [name, "dir", treeHash(path, target)];
			if (!stat.isFile()) throw Error(`Unsupported action entry: ${path}`);
			const mode = target ? (stat.mode & 0o111 ? 0o500 : 0o400) : stat.mode & 0o7777;
			const bytes = fs.readFileSync(path);
			if (target) fs.writeFileSync(target, bytes, { mode, flag: "wx" });
			return [name, mode, digest(bytes)];
		});
	return digest(JSON.stringify(entries));
}

function operatorPrompt(name: string): string | undefined {
	const path = join(ROOT, name);
	const stat = fs.lstatSync(path, { throwIfNoEntry: false });
	if (!stat) return undefined;
	if (!stat.isFile()) throw Error(`Expected a regular prompt file: ${path}`);
	return read(path).trim();
}

// The launcher publishes the digest in run.json only after every file exists.
export function saveActionSnapshot(runDir: string, action: LoadedAction, projectDir: string): string {
	const dir = join(runDir, "action-snapshot");
	fs.mkdirSync(dir, { mode: 0o700 });
	const hooks: Snapshot["hooks"] = {};
	for (const name of ["prepare", "after"] as const) {
		const source = action.hooks[name];
		if (!source) continue;
		if (!fs.lstatSync(source).isFile()) throw Error(`Not a hook file: ${source}`);
		fs.accessSync(source, fs.constants.X_OK);
		hooks[name] = relative(action.dir, source);
	}
	const notes = join(projectDir, "AGENTS.md");
	const { name, scope, orchestrator, agents, stages, stageContext } = action;
	const snapshot: Snapshot = {
		version: 2,
		name,
		scope,
		orchestrator,
		agents,
		stages,
		stageContext,
		hooks,
		treeHash: treeHash(action.dir, join(dir, "action")),
		systemPrompt: [
			operatorPrompt("SYSTEM.md") ?? read(join(ASSETS, "prompts/SYSTEM.md")).trim(),
			operatorPrompt("APPEND_SYSTEM.md"),
		]
			.filter(Boolean)
			.join("\n\n"),
		projectNotes: fs.existsSync(notes) ? fs.readFileSync(notes, "utf8") : null,
	};
	const bytes = Buffer.from(JSON.stringify(snapshot));
	fs.writeFileSync(join(dir, "definition.json"), bytes, { mode: 0o400, flag: "wx" });
	return digest(bytes);
}

export function readActionSnapshot(runDir: string, expected: string | undefined) {
	if (!expected) throw Error("Missing action snapshot for this run; start a new run");
	const dir = join(runDir, "action-snapshot");
	try {
		if (!fs.lstatSync(dir).isDirectory()) throw Error("not a directory");
		const definition = join(dir, "definition.json");
		if (!fs.lstatSync(definition).isFile()) throw Error("definition.json is not a regular file");
		const bytes = fs.readFileSync(definition);
		if (digest(bytes) !== expected) throw Error("definition.json checksum mismatch");
		const snapshot: Snapshot = JSON.parse(bytes.toString("utf8"));
		if (snapshot.version !== 2) throw Error("unsupported version; start a new run");
		const actionDir = join(dir, "action");
		if (treeHash(actionDir) !== snapshot.treeHash) throw Error("action tree checksum mismatch");
		for (const name of ["prepare", "after"] as const) {
			const hook = snapshot.hooks[name];
			if (hook) {
				snapshot.hooks[name] = join(actionDir, hook);
				fs.accessSync(snapshot.hooks[name], fs.constants.X_OK);
			}
		}
		return { ...snapshot, dir: actionDir };
	} catch (err) {
		throw Error(`Invalid action snapshot: ${err instanceof Error ? err.message : err}`);
	}
}
