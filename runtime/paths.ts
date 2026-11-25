import * as fs from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const CONTAINER_REPO_DIR = "/workspace/repo";
export const WORKSPACE_DIR = process.env.PI_STICK_WORKSPACE_DIR ?? CONTAINER_REPO_DIR;
export const SCRATCH_DIR = process.env.PI_STICK_SCRATCH_DIR ?? "/scratch";
const CONTEXT_DIR = process.env.PI_STICK_CONTEXT_DIR ?? "/context";

export interface AgentContext {
	name: string;
	label: string;
	mode: "read-only" | "read-write";
	scratchDir: string;
}

function canonicalBase(dir: string): string {
	return fs.existsSync(dir) ? fs.realpathSync(dir) : resolve(dir);
}

function nearestExistingRealpath(target: string): string {
	let cur = target;
	const tail: string[] = [];
	while (!fs.existsSync(cur)) {
		const parent = dirname(cur);
		if (parent === cur) break;
		tail.unshift(cur.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
		cur = parent;
	}
	const real = fs.existsSync(cur) ? fs.realpathSync(cur) : cur;
	return tail.length ? join(real, ...tail) : real;
}

function assertWithin(target: string, root: string, label: string): string {
	const resolved = nearestExistingRealpath(target);
	const rel = relative(root, resolved);
	if (rel.startsWith("..") || isAbsolute(rel)) throw Error(`Path escapes allowed ${label} directory`);
	return resolved;
}

export function createPathResolver() {
	// Resolve only the mount parent so a replacement symlink cannot redefine the workspace boundary.
	const workspaceRoot = join(canonicalBase(dirname(WORKSPACE_DIR)), basename(WORKSPACE_DIR));
	if (!fs.lstatSync(workspaceRoot, { throwIfNoEntry: false })?.isDirectory())
		throw Error(`Expected a real checkout directory at ${WORKSPACE_DIR}`);

	return function resolveAgentPath(rawPath: string, agentCtx: AgentContext, forWrite: boolean): string {
		if (!rawPath || rawPath.includes("\0") || rawPath.length > 2048) throw Error("Invalid path");
		if (rawPath === "/context" || rawPath.startsWith("/context/")) {
			if (forWrite) throw Error("/context is read-only");
			const sub = rawPath === "/context" ? "" : rawPath.slice("/context/".length);
			return assertWithin(resolve(CONTEXT_DIR, sub), canonicalBase(CONTEXT_DIR), "context");
		}
		if (rawPath === "/scratch" || rawPath.startsWith("/scratch/")) {
			const sub = rawPath === "/scratch" ? "" : rawPath.slice("/scratch/".length);
			const candidate = resolve(SCRATCH_DIR, sub);
			if (forWrite) {
				fs.mkdirSync(agentCtx.scratchDir, { recursive: true });
				return assertWithin(
					candidate,
					canonicalBase(agentCtx.scratchDir),
					`agent scratch (/scratch/${agentCtx.name})`,
				);
			}
			return assertWithin(candidate, canonicalBase(SCRATCH_DIR), "scratch");
		}
		const prefix = `${CONTAINER_REPO_DIR}/`;
		const sub =
			rawPath === CONTAINER_REPO_DIR ? "" : rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : rawPath;
		if (isAbsolute(sub)) throw Error(`Absolute paths must be under ${CONTAINER_REPO_DIR}, /scratch, or /context`);
		if (forWrite && agentCtx.mode === "read-only") {
			throw Error(
				`Write/edit in ${CONTAINER_REPO_DIR} is disabled in read-only mode. Write temporary files under /scratch/${agentCtx.name} instead.`,
			);
		}
		return assertWithin(resolve(workspaceRoot, sub), workspaceRoot, "workspace");
	};
}
