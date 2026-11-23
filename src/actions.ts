import * as fs from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ASSETS, json, ROOT, read, run, userSettings, writeJson } from "./platform.ts";
import { parseModelSpec } from "./system.ts";
import { isValidName, type ProjectInfo } from "./workspace.ts";

export const ALL_TOOLS = [
	"read",
	"write",
	"edit",
	"grep",
	"find",
	"codemode",
	"exec",
	"logs",
	"ps",
	"restart",
	"delegate",
] as const;

export type ToolName = (typeof ALL_TOOLS)[number];
export type AgentMode = "read-only" | "read-write";

export interface ActionInputSpec {
	description?: string;
	required?: boolean;
	default?: string;
}

export interface AgentConfig {
	description?: string;
	model?: string;
	instructions?: string;
	mode?: AgentMode;
	tools?: ToolName[];
	allowedServices?: string[];
	maxTurns?: number;
}

export interface StageConfig {
	name: string;
	parallel: string[];
	prompt?: string;
}

export interface ActionHooks {
	prepare?: string;
	after?: string;
}

export interface ActionManifest {
	$schema?: string;
	name?: string;
	description?: string;
	model?: string;
	inputs?: Record<string, ActionInputSpec>;
	hooks?: ActionHooks;
	orchestrator: AgentConfig;
	agents?: Record<string, AgentConfig>;
	stages?: StageConfig[];
}

export interface ResolvedAgentSpec {
	name: string;
	description?: string;
	model: string;
	instructions: string;
	mode: AgentMode;
	tools: ToolName[];
	allowedServices: string[];
	maxTurns?: number;
}

export interface LoadedAction {
	name: string;
	scope: "global" | "project";
	dir: string;
	manifest: ActionManifest;
	description: string;
	inputs: Record<string, ActionInputSpec>;
	hooks: { prepare?: string; after?: string };
	orchestrator: ResolvedAgentSpec;
	agents: Record<string, ResolvedAgentSpec>;
	stages: StageConfig[];
}

const AGENT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const TOOL_SET = new Set<string>(ALL_TOOLS);
const DEFAULT_RW_TOOLS: ToolName[] = [
	"read",
	"write",
	"edit",
	"grep",
	"find",
	"codemode",
	"exec",
	"logs",
	"ps",
	"restart",
];
const DEFAULT_RO_TOOLS: ToolName[] = ["read", "write", "edit", "grep", "find", "codemode", "exec", "logs", "ps"];

export function globalActionsDir() {
	return join(ROOT, "actions");
}

export function projectActionsDir(project: ProjectInfo) {
	return join(project.folder, "actions");
}

function resolveInside(baseDir: string, relPath: string, label: string): string {
	if (!relPath || isAbsolute(relPath) || relPath.includes("\0"))
		throw Error(`${label} must be a relative path inside the action directory: ${relPath}`);
	const base = fs.realpathSync(baseDir);
	const target = resolve(base, relPath);
	if (!fs.existsSync(target)) throw Error(`${label} not found: ${target}`);
	const real = fs.realpathSync(target);
	const rel = relative(base, real);
	if (rel.startsWith("..") || isAbsolute(rel)) throw Error(`${label} escapes the action directory: ${relPath}`);
	return real;
}

