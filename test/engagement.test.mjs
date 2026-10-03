// Hero, crossover chart, filter insights, re-rank FLIP, agent prompt, rules strip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pickHeroModel, heroLanes, renderHero } from '../scripts/hero.mjs';
import { RULES, renderRulesStrip, replaceSection } from '../scripts/seo-pages.mjs';
import { blendedRate, AGENTIC_MIX } from '../shared/cost.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const APP_JS = join(ROOT, 'public', 'app.js');

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `app.js must define ${name}()`);
  const end = src.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `${name}() must close at column 0`);
  return src.slice(start, end + 2);
}

async function loadAppHelpers(names) {
  const src = await readFile(APP_JS, 'utf8');
  const code = names.map((n) => extractFn(src, n)).join('\n') + `\nreturn {${names.join(',')}};`;
  return new Function(code)();
}

const offering = (id, provider, input, output, cacheRead = null, extra = {}) =>
  ({ id, name: id, provider, pricing: { input, output, cache_read: cacheRead, cache_write: null }, ...extra });

// ── Hero ─────────────────────────────────────────────────────────────────────

test('pickHeroModel picks the canonical with the most distinct priced providers, one row per provider', () => {
  const models = [
    offering('acme/alpha', 'p1', 1, 2, 0.1),
    offering('acme/alpha', 'p2', 2, 4, 0.2),
    offering('acme/alpha', 'p3', 3, 6, 0.3),
    offering('acme/alpha', 'p3', 0.5, 1, 0.05, { id: 'acme/alpha' }), // cheaper duplicate for p3
    offering('acme/beta', 'p1', 1, 1, 0.1),
    offering('acme/beta', 'p2', 1, 1, 0.1),
    offering('acme/alpha:batch', 'p9', 0.01, 0.01, 0.001), // batch never counts
  ];
  const pick = pickHeroModel(models);
  assert.equal(pick.canonical, 'alpha');
  assert.equal(pick.providerCount, 3);
  assert.deepEqual(pick.ranked.map((r) => r.model.provider), ['p3', 'p1', 'p2']);
  const expected = blendedRate(models[1].pricing, AGENTIC_MIX) / blendedRate(models[3].pricing, AGENTIC_MIX);
  assert.ok(Math.abs(pick.spread - expected) < 1e-9, 'spread is most expensive / cheapest provider');
});

test('pickHeroModel returns null below three providers and ties break by id', () => {
  assert.equal(pickHeroModel([offering('a/x', 'p1', 1, 1), offering('a/x', 'p2', 1, 1)]), null);
  const tie = [
    ...['p1', 'p2', 'p3'].map((p) => offering('a/zeta', p, 1, 1)),
    ...['p1', 'p2', 'p3'].map((p) => offering('a/eta', p, 1, 1)),
  ];
  assert.equal(pickHeroModel(tie).canonical, 'eta');
});

test('heroLanes keeps cheapest, quartiles and most expensive', () => {
  const ranked = Array.from({ length: 9 }, (_, i) => ({ eff: i + 1 }));
  assert.deepEqual(heroLanes(ranked).map((r) => r.eff), [1, 3, 5, 7, 9]);
  assert.equal(heroLanes(ranked.slice(0, 3)).length, 3);
  assert.deepEqual(heroLanes([]), []);
});

