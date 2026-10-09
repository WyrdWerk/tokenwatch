// models.dev UI additions: lifecycle + context-tier badges, reasoning chips, setup hints in Copy setup.
// Functions are sliced out of the browser sources and run with injected dependencies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { shellQuote } from '../shared/choose-page.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `source must define ${name}()`);
  const end = src.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `${name}() must close at column 0`);
  return src.slice(start, end + 2);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtPrice = (p) => (p === null || p === undefined ? '<span class="missing">—</span>' : p === 0 ? '<span class="cost-zero">Free</span>' : `$${Math.round(p * 1000) / 1000}`);
const fmtPlain = (html) => String(html).replace(/<[^>]*>/g, '');

async function loadAppHelpers() {
  const src = await readFile(join(ROOT, 'public', 'app.js'), 'utf8');
  const names = ['fmtTierTokens', 'lifecycleBadgeHtml', 'tierBadgeHtml', 'reasoningChipLabels'];
  const code = names.map((n) => extractFn(src, n)).join('\n') + `\nreturn {${names.join(',')}};`;
  return new Function('esc', 'fmtPrice', 'fmtPlain', code)(esc, fmtPrice, fmtPlain);
}

async function loadSetupText(catalogs) {
  const src = await readFile(join(ROOT, 'public', 'choose-app.js'), 'utf8');
  const code = ['setupHintLines', 'setupText'].map((n) => extractFn(src, n)).join('\n') + '\nreturn setupText;';
  const providerName = (key) => key;
  return new Function('catalogs', 'shellQuote', 'providerName', code)(catalogs, shellQuote, providerName);
}

// ── Badges ───────────────────────────────────────────────────────────────────

