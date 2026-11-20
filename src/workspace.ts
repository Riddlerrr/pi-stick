import * as fs from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { ASSETS, prompt, ROOT, read, run, STATE, userSettings, writeJson } from "./platform.ts";

export const NAME = "[a-z0-9][a-z0-9-]{0,62}";
const validName = new RegExp(`^${NAME}$`);

export function isValidName(name: string) {
	return validName.test(name);
}

function canonical(path: string): string {
	if (fs.lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() || fs.existsSync(path))
		return fs.realpathSync(path);
	return join(canonical(dirname(path)), basename(path));
}

const within = (path: string, parent: string) =>
	path === parent || path.startsWith(parent.endsWith("/") ? parent : `${parent}/`);

export function projectsDir() {
	const config = userSettings();
	const path = "projects_dir" in config ? config.projects_dir : join(ROOT, "projects");
	if (typeof path !== "string" || !(isAbsolute(path) || path.startsWith("~/")))
		throw Error("projects_dir must be an absolute path (or start with ~/)");
	const dir = canonical(resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path));
	if (
		within(ROOT, dir) ||
		within(ASSETS, dir) ||
		[STATE, join(ROOT, "actions"), join(ASSETS, ".git"), join(ASSETS, "project-template")].some((p) => within(dir, p))
	)
		throw Error("Choose a dedicated projects directory outside pi-stick state, actions, template and Git metadata");
	return dir;
}

export interface ProjectInfo {
	name: string;
	folder: string;
	repo: string;
}

export function listProjects(): ProjectInfo[] {
	const dir = projectsDir();
	if (!fs.existsSync(dir)) return [];
	const items: ProjectInfo[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory() || !validName.test(entry.name)) continue;
		const folder = join(dir, entry.name);
		if (!fs.lstatSync(join(folder, "compose.yaml"), { throwIfNoEntry: false })?.isFile()) continue;
		items.push({ name: entry.name, folder, repo: join(folder, "repo") });
	}
	return items.sort((a, b) => a.name.localeCompare(b.name));
}

export function getProject(name: string): ProjectInfo {
	if (!validName.test(name)) throw Error("Use a project name with lowercase letters, digits and hyphens");
	const folder = join(projectsDir(), name);
	if (!fs.lstatSync(folder, { throwIfNoEntry: false })?.isDirectory())
		throw Error(`Unknown project ${name}; use pi-stick create project ${name}`);
	if (!fs.lstatSync(join(folder, "compose.yaml"), { throwIfNoEntry: false })?.isFile())
		throw Error(`Project ${name} is missing compose.yaml`);
	return { name, folder, repo: join(folder, "repo") };
}

export async function createProject(name: string, source?: string) {
	if (!validName.test(name)) throw Error("Use a project name with lowercase letters, digits and hyphens");
	const dir = projectsDir(),
		dest = join(dir, name);
	if (fs.lstatSync(dest, { throwIfNoEntry: false })) throw Error(`Project directory already exists: ${dest}`);
	source ??= await prompt("Git URL (or absolute local repository path): ");
	if (!/^(https:\/\/|ssh:\/\/|git@|\/)/.test(source))
		throw Error("Expected an HTTPS or SSH Git URL, or an absolute local path");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = fs.mkdtempSync(join(dir, ".create-")),
		stage = join(tmp, name);
	try {
		fs.cpSync(join(ASSETS, "project-template"), stage, { recursive: true });
		fs.chmodSync(stage, 0o700);
		const compose = join(stage, "compose.yaml");
		fs.writeFileSync(compose, `name: pi-dev-${name}\n${read(compose)}`);
		writeJson(join(stage, "project.json"), { name, source });
		run(
			[
				"git",
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"credential.https://github.com.helper=!gh auth git-credential",
				"clone",
				"--no-local",
				"--",
				source,
				join(stage, "repo"),
			],
			{ env: { ...process.env, GIT_ALLOW_PROTOCOL: "https:ssh:file" } },
		);
		fs.renameSync(stage, dest);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	return dest;
}