test('renderHero renders real numbers, escapes names and falls back without a scene', () => {
  const models = ['p1', 'p2', 'p3'].map((p, i) => offering('evil/<b>', p, 1 + i, 1 + i, 0.1 * (i + 1), { name: 'Evil: <script>' }));
  const html = renderHero({ models, providers: [] });
  assert.match(html, /id="twHero"/);
  assert.match(html, /Same model\. 3 providers\. Up to 3\.0× apart\./);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /role="img"/);
  assert.match(html, /data-hero-action="estimate"/);
  assert.doesNotMatch(html, /\{\{/, 'renderCounts rejects unresolved placeholders');
  const fallback = renderHero({ models: [offering('a/x', 'p1', 1, 1)], providers: [] });
  assert.doesNotMatch(fallback, /<svg/);
  assert.match(fallback, /data-hero-action="estimate"/);
  assert.doesNotMatch(fallback, /data-hero-model/);
});

test('hero and rules markers are committed and replaced idempotently', async () => {
  const html = await readFile(join(ROOT, 'public', 'index.html'), 'utf8');
  for (const name of ['tw-hero', 'tw-rules']) {
    assert.equal(html.split(`<!-- TW:SEO:${name}:START -->`).length, 2, `${name} start marker appears once`);
    assert.equal(html.split(`<!-- TW:SEO:${name}:END -->`).length, 2, `${name} end marker appears once`);
  }
  const once = replaceSection(html, 'tw-rules', renderRulesStrip());
  assert.equal(replaceSection(once, 'tw-rules', renderRulesStrip()), once);
});

test('rules strip lists every rule', () => {
  const html = renderRulesStrip();
  assert.ok(RULES.length >= 5);
  for (const [title] of RULES) assert.ok(html.includes(title.replace(/’/g, '’')), title);
  assert.match(html, /href="\/docs\/methodology\/#rules"/);
});

// ── App helpers ──────────────────────────────────────────────────────────────

test('explainExclusions counts blockers and returns single-filter near misses only', async () => {
  const { explainExclusions } = await loadAppHelpers(['explainExclusions']);
  const checks = [
    { key: 'zdr', label: 'ZDR only', test: (m) => m.zdr, userSet: true },
    { key: 'promo', label: 'Promos only', test: (m) => m.promo, userSet: true },
    { key: 'batch', label: 'Batch hidden', test: (m) => !m.batch, userSet: false },
  ];
  const pool = [
    { id: 'ok', zdr: true, promo: true },
    { id: 'noZdr', zdr: false, promo: true },
    { id: 'neither', zdr: false, promo: false },
    { id: 'batchOnly', zdr: true, promo: true, batch: true },
  ];
  const out = explainExclusions(pool, checks);
  assert.equal(out.hidden, 3);
  assert.deepEqual(out.blockers.map((b) => [b.key, b.count]), [['zdr', 2], ['promo', 1], ['batch', 1]]);
  assert.deepEqual(out.nearMisses.map((n) => [n.model.id, n.check.key]), [['noZdr', 'zdr']],
    'two-filter misses and default batch hiding are never close matches');
  assert.deepEqual(explainExclusions([], checks), { hidden: 0, blockers: [], nearMisses: [] });
});

test('crossoverSeries finds the provider that wins at each cached share', async () => {
  const { crossoverSeries } = await loadAppHelpers(['freshInputRate', 'blendedCostFor', 'crossoverSeries']);
  const models = [
    // Cheap uncached input, no cache discount.
    offering('m', 'flat', 0.2, 1, null),
    // Pricier input but a deep cache discount.
    offering('m', 'cachey', 1, 1, 0.01),
  ];
  const tokens = { inputPct: 80, cacheReadPct: 0, outputPct: 20 };
  const series = crossoverSeries(models, tokens, { step: 10 });
  assert.equal(series.xs.length, 11);
  assert.equal(series.currentX, 0);
  assert.deepEqual(series.lines.map((l) => l.label).sort(), ['cachey', 'flat']);
  assert.equal(series.segments[0].label, 'flat');
  assert.equal(series.segments.at(-1).label, 'cachey');
  assert.equal(series.segments[0].from, 0);
  assert.equal(series.segments.at(-1).to, 100);
  // Uncached remainder keeps the 80:20 input:output ratio.
  const flat = series.lines.find((l) => l.label === 'flat');
  assert.ok(Math.abs(flat.points[0] - (0.2 * 0.8 + 1 * 0.2)) < 1e-9);
  assert.equal(crossoverSeries([], tokens), null);
});

test('crossoverSeries caps lines but always keeps every crossover winner', async () => {
  const { crossoverSeries } = await loadAppHelpers(['freshInputRate', 'blendedCostFor', 'crossoverSeries']);
  const models = Array.from({ length: 10 }, (_, i) => offering('m', `p${i}`, 1 + i, 1 + i, 0.5 + i));
  const series = crossoverSeries(models, { inputPct: 50, cacheReadPct: 0, outputPct: 50 }, { maxLines: 3 });
  assert.equal(series.lines.length, 3);
  assert.equal(series.lines[0].label, 'p0');
});

test('rankChanges reports moved and entered rows but nothing on first render', async () => {
  const { rankChanges } = await loadAppHelpers(['rankChanges']);
  const prev = new Map([['a', { rank: '1' }], ['b', { rank: '2' }], ['c', { rank: '3' }]]);
  const next = new Map([['b', { rank: '1' }], ['a', { rank: '2' }], ['c', { rank: '3' }], ['d', { rank: '4' }]]);
  assert.deepEqual(rankChanges(prev, next), { moved: ['b', 'a'], entered: ['d'] });
  assert.deepEqual(rankChanges(new Map(), next), { moved: [], entered: [] });
});

test('buildAgentPrompt states workload, filters, top offerings and API pointers', async () => {
  const { buildAgentPrompt } = await loadAppHelpers(['buildAgentPrompt']);
  const text = buildAgentPrompt({
    origin: 'https://tokenwatch.example',
    shareUrl: 'https://tokenwatch.example/#model=glm-5.3',
    generatedAt: '2026-10-03T07:16:00Z',
    tokens: { total: 1e9, inputPct: 2.5, cacheReadPct: 97, outputPct: 0.5 },
    costMode: 'perRequest',
    computeBy: 'tokens',
    budget: 0,
    providerSearch: '',
    modelSearch: 'glm-5.3',
    filters: ['ZDR only'],
    top: [{ provider: 'DeepInfra', model: 'GLM 5.3', blended: '$0.093', value: '$92.76' }],
  });
  assert.match(text, /live view: https:\/\/tokenwatch\.example\/#model=glm-5\.3/);
  assert.match(text, /Volume: 1,000M tokens per session/);
  assert.match(text, /2\.5% fresh input · 97% cached input · 0\.5% output/);
  assert.match(text, /model "glm-5\.3" · provider any/);
  assert.match(text, /Filters: ZDR only/);
  assert.match(text, /1\. DeepInfra — GLM 5\.3 — blended \$0\.093\/M — est\. \$92\.76 per session/);
  assert.match(text, /\/api\/v1\/models\/<canonical-id>\/providers\?mix=2\.5,97,0\.5/);
  assert.match(text, /\/llms\.txt/);
  const withCanonical = buildAgentPrompt({ origin: 'o', shareUrl: 's', generatedAt: null, tokens: { total: 1e6, inputPct: 50, cacheReadPct: 0, outputPct: 50 },
    costMode: 'perRequest', computeBy: 'tokens', budget: 0, providerSearch: '', modelSearch: 'GLM 5.3', canonical: 'glm-5.3', filters: [], top: [] });
  assert.match(withCanonical, /\/api\/v1\/models\/glm-5\.3\/providers\?mix=50,0,50/);
  assert.match(text, /not invoices/);
  const budget = buildAgentPrompt({
    origin: 'o', shareUrl: 's', generatedAt: null, tokens: { total: 0, inputPct: 50, cacheReadPct: 0, outputPct: 50 },
    costMode: 'monthly', computeBy: 'budget', budget: 20, providerSearch: 'x', modelSearch: '', filters: [], top: [],
  });
  assert.match(budget, /Budget: \$20 per month/);
  assert.match(budget, /Filters: none/);
  assert.match(budget, /No offerings match this view yet/);
});

test('matchingOfferings applies the shared filter registry', async () => {
  const src = await readFile(APP_JS, 'utf8');
  const body = extractFn(src, 'matchingOfferings');
  assert.match(body, /secondaryFilterChecks\(\)/);
  assert.match(body, /searchMatchingOfferings\(\)/);
  const registry = extractFn(src, 'secondaryFilterChecks');
  for (const key of ['zdr', 'subscription', 'promo', 'intelligence', 'coding', 'agentic', 'benchmarked', 'batch', 'cache', 'maxBlended', 'minToks', 'hq']) {
    assert.match(registry, new RegExp(`add\\('${key}'`), `registry covers ${key}`);
  }
});
