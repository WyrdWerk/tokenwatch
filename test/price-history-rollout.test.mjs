import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as writer from '../scripts/snapshot-prices.mjs';

test('remote D1 execution selects the explicit history config and writer token', async () => {
  const calls = [];
  const output = await writer.runD1(['--command', 'SELECT 1'], {
    remote: true,
    env: { CLOUDFLARE_D1_TOKEN: 'test-writer-token', CLOUDFLARE_API_TOKEN: 'test-deploy-token' },
    execute: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: '[{"results":[{"value":1}]}]' };
    },
  });
  assert.match(output, /"value":1/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'npx');
  assert.ok(calls[0].args.includes('--remote'));
  assert.ok(!calls[0].args.includes('--local'));
  assert.equal(calls[0].args[calls[0].args.indexOf('--config') + 1], 'wrangler.history.toml');
  assert.equal(calls[0].options.env.CLOUDFLARE_API_TOKEN, 'test-writer-token');
});

test('remote retries replay the same SQL file and stop after three failed attempts', async () => {
  const calls = [];
  const waits = [];
  const options = {
    remote: true,
    env: { CLOUDFLARE_D1_TOKEN: 'test-writer-token' },
    wait: async (ms) => waits.push(ms),
    execute: (command, args) => {
      calls.push(args);
      return { status: 1, stderr: 'upstream unavailable' };
    },
  };
  await assert.rejects(writer.runD1(['--file', 'snapshot.sql'], options), /upstream unavailable/);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], calls[0]);
  assert.deepEqual(calls[2], calls[0]);
  assert.deepEqual(waits, [1000, 2000]);

  let attempts = 0;
  const output = await writer.runD1(['--file', 'snapshot.sql'], {
    ...options,
    execute: () => ++attempts === 1
      ? { status: 1, stderr: 'temporary failure' }
      : { status: 0, stdout: '[]' },
  });
  assert.equal(output, '[]');
  assert.equal(attempts, 2);
});

test('local execution needs no credential; remote mode without its token never spawns', async () => {
  let attempts = 0;
  const execute = (command, args) => {
    attempts++;
    assert.ok(args.includes('--local'));
    return { status: 0, stdout: '[]' };
  };
  await writer.runD1(['--command', 'SELECT 1'], { env: {}, execute });
  await assert.rejects(writer.runD1(['--command', 'SELECT 1'], { remote: true, env: {}, execute }), /CLOUDFLARE_D1_TOKEN/);
  assert.equal(attempts, 1);
});

test('snapshot CLI requires exactly one explicit execution target', () => {
  assert.equal(writer.parseArgs(['--remote']).remote, true);
  assert.equal(writer.parseArgs(['--local']).local, true);
  assert.throws(() => writer.parseArgs([]), /exactly one/);
  assert.throws(() => writer.parseArgs(['--local', '--remote']), /exactly one/);
});

test('production history config matches the verified database without replacing Pages bindings', async () => {
  const config = await readFile(new URL('../wrangler.history.toml', import.meta.url), 'utf8');
  assert.match(config, /account_id = "04679cba466d1d41d88325944b461c18"/);
  assert.match(config, /database_id = "980879e7-cc90-489b-9203-d81cf3ef265e"/);
  assert.match(config, /database_name = "tokenwatch-price-history-prod"/);
  assert.doesNotMatch(config, /pages_build_output_dir/);
});

const context = {
  repo: { owner: 'WyrdWerk', repo: 'tokenwatch' },
  serverUrl: 'https://github.com',
  runId: 12345,
};

function githubDouble(issues) {
  const calls = [];
  const listForRepo = () => {};
  return {
    calls,
    github: {
      paginate: async (method, params) => {
        assert.equal(method, listForRepo);
        assert.equal(params.state, 'open');
        return issues;
      },
      rest: { issues: {
        listForRepo,
        create: async (params) => { calls.push({ action: 'create', ...params }); return { data: { number: 77 } }; },
        createComment: async (params) => { calls.push({ action: 'comment', ...params }); return { data: {} }; },
      } },
    },
  };
}

test('history failure opens one issue with the run URL and redacted error', async () => {
  const { reportHistoryFailure } = await import('../scripts/report-history-failure.mjs');
  const { github, calls } = githubDouble([]);
  await reportHistoryFailure({ github, context, error: 'D1 failed: test-secret', secrets: ['test-secret'] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'create');
  assert.match(calls[0].body, /https:\/\/github.com\/WyrdWerk\/tokenwatch\/actions\/runs\/12345/);
  assert.match(calls[0].body, /D1 failed: \[REDACTED\]/);
  assert.doesNotMatch(calls[0].body, /test-secret/);
});

test('history failure comments on the existing open issue rather than creating another', async () => {
  const { reportHistoryFailure, ISSUE_MARKER } = await import('../scripts/report-history-failure.mjs');
  const { github, calls } = githubDouble([
    { number: 2, title: 'Unrelated', body: 'A different failure' },
    { number: 3, body: ISSUE_MARKER, pull_request: {} },
    { number: 41, body: ISSUE_MARKER },
  ]);
  await reportHistoryFailure({ github, context, error: 'migration missing' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'comment');
  assert.equal(calls[0].issue_number, 41);
  assert.match(calls[0].body, /migration missing/);
});

test('failure reports keep oversized output within the GitHub issue body limit', async () => {
  const { reportHistoryFailure } = await import('../scripts/report-history-failure.mjs');
  const { github, calls } = githubDouble([]);
  await reportHistoryFailure({ github, context, error: 'x'.repeat(100000) + 'FINAL ERROR' });
  assert.ok(calls[0].body.length < 65536);
  assert.match(calls[0].body, /FINAL ERROR/);
});

test('CI history and reporting failures cannot gate the ordinary pricing deploy', async () => {
  const workflow = await readFile(new URL('../.github/workflows/refresh-pricing.yml', import.meta.url), 'utf8');
  const history = workflow.match(/      - name: Snapshot daily price history\n([\s\S]*?)(?=\n      - )/)?.[1];
  assert.ok(history, 'a daily history step must exist');
  assert.match(history, /id: history/);
  assert.match(history, /continue-on-error: true/);
  assert.match(history, /shell: bash/, 'explicit bash enables pipefail so tee cannot hide a writer failure');
  assert.match(history, /snapshot-prices\.mjs --remote/);
  assert.doesNotMatch(history, /if:|changed|inputs\.force/);
  assert.ok(workflow.indexOf('Fetch & normalize text pricing') < workflow.indexOf('Snapshot daily price history'));
  assert.ok(workflow.indexOf('Snapshot daily price history') < workflow.indexOf('Commit pricing + performance data'));
  const report = workflow.match(/      - name: Report history failure\n([\s\S]*?)(?=\n      - )/)?.[1];
  assert.ok(report);
  assert.match(report, /steps\.history\.outcome == 'failure'/);
  assert.match(report, /continue-on-error: true/);
  assert.match(workflow, /issues: write/);
});

test('the production SEO generator no longer suppresses model-page history', async () => {
  const generator = await readFile(new URL('../scripts/generate-seo.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(generator, /historyEnabled: false/);
});
