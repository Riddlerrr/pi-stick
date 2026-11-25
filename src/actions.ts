import * as fs from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import schema from "../action.schema.json" with { type: "json" };
import { ASSETS, json, ROOT, read, run, settingsPath, userSettings, writeJson } from "./platform.ts";
import { parseModelSpec } from "./system.ts";
import { isValidName, type ProjectInfo } from "./workspace.ts";

export const ALL_TOOLS = [
	"read",
	"write",
	"edit",
	"grep",
	"find",
	"codemode",
	"bash",
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
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
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
	orchestrator?: AgentConfig;
	agents?: Record<string, AgentConfig>;
	stageContext?: "previous" | "all";
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
	thinkingLevel?: AgentConfig["thinkingLevel"];
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
	orchestrator?: ResolvedAgentSpec;
	agents: Record<string, ResolvedAgentSpec>;
	stageContext?: ActionManifest["stageContext"];
	stages: StageConfig[];
}

// Only the schema shipped with the CLI is trusted; never load a manifest's $schema URL.
interface Field {
	type?: string;
	$ref?: string;
	enum?: string[];
	pattern?: string;
	minimum?: number;
	minItems?: number;
	items?: Field;
	properties?: Record<string, Field>;
	propertyNames?: Field;
	required?: string[];
	additionalProperties?: Field | boolean;
}

