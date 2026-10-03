import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflows = [
  ['refresh-pricing.yml', 'refresh'],
  ['refresh-performance.yml', 'perf'],
  ['refresh-aa.yml', 'refresh-aa'],
].map(([file, job]) => {
  const source = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
  const body = source.split(`\n  ${job}:\n`)[1]?.split(/^  [\w-]+:\n/m)[0];
  assert.ok(body, `${file}: missing ${job} job`);
  return { file, source, body };
});

for (const { file, source, body } of workflows) {
  test(`${file}: only main refreshes use the latest main checkout`, () => {
    const condition = body.match(/^    if: (.+)/m)?.[1];
    assert.ok(condition, 'refresh must be main-only before selecting main explicitly');
    const shouldRun = new Function('github', `return (${condition});`);
    for (const event_name of ['schedule', 'workflow_dispatch']) {
      assert.equal(shouldRun({ ref: 'refs/heads/main', event_name }), true);
      assert.equal(shouldRun({ ref: 'refs/heads/feature', event_name }), false);
      assert.equal(shouldRun({ ref: 'refs/tags/main', event_name }), false);
    }
    const checkout = body.match(/      - uses: actions\/checkout@v4\n([\s\S]*?)(?=\n      - )/)?.[1];
    assert.match(checkout, /^          ref: main$/m);
    assert.match(checkout, /^          persist-credentials: false$/m);
    assert.match(source, /group: repo-refresh\n  cancel-in-progress: false/);
    assert.doesNotMatch(body, /git (?:push[^\n]*--force|pull|rebase)/);
  });

  test(`${file}: unchanged reruns build, deploy, and verify, but ordinary no-op runs skip`, () => {
    const downstream = body.slice(body.indexOf('      - name: Generate SEO'));
    const conditions = [...downstream.matchAll(/^        if: (.+)$/gm)].map(m => m[1]);
    assert.equal(conditions.length, 6, 'SEO, SEO check, cache bust, minify, deploy, smoke');
    for (const condition of conditions) {
      const shouldRun = new Function('steps', 'github', `return (${condition});`);
      for (const [changed, force, run_attempt, expected] of [
        [undefined, undefined, '1', false],
        ['true', undefined, '1', true],
        [undefined, 'true', '1', true],
        [undefined, 'false', '2', true],
      ]) {
        assert.equal(shouldRun(
          { commit: { outputs: { changed } } },
          { event: { inputs: { force } }, run_attempt },
        ), expected, `${condition}: ${JSON.stringify({ changed, force, run_attempt })}`);
      }
      assert.doesNotMatch(condition, /always\(|failure\(/, 'earlier failures must still stop deployment');
    }
  });

  test(`${file}: every Pages deploy uses the shared retry script and deployment credentials`, () => {
    const deployments = [...source.matchAll(/      - name: Deploy to Cloudflare Pages\n([\s\S]*?)(?=\n      - )/g)];
    assert.equal(deployments.length, file === 'refresh-pricing.yml' ? 2 : 1);
    for (const [, step] of deployments) {
      assert.match(step, /run: node scripts\/deploy-pages\.mjs/);
      assert.match(step, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
      assert.match(step, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
      assert.doesNotMatch(step, /continue-on-error|CLOUDFLARE_D1_TOKEN/);
    }
  });
}

test('push tests and deploy still check out the event commit, not latest main', () => {
  const source = workflows[0].source;
  const testJob = source.split('\n  test:\n')[1].split('\n  refresh:\n')[0];
  const deployJob = source.split('\n  deploy:\n')[1];
  for (const job of [testJob, deployJob]) {
    assert.match(job, /uses: actions\/checkout@v4/);
    assert.doesNotMatch(job, /^          ref:/m);
  }
  assert.match(deployJob, /needs: test/);
});

for (const statuses of [[0], [1, 1, 0], [1, 1, 1], [null, null, null]]) {
  test(`Pages deploy results ${JSON.stringify(statuses)} stop on success or fail after three attempts`, async () => {
    const { deployPages } = await import('../scripts/deploy-pages.mjs');
    const calls = [];
    const waits = [];
    const logs = [];
    const run = deployPages({
      execute: (command, args, options) => {
        const status = statuses[calls.length];
        calls.push({ command, args, options });
        return status === null ? { status, error: new Error('spawn failed') } : { status };
      },
      wait: async ms => waits.push(ms),
      log: message => logs.push(message),
    });
    if (statuses.at(-1) === 0) await run;
    else await assert.rejects(run, /Pages deploy failed after 3 attempts/);
    assert.equal(calls.length, statuses.length);
    assert.deepEqual(waits, statuses.length === 1 ? [] : [10000, 20000]);
    for (const { command, args, options } of calls) {
      assert.equal(command, 'npx');
      assert.deepEqual(args, ['--yes', 'wrangler@3.90.0', 'pages', 'deploy', 'public',
        '--project-name', 'payg-inference-calculator', '--branch', 'main']);
      assert.equal(options.stdio, 'inherit', 'keep Wrangler diagnostics in the Actions log');
    }
    assert.match(logs.join('\n'), /attempt 1\/3/);
    if (statuses.length === 3) assert.match(logs.join('\n'), /attempt 3\/3/);
  });
}

test('a rerun can push after the previous refresh committed; no-op and concurrent pushes stay safe', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-refresh-recovery-'));
  try {
    const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test',
      '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const remote = join(root, 'remote.git');
    git(root, 'init', '--bare', '--initial-branch=main', remote);
    const first = join(root, 'first');
    git(root, 'clone', remote, first);
    const body = workflows[0].body;
    const commit = body.match(/      - name: Commit pricing \+ performance data\n[\s\S]*?        run: \|\n([\s\S]*?)(?=\n      - )/)[1]
      .replace(/^          /gm, '');
    const files = commit.match(/^git add (.+)$/m)[1].split(' ');
    for (const dir of ['public', 'data']) mkdirSync(join(first, dir));
    for (const file of files) writeFileSync(join(first, file), '{}\n');
    git(first, 'add', '.');
    git(first, 'commit', '-m', 'Initial catalog');
    git(first, 'push', '-u', 'origin', 'main');
    const originalSha = git(first, 'rev-parse', 'HEAD');
    const output = join(root, 'github-output');
    const runCommit = cwd => spawnSync('bash', ['-e', '-c', commit], {
      cwd, env: { ...process.env, GITHUB_OUTPUT: output }, encoding: 'utf8',
    });
    writeFileSync(join(first, 'public/pricing.json'), '{"attempt":1}\n');
    const firstResult = runCommit(first);
    assert.equal(firstResult.status, 0, firstResult.stderr);
    const firstSha = git(first, 'rev-parse', 'HEAD');

    // Model checkout's ref selection: an explicit branch follows its tip;
    // the default on a rerun fetches the original event SHA instead.
    const ref = body.match(/^          ref: (.+)$/m)?.[1] ?? originalSha;
    const retry = join(root, 'retry');
    git(root, 'init', '--initial-branch=main', retry);
    git(retry, 'remote', 'add', 'origin', remote);
    git(retry, 'fetch', '--depth=1', 'origin', `+${ref}:refs/remotes/origin/main`);
    git(retry, 'checkout', '-B', 'main', 'origin/main');
    writeFileSync(join(retry, 'public/pricing.json'), '{"attempt":2}\n');
    const retryResult = runCommit(retry);
    assert.equal(retryResult.status, 0, retryResult.stderr);
    assert.equal(git(retry, 'rev-parse', 'HEAD^'), firstSha);
    const retrySha = git(retry, 'rev-parse', 'HEAD');
    assert.equal(git(remote, 'rev-parse', 'main'), retrySha);

    writeFileSync(output, '');
    assert.equal(runCommit(retry).status, 0);
    assert.equal(git(retry, 'rev-parse', 'HEAD'), retrySha, 'no empty recovery commit');
    assert.equal(readFileSync(output, 'utf8'), '', 'no changed output for a no-op');

    git(first, 'pull', '--ff-only');
    writeFileSync(join(first, 'code.txt'), 'Concurrent code update\n');
    git(first, 'add', 'code.txt');
    git(first, 'commit', '-m', 'Concurrent code update');
    git(first, 'push');
    const concurrentSha = git(first, 'rev-parse', 'HEAD');
    writeFileSync(join(retry, 'public/pricing.json'), '{"attempt":3}\n');
    const rejected = runCommit(retry);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /rejected/);
    assert.equal(git(remote, 'rev-parse', 'main'), concurrentSha, 'never overwrite concurrent work');
    assert.equal(readFileSync(output, 'utf8'), '', 'failed push must not enable deploy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
