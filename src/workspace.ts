import * as fs from 'node:fs';
import { dirname, basename, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ROOT, STATE, read, json, writeJson, run, prompt } from './platform.ts';

export const NAME = '[a-z0-9][a-z0-9-]{0,62}';
export const SLUG = '[A-Za-z0-9-]+/[A-Za-z0-9_][A-Za-z0-9_.-]*';
const validName = new RegExp(`^${NAME}$`);
function canonical(path: string): string {
  if (fs.lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() || fs.existsSync(path))
    return fs.realpathSync(path);
  return join(canonical(dirname(path)), basename(path));
}
const within = (path: string, parent: string) =>
  path === parent || path.startsWith(parent.endsWith('/') ? parent : parent + '/');

export function projectsDir() {
  const file = join(homedir(), '.config/pi-stick/settings.json');
  const config = fs.existsSync(file) ? json(file) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw Error(`Expected an object in ${file}`);
  const path = 'projects_dir' in config ? config.projects_dir : join(ROOT, 'projects');
  if (typeof path !== 'string' || !(isAbsolute(path) || path.startsWith('~/')))
    throw Error('projects_dir must be an absolute path (or start with ~/)');
  const dir = canonical(resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path));
  if (
    within(ROOT, dir) ||
    [STATE, join(ROOT, '.git'), join(ROOT, 'project-template')].some((p) => within(dir, p))
  )
    throw Error('Choose a dedicated projects directory outside pi-stick state, template and Git metadata');
  return dir;
}

export function registered() {
  const dir = projectsDir();
  const result = new Map<string, string>();
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !validName.test(entry.name)) continue;
    const folder = join(dir, entry.name),
      file = join(folder, 'project.json');
    if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    const repo = json(file)?.github;
    if (repo === null) continue;
    if (typeof repo !== 'string' || !new RegExp(`^${SLUG}$`).test(repo))
      throw Error(`Expected GitHub owner/repo or null in ${file}`);
    if (result.has(repo.toLowerCase())) throw Error(`Multiple projects registered for ${repo}`);
    result.set(repo.toLowerCase(), folder);
  }
  return result;
}

export async function createProject(name: string, source?: string) {
  if (!validName.test(name)) throw Error('Use a project name with lowercase letters, digits and hyphens');
  const dir = projectsDir(),
    dest = join(dir, name);
  if (fs.lstatSync(dest, { throwIfNoEntry: false })) throw Error(`Project directory already exists: ${dest}`);
  source ??= await prompt('Git URL (or absolute local repository path): ');
  if (!/^(https:\/\/|ssh:\/\/|git@|\/)/.test(source))
    throw Error('Expected an HTTPS or SSH Git URL, or an absolute local path');
  const github =
    new RegExp(`^(?:https://github\\.com/|git@github\\.com:|ssh://git@github\\.com/)(${SLUG})/*$`, 'i')
      .exec(source)?.[1]
      .replace(/\.git$/, '')
      .toLowerCase() ?? null;
  if (github && registered().has(github)) throw Error(`Already registered: ${github}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(join(dir, '.create-')),
    stage = join(tmp, name);
  try {
    fs.cpSync(join(ROOT, 'project-template'), stage, { recursive: true });
    fs.chmodSync(stage, 0o700);
    const compose = join(stage, 'compose.yaml');
    fs.writeFileSync(compose, `name: pi-dev-${name}\n` + read(compose));
    writeJson(join(stage, 'project.json'), { github });
    run(
      [
        'git',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'credential.https://github.com.helper=!gh auth git-credential',
        'clone',
        '--no-local',
        '--',
        source,
        join(stage, 'repo'),
      ],
      { env: { ...process.env, GIT_ALLOW_PROTOCOL: 'https:ssh:file' } },
    );
    fs.renameSync(stage, dest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return dest;
}