function validateField(value: unknown, field: Field, path: string): void {
	if (field.$ref === "#/$defs/agentConfig") {
		validateField(value, schema.$defs.agentConfig, path);
		return;
	}
	switch (field.type) {
		case "object": {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(`${path}: expected object`);
			for (const key of field.required ?? [])
				if (!Object.hasOwn(value, key)) throw Error(`${path}.${key}: required field`);
			for (const [key, item] of Object.entries(value)) {
				const at = `${path}.${key}`;
				if (field.propertyNames) validateField(key, field.propertyNames, at);
				const child =
					field.properties && Object.hasOwn(field.properties, key)
						? field.properties[key]
						: field.additionalProperties;
				if (child === false) throw Error(`${at}: unknown field`);
				if (typeof child === "object") validateField(item, child, at);
			}
			break;
		}
		case "array":
			if (!Array.isArray(value) || value.length < (field.minItems ?? 0))
				throw Error(`${path}: expected array with at least ${field.minItems ?? 0} items`);
			if (field.items) for (const [i, item] of value.entries()) validateField(item, field.items, `${path}[${i}]`);
			break;
		case "integer":
			if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (field.minimum ?? -Infinity))
				throw Error(`${path}: expected integer >= ${field.minimum}`);
			break;
		case "boolean":
			if (typeof value !== "boolean") throw Error(`${path}: expected boolean`);
			break;
		case undefined: // propertyNames supplies only a pattern.
		case "string":
			if (typeof value !== "string") throw Error(`${path}: expected string`);
			if (field.pattern && !new RegExp(field.pattern).test(value)) throw Error(`${path}: invalid name`);
			if (field.enum && !field.enum.includes(value))
				throw Error(`${path}: expected one of ${field.enum.join(", ")}`);
			break;
		default:
			throw Error(`Unsupported action schema type: ${field.type}`);
	}
}
const DEFAULT_RO_TOOLS: ToolName[] = ["read", "write", "edit", "codemode", "bash", "logs", "ps"];
const DEFAULT_RW_TOOLS: ToolName[] = [...DEFAULT_RO_TOOLS, "restart"];

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
	const mode: AgentMode = raw.mode ?? (isOrchestrator ? "read-write" : "read-only");
	const model = raw.model ?? fallbackModel ?? "";
	if (model) parseModelSpec(model);
	else if (requireModel)
		throw Error(
			`No model configured for agent '${name}'; set 'model' in action.json or 'default_model' in ${settingsPath()}`,
		);
	let instructions = "";
	if (raw.instructions !== undefined) {
		instructions = read(resolveInside(actionDir, raw.instructions, `Agent '${name}' instructions`));
	}
	let tools: ToolName[];
	if (raw.tools !== undefined) {
		tools = [...new Set(raw.tools)];
	} else {
		tools = mode === "read-write" ? [...DEFAULT_RW_TOOLS] : [...DEFAULT_RO_TOOLS];
		if (isOrchestrator && hasSubagents) tools.push("delegate");
	}
	if (!isOrchestrator && tools.includes("delegate"))
		throw Error(`Subagent '${name}' cannot enable 'delegate'; only the orchestrator may delegate`);
	const allowedServices = raw.allowedServices ?? ["*"];
	if (allowedServices.some((s) => !s.length))
		throw Error(`Agent '${name}' allowedServices must be an array of service names`);
	return {
		name,
		description: raw.description,
		model,
		instructions,
		mode,
		tools,
		allowedServices,
		thinkingLevel: raw.thinkingLevel,
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
	validateField(manifest, schema, "action.json");
	if (manifest.name !== undefined && manifest.name !== name)
		throw Error(`Action manifest name '${manifest.name}' does not match directory '${name}'`);

	const settings = userSettings();
	const fallbackModel = manifest.model ?? settings.default_model;
	if (manifest.model) parseModelSpec(manifest.model);

	const rawAgents = manifest.agents ?? {};
	const agentNames = Object.keys(rawAgents);
	const agents: Record<string, ResolvedAgentSpec> = Object.create(null);
	for (const agentName of agentNames) {
		if (agentName === "orchestrator") throw Error(`Invalid subagent name '${agentName}' in action '${name}'`);
		agents[agentName] = resolveAgent(agentName, rawAgents[agentName], dir, fallbackModel, false, false, requireModel);
	}

	if (!manifest.orchestrator && manifest.stages?.at(-1)?.parallel.length !== 1)
		throw Error("An action without an orchestrator requires a final stage with exactly one agent");
	const orchestrator =
		manifest.orchestrator &&
		resolveAgent(
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
		const names = new Set<string>();
		for (const [i, stage] of manifest.stages.entries()) {
			if (names.has(stage.name)) throw Error(`stages[${i}].name: duplicate stage '${stage.name}'`);
			names.add(stage.name);
			const seen = new Set<string>();
			let rwCount = 0;
			for (const ref of stage.parallel) {
				if (seen.has(ref)) throw Error(`Stage '${stage.name}' repeats agent '${ref}'`);
				seen.add(ref);
				if (!Object.hasOwn(agents, ref)) throw Error(`Stage '${stage.name}' references undefined agent '${ref}'`);
				if (agents[ref].mode === "read-write") rwCount++;
			}
			if (rwCount > 1)
				throw Error(
					`Stage '${stage.name}' cannot run multiple read-write agents in parallel; use read-only agents or separate stages`,
				);
			stages.push(stage);
		}
	}

	const hooks: { prepare?: string; after?: string } = {};
	if (manifest.hooks) {
		if (manifest.hooks.prepare)
			hooks.prepare = resolveInside(dir, manifest.hooks.prepare, `Action '${name}' prepare hook`);
		if (manifest.hooks.after) hooks.after = resolveInside(dir, manifest.hooks.after, `Action '${name}' after hook`);
	}

	const inputs = manifest.inputs ?? {};

	return {
		name,
		scope,
		dir: fs.realpathSync(dir),
		manifest,
		description: manifest.description ?? "",
		inputs,
		hooks,
		orchestrator,
		agents,
		stageContext: manifest.stageContext,
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
	const resolved: Record<string, string> = Object.create(null);
	for (const pair of rawPairs) {
		const eq = pair.indexOf("=");
		if (eq <= 0) throw Error(`Expected --input KEY=VALUE, got: ${pair}`);
		const key = pair.slice(0, eq);
		if (!Object.hasOwn(action.inputs, key)) throw Error(`Unknown --input '${key}' for action '${action.name}'`);
		resolved[key] = pair.slice(eq + 1);
	}
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
		orchestrator: { instructions: "instructions.md" },
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
		PI_STICK_EXIT_CODE: envCtx.exitCode?.toString(),
		PI_STICK_REPORT_FILE: envCtx.reportFile,
		PI_STICK_PATCH_FILE: envCtx.patchFile,
		PI_STICK_OUTPUTS_DIR: envCtx.outputsDir,
	};
	run([join(envCtx.runDir, "action-snapshot", name)], { cwd: envCtx.repoDir, env });
}