test('lifecycle badge renders only for deprecated/beta/alpha and carries a tooltip', async () => {
  const { lifecycleBadgeHtml } = await loadAppHelpers();
  assert.equal(lifecycleBadgeHtml({}), '');
  assert.equal(lifecycleBadgeHtml({ lifecycle_status: null }), '');
  assert.equal(lifecycleBadgeHtml({ lifecycle_status: 'stable' }), '', 'unknown statuses never render');
  assert.equal(lifecycleBadgeHtml({ lifecycle_status: '"><img src=x onerror=alert(1)>' }), '', 'status is allow-listed, not echoed');

  const dep = lifecycleBadgeHtml({ lifecycle_status: 'deprecated' });
  assert.match(dep, /class="lifecycle-badge lifecycle-deprecated"/);
  assert.match(dep, /data-tip="models\.dev lists this provider offering as deprecated; it may be retired\./);
  assert.match(dep, />deprecated<\/span>$/);
  assert.match(lifecycleBadgeHtml({ lifecycle_status: 'beta' }), /offering as beta \(pre-release\)\./);
  assert.match(lifecycleBadgeHtml({ lifecycle_status: 'alpha' }), /lifecycle-alpha/);
});

test('context-tier badge uses the first threshold for the label and the last tier for the tooltip', async () => {
  const { tierBadgeHtml } = await loadAppHelpers();
  assert.equal(tierBadgeHtml({}), '');
  assert.equal(tierBadgeHtml({ context_price_tiers: null }), '');
  assert.equal(tierBadgeHtml({ context_price_tiers: [] }), '');

  const html = tierBadgeHtml({ context_price_tiers: [
    { above_tokens: 32000, input: 5, output: 15, cache_read: 1, cache_write: null },
    { above_tokens: 128000, input: 6.25, output: 18.5, cache_read: 1.25, cache_write: null },
  ] });
  assert.match(html, /class="tier-badge"/);
  assert.match(html, /↑ &gt;32K<\/span>$/, 'label comes from the first tier');
  assert.match(html, /requests above 32K tokens: up to \$6\.25 input \/ \$18\.5 output per M \(models\.dev\)\./, 'prices come from the last tier');
  assert.match(html, /Costs here assume shorter requests\./);
});

test('context-tier badge degrades on null prices and formats thresholds compactly', async () => {
  const { tierBadgeHtml, fmtTierTokens } = await loadAppHelpers();
  const html = tierBadgeHtml({ context_price_tiers: [{ above_tokens: 200000, input: null, output: 22.5 }] });
  assert.match(html, /up to — input \/ \$22\.5 output/, 'null price renders a dash, never "null" or HTML');
  assert.doesNotMatch(html, /<span class="missing">/);
  assert.deepEqual([32000, 128000, 131072, 200000, 1000000, 1048576, 1500000].map(fmtTierTokens),
    ['32K', '128K', '128K', '200K', '1M', '1M', '1.5M']);
  assert.equal(fmtTierTokens(undefined), '?');
});

test('non-numeric thresholds cannot inject markup into the badge', async () => {
  const { tierBadgeHtml } = await loadAppHelpers();
  // Thresholds are formatted numerically ('?' when not a number) and then escaped.
  const html = tierBadgeHtml({ context_price_tiers: [{ above_tokens: '"><script>', input: 1, output: 2 }] });
  assert.doesNotMatch(html, /<script>/);
  assert.equal((html.match(/data-tip="/g) || []).length, 1);
  assert.match(html, /above \? tokens/);
});

// ── Reasoning chips ──────────────────────────────────────────────────────────

test('reasoning chips cover effort, toggle, budget and interleaved; empty/null render nothing', async () => {
  const { reasoningChipLabels } = await loadAppHelpers();
  assert.deepEqual(reasoningChipLabels(null), []);
  assert.deepEqual(reasoningChipLabels({}), []);
  assert.deepEqual(reasoningChipLabels({ reasoning_options: [], interleaved_reasoning: null }), []);
  assert.deepEqual(reasoningChipLabels({ reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }] }),
    ['Reasoning effort: low · medium · high']);
  assert.deepEqual(reasoningChipLabels({ reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens' }, { type: 'mystery' }], interleaved_reasoning: true }),
    ['Reasoning on/off toggle', 'Reasoning token budget', 'Interleaved thinking'], 'unknown option types are skipped');
  assert.deepEqual(reasoningChipLabels({ reasoning_options: [{ type: 'effort' }] }), ['Reasoning effort']);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('table rows, canonical summary rows and the detail modal all use the shared badge helpers', async () => {
  const src = await readFile(join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(extractFn(src, 'renderModelRow'), /\$\{lifecycleBadgeHtml\(r\.model\)\}\$\{tierBadgeHtml\(r\.model\)\}/);
  const summary = extractFn(src, 'renderModelSummary');
  assert.match(summary, /lifecycleBadgeHtml\(r\.model\)/);
  assert.match(summary, /tierBadgeHtml\(r\.model\)/);
  const modal = extractFn(src, 'showDetailModal');
  assert.match(modal, /context_price_tiers/);
  assert.match(modal, /setup_env/);
  assert.match(modal, /ai_sdk_package/);
  assert.match(modal, /reasoningChipLabels\(meta\)/);
});

// ── Copy setup hints ─────────────────────────────────────────────────────────

const provider = (key = 'groq') => ({ provider: key, offering: { id: 'acme/model-1', modelsdev: { base_url: 'https://api.example.com/v1', model_id: 'model-1' } } });

test('Copy setup adds the API key env line and SDK package comment after MODEL_ID', async () => {
  const setupText = await loadSetupText({ pricing: { providers_meta: { groq: { setup_env: ['GROQ_API_KEY'], ai_sdk_package: '@ai-sdk/groq' } } } });
  const lines = setupText(provider()).split('\n');
  const idx = lines.indexOf("export MODEL_ID='model-1'");
  assert.notEqual(idx, -1);
  assert.equal(lines[idx + 1], '# API key variable listed by models.dev: GROQ_API_KEY');
  assert.equal(lines[idx + 2], 'export API_KEY="${GROQ_API_KEY}"');
  assert.equal(lines[idx + 3], '# Vercel AI SDK provider package: @ai-sdk/groq');
  assert.equal(lines[idx + 4], '', 'existing blank line + curl block follow unchanged');
});

test('Copy setup wires API_KEY to the credential, never to an account id listed first', async () => {
  const setupText = await loadSetupText({ pricing: { providers_meta: {
    cloudflare: { setup_env: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_KEY'] },
    amazon: { setup_env: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'] },
    google: { setup_env: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'] },
  } } });
  const cf = setupText(provider('cloudflare'));
  assert.match(cf, /export API_KEY="\$\{CLOUDFLARE_API_KEY\}"/);
  assert.doesNotMatch(cf, /API_KEY="\$\{CLOUDFLARE_ACCOUNT_ID\}"/);
  assert.match(cf, /# Also required by this provider \(models\.dev\): CLOUDFLARE_ACCOUNT_ID/);
  const aws = setupText(provider('amazon'));
  assert.doesNotMatch(aws, /export API_KEY=/, 'no single credential → no API_KEY export');
  assert.match(aws, /# Also required by this provider \(models\.dev\): AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION/);
  const google = setupText(provider('google'));
  assert.doesNotMatch(google, /export API_KEY=/, 'two credential-looking names → ambiguous, no export');
  assert.match(google, /GOOGLE_API_KEY, GEMINI_API_KEY/);
});

test('Copy setup output is a safe shell script: the env line expands the provider variable literally', async () => {
  const setupText = await loadSetupText({ pricing: { providers_meta: { groq: { setup_env: ['GROQ_API_KEY'] } } } });
  const exportLines = setupText(provider()).split('\n').filter((l) => /^(export |# )/.test(l) && !/^# (curl|Python)/.test(l));
  const result = spawnSync('sh', ['-c', `GROQ_API_KEY=secret123\n${exportLines.join('\n')}\nprintf '%s' "$API_KEY"`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'secret123');
});

test('Copy setup skips malformed env names and package names instead of echoing them', async () => {
  for (const bad of ['bad name; rm -rf /', 'lowercase_key', '1STARTS_WITH_DIGIT', 'KEY$(whoami)', 'KEY\nexport X=1', '', null, 42]) {
    const setupText = await loadSetupText({ pricing: { providers_meta: { groq: { setup_env: [bad], ai_sdk_package: 'bad pkg; rm -rf /' } } } });
    const text = setupText(provider());
    assert.doesNotMatch(text, /API_KEY=/, `rejected env name: ${JSON.stringify(bad)}`);
    assert.doesNotMatch(text, /listed by models\.dev/);
    assert.doesNotMatch(text, /Vercel AI SDK/);
    assert.doesNotMatch(text, /rm -rf/);
  }
});

test('Copy setup is byte-identical to the legacy output when the catalog carries no hints', async () => {
  const without = await loadSetupText({ pricing: { providers_meta: { groq: {} } } });
  const missingMeta = await loadSetupText({ pricing: {} });
  const a = without(provider());
  assert.equal(a, missingMeta(provider()));
  assert.doesNotMatch(a, /API_KEY="|listed by models\.dev|Vercel AI SDK/);
  assert.match(a, /export MODEL_ID='model-1'\n\n# curl/);
});
