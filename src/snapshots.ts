import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { command, output, run, json, writeJson, touch } from './platform.ts';

const THREAD_QUERY = `query($owner:String!, $repo:String!, $number:Int!, $endCursor:String) {
  repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
    reviewThreads(first:100,after:$endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id isResolved isOutdated path line
        comments(first:100) { pageInfo { hasNextPage } nodes {
          databaseId url body createdAt author { login } replyTo { databaseId }
        } }
      }
    }
  } }
}`;
export interface Manifest {
  repository: string;
  pr: number;
  head: string;
  base_tip: string;
  merge_base: string;
  previous_head: string | null;
  prepared_at: string;
}
interface PullRequest {
  head: { sha: string };
  base: { sha: string; repo: { full_name: string } };
  body: string | null;
  changed_files: number;
}
const gh = (...args: string[]) => JSON.parse(output(['gh', 'api', ...args]));
const get = (path: string) => gh('--method', 'GET', path);
const pages = (path: string): unknown[][] => gh('--method', 'GET', '--paginate', '--slurp', path);
function fetchPR(repo: string, number: number): PullRequest {
  const pr = get(`repos/${repo}/pulls/${number}`);
  if (
    pr.base.repo.full_name.toLowerCase() !== repo.toLowerCase() ||
    ![pr.head.sha, pr.base.sha].every((s) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s))
  )
    throw Error('Unexpected repository or commit SHA');
  return pr;
}
export function fresh(data: Pick<Manifest, 'repository' | 'pr' | 'head' | 'base_tip'>) {
  const latest = fetchPR(data.repository, data.pr);
  if (latest.head.sha !== data.head || latest.base.sha !== data.base_tip)
    throw Error('PR changed; rerun pull before reviewing');
}
function context(repository: string, number: number, pr: PullRequest) {
  const [owner, repo] = repository.split('/'),
    prefix = `repos/${repository}`;
  const threads = gh(
    'graphql',
    '--paginate',
    '--slurp',
    '-f',
    `query=${THREAD_QUERY}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `repo=${repo}`,
    '-F',
    `number=${number}`,
  );
  const nodes: unknown[] = [];
  for (const page of threads) {
    if (page.errors?.length) throw Error('GraphQL reported errors');
    for (const thread of page.data.repository.pullRequest.reviewThreads.nodes) {
      if (thread.comments.pageInfo.hasNextPage)
        throw Error('A thread exceeds 100 replies; export it fully before reviewing');
      nodes.push(thread);
    }
  }
  const changed = pages(`${prefix}/pulls/${number}/files?per_page=100`).flat();
  if (changed.length !== pr.changed_files) throw Error('GitHub file list is incomplete');
  const data: Record<string, unknown> = {
    pr,
    'review-threads': nodes,
    'changed-files': changed,
    reviews: pages(`${prefix}/pulls/${number}/reviews?per_page=100`).flat(),
    discussion: pages(`${prefix}/issues/${number}/comments?per_page=100`).flat(),
    checks: pages(`${prefix}/commits/${pr.head.sha}/check-runs?per_page=100`),
    statuses: get(`${prefix}/commits/${pr.head.sha}/status`),
    actions: pages(`${prefix}/actions/runs?head_sha=${pr.head.sha}&per_page=100`),
  };
  const issueURL = new RegExp(
    `https://github\\.com/${repository.replaceAll('.', '\\.')}/issues/(\\d+)`,
    'gi',
  );
  for (const issue of new Set(Array.from((pr.body ?? '').matchAll(issueURL), (m) => m[1]))) {
    data[`issue-${issue}`] = get(`${prefix}/issues/${issue}`);
    data[`issue-${issue}-comments`] = pages(`${prefix}/issues/${issue}/comments?per_page=100`).flat();
  }
  return data;
}
export const gitCommand = (repo: string) => [
  'git',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  `safe.directory=${repo}`,
  '-c',
  'submodule.recurse=false',
  '-C',
  repo,
];
function checkIdle(repo: string) {
  const target = fs.statSync(repo);
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try {
      let path = fs.realpathSync(`/proc/${pid}/cwd`);
      while (path !== '/') {
        const stat = fs.statSync(path);
        if (stat.ino === target.ino && stat.dev === target.dev)
          throw Error(`A process is using this checkout (PID ${pid}); close shells/commands before retrying`);
        path = dirname(path);
      }
    } catch (e) {
      if (!['ENOENT', 'EACCES', 'EPERM', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
    }
  }
}
function checkCollisions(git: string[], head: string) {
  // latin1 is a lossless byte mapping, even for non-UTF-8 Git paths.
  const paths = (...args: string[]) =>
    command([...git, ...args])
      .toString('latin1')
      .split('\0')
      .filter(Boolean);
  const untracked = new Set(paths('ls-files', '--others', '-z').map((p) => p.replace(/\/+$/, '')));
  const target = new Set(paths('ls-tree', '-rz', '--name-only', head));
  function collides(path: string, others: Set<string>) {
    for (;;) {
      if (others.has(path)) return true;
      const slash = path.lastIndexOf('/');
      if (slash === -1) return false;
      path = path.slice(0, slash);
    }
  }
  if (
    Array.from(untracked).some((p) => collides(p, target)) ||
    Array.from(target).some((p) => collides(p, untracked))
  )
    throw Error('Untracked/ignored files would be overwritten; preserve and relocate them before retrying');
}

export function prepare(repository: string, number: number, review: string): Manifest {
  const artifacts = ['context', 'manifest.json', 'pr.diff'];
  const repo = join(review, 'repo'),
    marker = join(review, '.pull-incomplete'),
    existing = fs.existsSync(review);
  const git = gitCommand(repo),
    out = (...args: string[]) => output([...git, ...args]);
  for (const path of [review, repo, marker, ...[...artifacts, 'history'].map((n) => join(review, n))]) {
    if (fs.lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
      throw Error('Refusing symlinked review checkout or metadata');
  }
  if (existing) {
    if (fs.existsSync(marker))
      throw Error('Previous pull was interrupted; preserve checkout for manual recovery');
    const previous = json(join(review, 'manifest.json'));
    if (previous.repository.toLowerCase() !== repository || previous.pr !== number)
      throw Error('Snapshot belongs to a different PR');
    if (!fs.lstatSync(join(repo, '.git')).isDirectory() || out('rev-parse', '--show-toplevel') !== repo)
      throw Error('Expected a standalone disposable Git checkout');
    if (command([...git, 'diff', '--cached', '--name-only', '--ignore-submodules=none', 'HEAD', '--']).length)
      throw Error('Staged changes block this pull; preserve them before retrying');
  }
  const pr = fetchPR(repository, number);
  if (!existing) {
    fs.mkdirSync(review);
    touch(marker);
    run(['git', 'init', repo]);
  }
  const head = pr.head.sha,
    base = pr.base.sha;
  run([
    ...git,
    '-c',
    'credential.helper=',
    '-c',
    'credential.https://github.com.helper=!gh auth git-credential',
    'fetch',
    '--no-tags',
    `https://github.com/${repository}.git`,
    head,
    base,
  ]);
  const merge_base = out('merge-base', base, head),
    snapshots = context(repository, number, pr);
  const old = existing ? out('rev-parse', 'HEAD') : null;
  const manifest = {
    repository,
    pr: number,
    head,
    base_tip: base,
    merge_base,
    previous_head: old,
    prepared_at: new Date().toISOString(),
  };
  fresh(manifest);
  if (existing) {
    checkIdle(repo);
    checkCollisions(git, head);
  }
  const stage = fs.mkdtempSync(join(dirname(review), '.prepare-'));
  try {
    fs.mkdirSync(join(stage, 'context'));
    for (const [name, value] of Object.entries(snapshots))
      writeJson(join(stage, 'context', name + '.json'), value);
    writeJson(join(stage, 'manifest.json'), manifest);
    fs.writeFileSync(join(stage, 'pr.diff'), command([...git, 'diff', '--binary', merge_base, head]));
    if (old) {
      const id = randomUUID().replaceAll('-', ''),
        history = join(review, 'history', id);
      fs.mkdirSync(history, { recursive: true });
      for (const name of artifacts)
        fs.cpSync(join(review, name), join(history, name), { recursive: true, verbatimSymlinks: true });
      fs.writeFileSync(join(history, 'tracked-changes.patch'), command([...git, 'diff', '--binary', 'HEAD']));
      run([...git, 'update-ref', `refs/review-history/${id}`, old]);
    }
    touch(marker);
    run([...git, 'update-ref', '--no-deref', 'HEAD', head]); // Don't move the operator's local branch.
    run([...git, 'reset', '--hard', head]);
    for (const [ref, sha] of [
      ['review-head', head],
      ['review-base-tip', base],
      ['review-base', merge_base],
    ])
      run([...git, 'update-ref', `refs/heads/${ref}`, sha]);
    for (const name of artifacts) {
      if (name === 'context') fs.rmSync(join(review, name), { recursive: true, force: true });
      fs.renameSync(join(stage, name), join(review, name));
    }
    fresh(manifest);
    fs.unlinkSync(marker);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  return manifest;
}