function resolveAgent(
	name: string,
	raw: AgentConfig,
	actionDir: string,
	fallbackModel: string | undefined,
	isOrchestrator: boolean,
	hasSubagents: boolean,
	requireModel: boolean,
): ResolvedAgentSpec {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error(`Invalid agent config for '${name}'`);
	const mode: AgentMode = raw.mode ?? (isOrchestrator ? "read-write" : "read-only");
	if (mode !== "read-only" && mode !== "read-write")
		throw Error(`Agent '${name}' mode must be 'read-only' or 'read-write'`);
	const model = raw.model ?? fallbackModel ?? "";
	if (model) parseModelSpec(model);
	else if (requireModel)
		throw Error(
			`No model configured for agent '${name}'; set 'model' in action.json or 'default_model' in ~/.config/pi-stick/settings.json`,
		);
	let instructions = "";
	if (raw.instructions !== undefined) {
		if (typeof raw.instructions !== "string") throw Error(`Agent '${name}' instructions must be a file path`);
		instructions = read(resolveInside(actionDir, raw.instructions, `Agent '${name}' instructions`));
	}
	let tools: ToolName[];
	if (raw.tools !== undefined) {
		if (!Array.isArray(raw.tools)) throw Error(`Agent '${name}' tools must be an array`);
		for (const t of raw.tools) {
			if (typeof t !== "string" || !TOOL_SET.has(t)) throw Error(`Agent '${name}' references unknown tool '${t}'`);
		}
		tools = [...new Set(raw.tools as ToolName[])];
	} else {
		tools = mode === "read-write" ? [...DEFAULT_RW_TOOLS] : [...DEFAULT_RO_TOOLS];
		if (isOrchestrator && hasSubagents) tools.push("delegate");
	}
	if (!isOrchestrator && tools.includes("delegate"))
		throw Error(`Subagent '${name}' cannot enable 'delegate'; only the orchestrator may delegate`);
	const allowedServices = raw.allowedServices ?? ["runner"];
	if (!Array.isArray(allowedServices) || allowedServices.some((s) => typeof s !== "string" || !s.length))
		throw Error(`Agent '${name}' allowedServices must be an array of service names`);
	if (raw.maxTurns !== undefined && (!Number.isSafeInteger(raw.maxTurns) || raw.maxTurns < 1))
		throw Error(`Agent '${name}' maxTurns must be a positive integer`);
	return {
		name,
		description: typeof raw.description === "string" ? raw.description : undefined,
		model,
		instructions,
		mode,
		tools,
		allowedServices,
		maxTurns: raw.maxTurns,
	};
}

export function loadActionFromDir(
	name: string,
	dir: string,
	scope: "global" | "project",
	requireModel = true,
): LoadedAction {
	const manifestFile = join(dir, "action.json");
	if (!fs.lstatSync(manifestFile, { throwIfNoEntry: false })?.isFile())
		throw Error(`Action '${name}' is missing action.json in ${dir}`);
	const manifest = json(manifestFile) as ActionManifest;
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
		throw Error(`Expected JSON object in ${manifestFile}`);
	if (manifest.name !== undefined && manifest.name !== name)
		throw Error(`Action manifest name '${manifest.name}' does not match directory '${name}'`);
	if (!manifest.orchestrator || typeof manifest.orchestrator !== "object")
		throw Error(`Action '${name}' must define an 'orchestrator' object in action.json`);

	const settings = userSettings();
	const fallbackModel = manifest.model ?? settings.default_model;
	if (manifest.model) parseModelSpec(manifest.model);

	const rawAgents = manifest.agents ?? {};
	if (typeof rawAgents !== "object" || Array.isArray(rawAgents))
		throw Error(`Action '${name}' agents must be an object`);
	const agentNames = Object.keys(rawAgents);
	const agents: Record<string, ResolvedAgentSpec> = {};
	for (const agentName of agentNames) {
		if (!AGENT_NAME.test(agentName) || agentName === "orchestrator")
			throw Error(`Invalid subagent name '${agentName}' in action '${name}'`);
		agents[agentName] = resolveAgent(agentName, rawAgents[agentName], dir, fallbackModel, false, false, requireModel);
	}

	const orchestrator = resolveAgent(
		"orchestrator",
		manifest.orchestrator,
		dir,
		fallbackModel,
		true,
		agentNames.length > 0,
		requireModel,
	);

	const stages: StageConfig[] = [];
	if (manifest.stages !== undefined) {
		if (!Array.isArray(manifest.stages)) throw Error(`Action '${name}' stages must be an array`);
		for (const stage of manifest.stages) {
			if (!stage || typeof stage !== "object" || typeof stage.name !== "string" || !AGENT_NAME.test(stage.name))
				throw Error(`Invalid stage name in action '${name}'`);
			if (!Array.isArray(stage.parallel) || !stage.parallel.length)
				throw Error(`Stage '${stage.name}' in action '${name}' must list at least one agent in 'parallel'`);
			let rwCount = 0;
			for (const ref of stage.parallel) {
				if (typeof ref !== "string" || !agents[ref])
					throw Error(`Stage '${stage.name}' references undefined agent '${ref}'`);
				if (agents[ref].mode === "read-write") rwCount++;
			}
			if (rwCount > 1)
				throw Error(
					`Stage '${stage.name}' cannot run multiple read-write agents in parallel; use read-only agents or separate stages`,
				);
			stages.push({
				name: stage.name,
				parallel: stage.parallel,
				prompt: typeof stage.prompt === "string" ? stage.prompt : undefined,
			});
		}
	}

	const hooks: { prepare?: string; after?: string } = {};
	if (manifest.hooks) {
		if (typeof manifest.hooks !== "object" || Array.isArray(manifest.hooks))
			throw Error(`Action '${name}' hooks must be an object`);
		if (manifest.hooks.prepare)
			hooks.prepare = resolveInside(dir, manifest.hooks.prepare, `Action '${name}' prepare hook`);
		if (manifest.hooks.after) hooks.after = resolveInside(dir, manifest.hooks.after, `Action '${name}' after hook`);
	}

	const inputs = manifest.inputs ?? {};
	if (typeof inputs !== "object" || Array.isArray(inputs)) throw Error(`Action '${name}' inputs must be an object`);

	return {
		name,
		scope,
		dir: fs.realpathSync(dir),
		manifest,
		description: typeof manifest.description === "string" ? manifest.description : "",
		inputs,
		hooks,
		orchestrator,
		agents,
		stages,
	};
}

