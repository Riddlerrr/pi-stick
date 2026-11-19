import * as fs from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createProject } from './workspace.ts';
import { target } from './projects.ts';
import { doctor, update } from './system.ts';
import { STATE, read } from './platform.ts';
import { ACTIVE, LOCK, cleanup, follow, launch, resumeURL, runDir, tryLock, worker } from './runs.ts';

const usage = {
  create: 'create project NAME [--repo URL]',
  pull: 'pull PR_URL',
  review: 'review (PR_URL | --follow RUN_ID | --resume RUN_ID)',
  cleanup: 'cleanup [--dry-run] [--days DAYS]',
  doctor: 'doctor',
  update: 'update [--yes]',
};
const help =
  'Private project workspaces and PR reviews\n\nUsage:\n' +
  Object.values(usage)
    .map((s) => '  pi-stick ' + s)
    .join('\n');
type Action =
  | { cmd: 'create'; name: string; repo?: string }
  | { cmd: 'pull'; url: string }
  | { cmd: 'doctor' }
  | { cmd: 'update'; yes: boolean }
  | { cmd: 'cleanup'; days: number; dry: boolean }
  | { cmd: 'review'; url: string }
  | { cmd: 'resume'; id: string }
  | { cmd: 'follow'; id: string };
function parse(cmd: string, args: string[]): Action {
  const flags = <const T extends Record<string, { type: 'string' | 'boolean' }>>(options: T) =>
    parseArgs({ args, options, allowPositionals: true });
  switch (cmd) {
    case 'create': {
      const { positionals: p, values: v } = flags({ repo: { type: 'string' } });
      if (p.length === 2 && p[0] === 'project') return { cmd, name: p[1], repo: v.repo };
      break;
    }
    case 'pull': {
      const { positionals: p } = flags({});
      if (p.length === 1) return { cmd, url: p[0] };
      break;
    }
    case 'review': {
      const { positionals: p, values: v } = flags({ resume: { type: 'string' }, follow: { type: 'string' } });
      if (p.length + Object.keys(v).length !== 1) break;
      if (typeof v.follow === 'string') return { cmd: 'follow', id: v.follow };
      if (typeof v.resume === 'string') return { cmd: 'resume', id: v.resume };
      return { cmd, url: p[0] };
    }
    case 'cleanup': {
      const { positionals: p, values: v } = flags({
        days: { type: 'string' },
        'dry-run': { type: 'boolean' },
      });
      const days = String(v.days ?? 7);
      if (!/^\d+$/.test(days) || !Number.isSafeInteger(Number(days)))
        throw Error('Days must be a nonnegative integer');
      if (!p.length) return { cmd, days: Number(days), dry: v['dry-run'] === true };
      break;
    }
    case 'doctor':
      if (!args.length) return { cmd };
      break;
    case 'update': {
      const { positionals: p, values: v } = flags({ yes: { type: 'boolean' } });
      if (!p.length) return { cmd, yes: v.yes === true };
      break;
    }
  }
  throw Error(Object.hasOwn(usage, cmd) ? 'Usage: pi-stick ' + usage[cmd as keyof typeof usage] : help);
}
export async function main([cmd, ...args]: string[]) {
  process.umask(0o077);
  if (cmd === '--help' || cmd === '-h') {
    console.log(help);
    return 0;
  }
  if (Object.hasOwn(usage, cmd) && args.some((s) => s === '--help' || s === '-h')) {
    console.log('Usage: pi-stick ' + usage[cmd as keyof typeof usage]);
    return 0;
  }
  if (cmd === '_worker' && args.length === 2) {
    const dir = runDir(args[0]),
      inherited = fs.fstatSync(3),
      lock = fs.statSync(LOCK);
    if (inherited.ino !== lock.ino || inherited.dev !== lock.dev || !tryLock(3) || read(ACTIVE) !== args[0])
      throw Error('Invalid worker invocation');
    return worker(dir, target(args[1]));
  }
  const action = parse(cmd, args);
  for (const d of ['runs', 'projects', 'sessions']) fs.mkdirSync(join(STATE, d), { recursive: true });
  if (action.cmd === 'follow') return follow(action.id);
  const fd = fs.openSync(LOCK, 'a');
  let id: string;
  try {
    if (!tryLock(fd)) throw Error('pi-stick busy; wait or follow the active review');
    if (action.cmd === 'doctor') {
      const ok = doctor();
      if (fs.existsSync(ACTIVE)) {
        console.log('FAIL unfinished run:', read(ACTIVE));
        return 1;
      }
      return ok ? 0 : 1;
    }
    if (action.cmd !== 'resume' && fs.existsSync(ACTIVE))
      throw Error(`Unsettled review ${read(ACTIVE)}; preserve state and investigate before retrying`);
    switch (action.cmd) {
      case 'create':
        console.log('Created:', await createProject(action.name, action.repo));
        return 0;
      case 'cleanup':
        await cleanup(action.days, action.dry);
        return 0;
      case 'update':
        await update(action.yes);
        return 0;
      case 'pull': {
        const pr = target(action.url),
          data = await pr.pull();
        console.log(`Prepared ${pr.repo} at ${data.head}. No model call.`);
        return 0;
      }
      case 'review':
      case 'resume': {
        const url = action.cmd === 'resume' ? resumeURL(action.id) : action.url;
        id = await launch(target(url), url, fd, action.cmd === 'resume' ? action.id : undefined);
        break;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return follow(id);
}
