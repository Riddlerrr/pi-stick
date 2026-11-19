import * as fs from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { output, run, ROOT, STATE, json, read, prompt } from './platform.ts';
import { registered } from './workspace.ts';
import { Project } from './projects.ts';

const COMPOSE = ['docker', 'compose', '-f', join(ROOT, 'compose.yaml')];
export const EXEC = [...COMPOSE, 'exec', '-T', 'pi-stick', 'node', '/app/reviewer.ts'];
const IMAGE = 'homelab/pi-stick:current';
export const MODEL = 'gpt-6.2-sol';
export const runId = () => randomUUID().replaceAll('-', '');
export function settings(id: string, offline = false) {
  const catalog = json(join(homedir(), '.pi/agent/models-store.json'));
  const models = catalog['openai-codex'].models.filter((m: { id: string }) => m.id === MODEL);
  if (models.length !== 1) throw Error(`Expected ${MODEL} in local Pi catalog; refresh Pi models first`);
  // This object travels only over stdin. Never log it or pass it in argv/environment.
  const token = offline
    ? 'offline-fixture'
    : output(['pi', 'auth', 'print-bearer-token', '--model', `openai-codex/${MODEL}`, '--min-expiry', '1h']);
  return { model: models[0], token, id };
}
function probe(cmd: string[], live = false) {
  const id = runId();
  try {
    const request = { ...settings(id, !live), check: true, instructions: 'Offline diagnostic.' };
    if (JSON.parse(output(cmd, JSON.stringify(request) + '\n')).ready !== true)
      throw Error('Unexpected harness self-check response');
  } finally {
    if (live)
      for (const ext of ['', '-wal', '-shm'])
        fs.rmSync(join(STATE, 'sessions', `${id}.sqlite${ext}`), { force: true });
  }
}
export function isolation() {
  const [c] = JSON.parse(output(['docker', 'inspect', 'pi-stick']));
  const mounts = c.Mounts.filter((m: { Type: string }) => m.Type !== 'tmpfs');
  if (
    !c.State.Running ||
    !c.HostConfig.CapDrop?.includes('ALL') ||
    !c.HostConfig.SecurityOpt?.includes('no-new-privileges:true') ||
    mounts.length !== 1 ||
    mounts[0].Source !== join(STATE, 'sessions') ||
    mounts[0].Destination !== '/sessions' ||
    c.Config.Labels?.['com.docker.compose.project'] !== 'pi-stick' ||
    c.HostConfig.Privileged ||
    Object.keys(c.HostConfig.PortBindings ?? {}).length ||
    !c.HostConfig.ReadonlyRootfs ||
    !process.getuid?.() ||
    output([...COMPOSE, 'exec', '-T', 'pi-stick', 'id', '-u']) !== String(process.getuid())
  )
    throw Error('Unexpected container identity, privilege, mount, user or ports');
}
export function doctor() {
  const checks: [string, () => unknown][] = [
    ['Docker Compose', () => output([...COMPOSE, 'config', '--quiet'])],
    ['Reviewer identity and isolation', isolation],
    [`Pi subscription, ${MODEL}, durable tools and SQLite (no model call)`, () => probe(EXEC, true)],
    [
      'Registered GitHub projects and review recipes',
      () => {
        for (const [repo, folder] of registered()) {
          new Project(repo, 1, folder).config();
          output(['gh', 'api', `repos/${repo}`, '--jq', '.full_name']);
        }
      },
    ],
  ];
  let ok = true;
  for (const [label, check] of checks) {
    try {
      check();
      console.log('OK  ', label);
    } catch {
      ok = false;
      console.log('FAIL', label);
      if (check === isolation) break; // Never send credentials to an unexpected container.
    }
  }
  return ok;
}
export async function update(yes: boolean) {
  isolation();
  if (
    !yes &&
    (await prompt('Build latest pi-stick and replace it after checks? [y/N] ')).toLowerCase() !== 'y'
  )
    return;
  const id = runId().slice(0, 12),
    candidate = `homelab/pi-stick:candidate-${id}`,
    rollback = `homelab/pi-stick:before-${id}`;
  const files = ['package.json', 'package-lock.json', 'Dockerfile'];
  const stage = fs.mkdtempSync(join(tmpdir(), 'pi-stick-update-'));
  const copy = (name: string, from: string, to: string) => fs.copyFileSync(join(from, name), join(to, name));
  try {
    for (const f of [...files, 'reviewer.ts', '.dockerignore']) copy(f, ROOT, stage);
    const base = 'node:current-bookworm-slim';
    const digest = /^Digest:\s+(sha256:[0-9a-f]{64})$/m.exec(
      output(['docker', 'buildx', 'imagetools', 'inspect', base]),
    )?.[1];
    const npm = output(['npm', 'view', 'npm@latest', 'version']);
    if (!digest || !/^\d+\.\d+\.\d+$/.test(npm))
      throw Error('Cannot resolve latest Node base digest or npm release');
    const dockerfile = join(stage, 'Dockerfile');
    fs.writeFileSync(
      dockerfile,
      read(dockerfile)
        .replace(/^FROM .*/, `FROM ${base}@${digest}`)
        .replace(/^ARG NPM_VERSION=.*$/m, `ARG NPM_VERSION=${npm}`),
    );
    fs.unlinkSync(join(stage, 'package-lock.json'));
    const deps = Object.keys(json(join(stage, 'package.json')).dependencies).map((d) => d + '@latest');
    run(
      [
        'npm',
        'install',
        '--save-exact',
        '--package-lock-only',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        ...deps,
      ],
      { cwd: stage },
    );
    run(['docker', 'build', '--pull', '--no-cache', '-t', candidate, stage]);
    probe([
      'docker',
      'run',
      '--rm',
      '-i',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--tmpfs',
      '/sessions:uid=1000,mode=0700',
      candidate,
      'node',
      '/app/reviewer.ts',
    ]);
    const backup = join(STATE, 'backups', id);
    fs.mkdirSync(backup, { recursive: true });
    for (const f of files) copy(f, ROOT, backup);
    fs.cpSync(join(STATE, 'sessions'), join(backup, 'sessions'), { recursive: true });
    run(['docker', 'tag', output(['docker', 'inspect', 'pi-stick', '-f', '{{.Image}}']), rollback]);
    console.log(`Backup: ${backup}; previous image: ${rollback}`);
    const up = [...COMPOSE, 'up', '-d', '--no-build', '--pull', 'never', '--force-recreate', 'pi-stick'];
    try {
      run(['docker', 'tag', candidate, IMAGE]);
      run(up);
      isolation();
      probe(EXEC, true);
      for (const f of files) copy(f, stage, ROOT);
    } catch (err) {
      for (const f of files) copy(f, backup, ROOT);
      run(['docker', 'tag', rollback, IMAGE]);
      run(up);
      throw err;
    }
    console.log('Updated pi-stick. Project runners unchanged.');
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