export function loadAction(name: string, project?: ProjectInfo, requireModel = true): LoadedAction {
	if (!isValidName(name)) throw Error("Use an action name with lowercase letters, digits and hyphens");
	if (project) {
		const projDir = join(projectActionsDir(project), name);
		if (fs.lstatSync(projDir, { throwIfNoEntry: false })?.isDirectory())
			return loadActionFromDir(name, projDir, "project", requireModel);
	}
	const globDir = join(globalActionsDir(), name);
	if (fs.lstatSync(globDir, { throwIfNoEntry: false })?.isDirectory())
		return loadActionFromDir(name, globDir, "global", requireModel);
	throw Error(
		`Unknown action '${name}'; create one with: pistick create action ${name}${project ? ` --project ${project.name}` : ""}`,
	);
}

export interface ActionSummary {
	name: string;
	scope: "global" | "project" | "project (overrides global)";
	description: string;
	dir: string;
}

export function listActions(project?: ProjectInfo): ActionSummary[] {
	const found = new Map<string, ActionSummary>();
	const scan = (base: string, scope: "global" | "project") => {
		if (!fs.existsSync(base)) return;
		for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
			if (!entry.isDirectory() || !isValidName(entry.name)) continue;
			const dir = join(base, entry.name);
			if (!fs.lstatSync(join(dir, "action.json"), { throwIfNoEntry: false })?.isFile()) continue;
			let description = "";
			try {
				const parsed = json(join(dir, "action.json")) as Partial<ActionManifest>;
				if (typeof parsed.description === "string") description = parsed.description;
			} catch {
				description = "(invalid action.json)";
			}
			const existing = found.get(entry.name);
			found.set(entry.name, {
				name: entry.name,
				scope: scope === "project" && existing ? "project (overrides global)" : scope,
				description,
				dir,
			});
		}
	};
	scan(globalActionsDir(), "global");
	if (project) scan(projectActionsDir(project), "project");
	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function validateAllActions(projects: ProjectInfo[]) {
	const checkDir = (base: string, scope: "global" | "project") => {
		if (!fs.existsSync(base)) return;
		for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
			if (!entry.isDirectory() || !isValidName(entry.name)) continue;
			const dir = join(base, entry.name);
			if (!fs.lstatSync(join(dir, "action.json"), { throwIfNoEntry: false })?.isFile()) continue;
			loadActionFromDir(entry.name, dir, scope, false);
		}
	};
	checkDir(globalActionsDir(), "global");
	for (const p of projects) checkDir(projectActionsDir(p), "project");
}

