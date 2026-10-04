import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_CHOOSE_STATE,
  buildCalculatorHref,
  isCloseCall,
  isStale,
  USE_CASE_CHOICES,
  parseChooseHash,
  parseChooseLocation,
  shellQuote,
  serializeChooseState,
  stripUseCaseQuery,
} from '../shared/choose-page.mjs';

test('choose URL hash round-trips use case, provider constraints, model pick, and provider selection', () => {
  const state = {
    ...DEFAULT_CHOOSE_STATE,
    useCase: 'creative-writing',
    priority: 'fastest',
    requireZdr: true,
    excludeHQ: ['CN', 'SG'],
    includeProprietary: true,
    pick: 'value',
    provider: 'deepinfra',
  };

  const hash = serializeChooseState(state);
  assert.match(hash, /^#/);
  assert.deepEqual(parseChooseHash(hash), state);
});

test('choose URL hash rejects unknown options and restores stable defaults', () => {
  assert.deepEqual(parseChooseHash('#useCase=made-up&priority=turbo&zdr=maybe&excludeHQ=CN,?&pick=other'), {
    ...DEFAULT_CHOOSE_STATE,
    excludeHQ: ['CN'],
  });
  assert.deepEqual(parseChooseHash(''), DEFAULT_CHOOSE_STATE);
});

test('choose page accepts ?useCase= from the no-JS finder form; the hash wins when it names a use case', () => {
  assert.equal(parseChooseLocation('?useCase=frontend-ui', '').useCase, 'frontend-ui');
  assert.equal(parseChooseLocation('?useCase=frontend-ui', '#useCase=chat-assistant').useCase, 'chat-assistant');
  assert.deepEqual(parseChooseLocation('?useCase=frontend-ui', '#zdr=1'), { ...DEFAULT_CHOOSE_STATE, useCase: 'frontend-ui', requireZdr: true });
  assert.deepEqual(parseChooseLocation('?useCase=nope', ''), DEFAULT_CHOOSE_STATE);
  assert.equal(stripUseCaseQuery('?useCase=frontend-ui'), '');
  assert.equal(stripUseCaseQuery('?useCase=frontend-ui&ref=home'), '?ref=home');
});

test('choose cards use the shared USE_CASE_CHOICES labels and blurbs', async () => {
  const html = await readFile(new URL('../public/choose/index.html', import.meta.url), 'utf8');
  const cards = [...html.matchAll(/value="([^"]+)"[^>]*\/>[\s\S]*?<strong>([^<]+)<\/strong><small>([^<]+)<\/small>/g)]
    .filter((m) => USE_CASE_CHOICES.some((choice) => choice.id === m[1]))
    .map((m) => ({ id: m[1], label: m[2], blurb: m[3] }));
  assert.deepEqual(cards, USE_CASE_CHOICES.map((choice) => ({ ...choice })));
  const app = await readFile(new URL('../public/choose-app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /USE_CASE_COPY/, 'choose-app reuses the shared labels');
  assert.match(app, /parseChooseLocation\(location\.search, location\.hash\)/);
});

test('calculator links carry the selected model and exact workload mix in the existing hash format', () => {
  const href = buildCalculatorHref('glm-5.3-flash', { inputPct: 35, cacheReadPct: 10, outputPct: 55 });
  const params = new URLSearchParams(href.slice(2));
  assert.match(href, /^\/#/);
  assert.equal(params.get('model'), 'glm-5.3-flash');
  assert.equal(params.get('mix'), '35,10,55');
});

test('shellQuote preserves hostile catalog values as literal shell assignment values', () => {
  const value = "model$(printf injected >&2)`printf backtick`'quoted";
  const script = `MODEL_ID=${shellQuote(value)}\nprintf '%s' "$MODEL_ID"`;
  const result = spawnSync('sh', ['-c', script], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, value);
  assert.equal(result.stderr, '');
});

test('setup snippets quote catalog URLs and model IDs and sanitize the comment line', async () => {
  const source = await readFile(new URL('../public/choose-app.js', import.meta.url), 'utf8');
  assert.match(source, /export BASE_URL=\$\{shellQuote\(baseURLForCopy\)\}/);
  assert.match(source, /export MODEL_ID=\$\{shellQuote\(modelId\)\}/);
  assert.match(source, /const comment = \[providerName\(provider\.provider, offering\), offering\.id\]/);
  assert.match(source, /replace\(\/\[\\u0000-\\u001f\\u007f\]\/g, ' '\)/);
});

test('close calls are detected from the engine confidence result, not recomputed scores', () => {
  assert.equal(isCloseCall({ level: 'close_call' }), true);
  assert.equal(isCloseCall({ level: 'moderately_stable' }), false);
  assert.equal(isCloseCall(null), false);
});

test('telemetry becomes stale only after six hours from its generated_at timestamp', () => {
  const generatedAt = '2026-10-04T00:00:00.000Z';
  const sixHours = Date.parse(generatedAt) + 6 * 60 * 60 * 1000;
  assert.equal(isStale(generatedAt, sixHours), false);
  assert.equal(isStale(generatedAt, sixHours + 1), true);
  assert.equal(isStale('not-a-date', sixHours + 1), false);
});

test('coverage badge only flags coverage below the engine eligibility threshold; exact coverage is in the explanation', async () => {
  const { MIN_BENCHMARK_COVERAGE } = await import('../shared/recommend.mjs');
  assert.equal(MIN_BENCHMARK_COVERAGE, 0.5);
  const app = await readFile(new URL('../public/choose-app.js', import.meta.url), 'utf8');
  assert.match(app, /candidate\.qualityCoverage < MIN_BENCHMARK_COVERAGE\) \{\n\s*return '<span class="choose-badge choose-badge-partial">Low benchmark coverage<\/span>'/);
  assert.doesNotMatch(app, /qualityCoverage < 1\b/);
  assert.match(app, /class="choose-coverage-line"><strong>Benchmark coverage: \$\{formatNumber\(explanation\.benchmark\.coverage \* 100, 0\)\}%/);
});

test('model display names strip the org prefix or prettify raw ids; the card keeps the canonical id underneath', async () => {
  const { modelDisplayName, prettifyModelId } = await import('../shared/choose-page.mjs');
  assert.equal(modelDisplayName({ id: 'glm-5.3', name: 'zai-org/GLM-5.3', providers: [{ offering: { name: 'Z.ai: GLM 5.3' } }] }), 'GLM 5.3');
  assert.equal(modelDisplayName({ id: 'glm-5.3', name: 'zai-org/GLM-5.3' }), 'GLM 5.3');
  assert.equal(modelDisplayName({ id: 'deepseek-v4-pro', name: 'deepseek-ai/DeepSeek-V4-Pro' }), 'DeepSeek V4 Pro');
  assert.equal(modelDisplayName({ id: 'glm-5.3:batch', name: 'Z.ai: GLM 5.3 (batch)' }), 'GLM 5.3 (batch)');
  assert.equal(modelDisplayName({ id: 'gpt-oss-120b' }), 'GPT OSS 120B');
  assert.equal(prettifyModelId('qwen3-30b-a3b'), 'Qwen3 30B A3B');
  const app = await readFile(new URL('../public/choose-app.js', import.meta.url), 'utf8');
  assert.match(app, /<h3>\$\{escapeHtml\(modelDisplayName\(candidate\)\)\}<\/h3>\n\s*<p class="choose-model-id">\$\{escapeHtml\(candidate\.id\)\}<\/p>/);
  assert.doesNotMatch(app, /candidate\.name \|\| candidate\.id/);
});

test('provider cards resolve display names from offering, catalog, or metadata before falling back to the slug', async () => {
  const { providerDisplayName } = await import('../shared/choose-page.mjs');
  const providers = [{ key: 'relace', name: 'Relace Inference' }];
  const providersMeta = { inferencenet: { display_name: 'Inference Net' } };

  assert.equal(providerDisplayName('inferencenet', { provider_display: 'Inference Network' }, providers, providersMeta), 'Inference Network');
  assert.equal(providerDisplayName('relace', null, providers, providersMeta), 'Relace Inference');
  assert.equal(providerDisplayName('inferencenet', null, [], providersMeta), 'Inference Net');
  assert.equal(providerDisplayName('unknown-provider', null, [], {}), 'unknown-provider');
});

test('Arena favorite callout has a provider action and linked date/license attribution without stale caveats', async () => {
  const html = await readFile(new URL('../public/choose/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/choose-app.js', import.meta.url), 'utf8');
  const methodology = await readFile(new URL('../public/docs/methodology/index.html', import.meta.url), 'utf8');

  assert.match(html, /id="preferenceSummary"/);
  assert.match(html, /id="preferenceAttribution"/);
  assert.match(app, /const favorite = preference\?\.favorite/);
  assert.match(app, /data-show-preference-providers/);
  assert.match(app, /Preference ratings: <a href=/);
  assert.match(app, /CC BY 4\.0/);
  assert.doesNotMatch(app, /does not yet reflect reader preference|does not yet reflect human preference/i);
  assert.match(methodology, /Arena preference ratings/);
  assert.match(methodology, /https:\/\/creativecommons\.org\/licenses\/by\/4\.0\//);
  assert.match(methodology, /2026-10-02/);
});

test('provider list features the top three, or the close-call priority winners, and keeps a selection expanded', async () => {
  const { pickFeaturedProviders, FEATURED_PROVIDER_COUNT } = await import('../shared/choose-page.mjs');
  const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((provider) => ({ provider, offering: { id: `m@${provider}` } }));
  assert.equal(FEATURED_PROVIDER_COUNT, 3);
  assert.deepEqual(pickFeaturedProviders(rows).featured.map((row) => row.provider), ['a', 'b', 'c']);
  const alternatives = { cheapest: { provider: 'e', offering: { id: 'm@e' } }, fastest: { provider: 'e', offering: { id: 'm@e' } }, 'most-reliable': { provider: 'b', offering: { id: 'm@b' } } };
  const close = pickFeaturedProviders(rows, alternatives);
  assert.deepEqual(close.featured.map((row) => row.provider), ['e', 'b', 'a']);
  assert.deepEqual(close.roles.get(rows[4]), ['Cheapest', 'Fastest']);
  assert.deepEqual(pickFeaturedProviders(rows, null, 'f').featured.map((row) => row.provider), ['a', 'b', 'c', 'f']);
  const app = await readFile(new URL('../public/choose-app.js', import.meta.url), 'utf8');
  assert.match(app, /Show all \$\{providers\.length\} providers/);
  assert.match(app, /cappedList\(unverified, 'unverified providers', [\s\S]*?, FEATURED_PROVIDER_COUNT\)/);
});