export function resolveInputs(action: LoadedAction, rawPairs: string[]): Record<string, string> {
	const provided: Record<string, string> = {};
	for (const pair of rawPairs) {
		const eq = pair.indexOf("=");
		if (eq <= 0) throw Error(`Expected --input KEY=VALUE, got: ${pair}`);
		const key = pair.slice(0, eq);
		const value = pair.slice(eq + 1);
		provided[key] = value;
	}
	const resolved: Record<string, string> = { ...provided };
	for (const [key, spec] of Object.entries(action.inputs)) {
		if (resolved[key] === undefined) {
			if (spec.default !== undefined) resolved[key] = spec.default;
			else if (spec.required) throw Error(`Missing required input '${key}' for action '${action.name}'`);
		}
	}
	return resolved;
}

export function createAction(name: string, project?: ProjectInfo): string {
	if (!isValidName(name)) throw Error("Use an action name with lowercase letters, digits and hyphens");
	const base = project ? projectActionsDir(project) : globalActionsDir();
	const dest = join(base, name);
	if (fs.lstatSync(dest, { throwIfNoEntry: false })) throw Error(`Action directory already exists: ${dest}`);
	fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
	const schemaRel = relative(dest, join(ASSETS, "action.schema.json"));
	const manifest: ActionManifest = {
		$schema: schemaRel,
		name,
		description: "Custom pi-stick action",
		orchestrator: {
			instructions: "instructions.md",
			mode: "read-write",
			tools: ["read", "write", "edit", "grep", "find", "codemode", "exec", "logs", "ps", "restart"],
			allowedServices: ["runner"],
		},
	};
	writeJson(join(dest, "action.json"), manifest);
	fs.writeFileSync(
		join(dest, "instructions.md"),
		`# ${name}\n\nDescribe the rules, verification steps, and expected output format for this action.\n`,
	);
	return dest;
}

export interface HookEnvContext {
	runId: string;
	project: ProjectInfo;
	action: Pick<LoadedAction, "name" | "dir">;
	runDir: string;
	repoDir: string;
	scratchDir: string;
	contextDir: string;
	ref?: string;
	baseHead?: string;
	prompt: string;
	inputs: Record<string, string>;
	exitCode?: number;
	reportFile?: string;
	patchFile?: string;
	outputsDir?: string;
}

export function runHook(name: keyof ActionHooks, source: string, envCtx: HookEnvContext) {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_STICK_RUN_ID: envCtx.runId,
		PI_STICK_PROJECT: envCtx.project.name,
		PI_STICK_PROJECT_DIR: envCtx.project.folder,
		PI_STICK_ACTION: envCtx.action.name,
		PI_STICK_ACTION_DIR: envCtx.action.dir,
		PI_STICK_HOOK_SOURCE_DIR: dirname(source),
		PI_STICK_RUN_DIR: envCtx.runDir,
		PI_STICK_REPO: envCtx.repoDir,
		PI_STICK_SCRATCH: envCtx.scratchDir,
		PI_STICK_CONTEXT: envCtx.contextDir,
		PI_STICK_REF: envCtx.ref ?? "",
		PI_STICK_BASE_HEAD: envCtx.baseHead ?? "",
		PI_STICK_PROMPT: envCtx.prompt,
		PI_STICK_INPUTS_JSON: JSON.stringify(envCtx.inputs),
	};
	if (envCtx.exitCode !== undefined) env.PI_STICK_EXIT_CODE = String(envCtx.exitCode);
	if (envCtx.reportFile) env.PI_STICK_REPORT_FILE = envCtx.reportFile;
	if (envCtx.patchFile) env.PI_STICK_PATCH_FILE = envCtx.patchFile;
	if (envCtx.outputsDir) env.PI_STICK_OUTPUTS_DIR = envCtx.outputsDir;
	run([join(envCtx.runDir, "action-snapshot", name)], { cwd: envCtx.repoDir, env });
}
