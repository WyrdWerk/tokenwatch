import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blendedRate, AGENTIC_MIX } from '../shared/cost.mjs';
import { cheapestModels, renderSeoTable, renderCounts, buildSitemap, buildRobots } from '../scripts/generate-seo.mjs';

// ── Vendored copy of public/app.js blendedCostFor (classic script, not importable) ──
// The parity guard: this file must stay semantically identical to the app's
// blendedCostFor (app.js) — update BOTH when the mix formula changes.
function appBlendedCostFor(pricing, tokens) {
  const inRate  = pricing.input != null ? pricing.input * tokens.inputPct / 100 : null;
  const outRate = pricing.output != null ? pricing.output * tokens.outputPct / 100 : null;
  const crPrice = pricing.cache_read != null ? pricing.cache_read : pricing.input;
  const crRate  = crPrice != null ? crPrice * tokens.cacheReadPct / 100 : null;
  if (tokens.inputPct > 0 && inRate === null) return null;
  if (tokens.outputPct > 0 && outRate === null) return null;
  return (inRate || 0) + (outRate || 0) + (crRate || 0);
}

const FIXTURES = [
  { input: 1.25, output: 5, cache_read: 0.31 },          // normal cache discount
  { input: 0.019, output: 0.03, cache_read: null },      // null cache_read → input rate
  { input: 2, output: 4, cache_read: 0 },                // $0 cache → leg stays $0
  { input: null, output: 1 },                            // unpriced input
  { input: 10, output: null },                           // unpriced output
  { input: null, output: null },                         // fully unpriced
  { input: 0, output: 0, cache_read: 0 },                // free
];
const MIXES = [
  AGENTIC_MIX,
  { inputPct: 30, cacheReadPct: 50, outputPct: 20 },
  { inputPct: 0, cacheReadPct: 100, outputPct: 0 },
  { inputPct: 100, cacheReadPct: 0, outputPct: 0 },
];

test('blendedRate matches the app.js blendedCostFor mirror on every fixture', () => {
  for (const pricing of FIXTURES) {
    for (const mix of MIXES) {
      const shared = blendedRate(pricing, mix);
      // Both shared/cost.mjs and the mirrored app.js copy read cacheReadPct
      // (the getTokens() key shape) — pass the same mix object to each.
      const app = appBlendedCostFor(pricing, mix);
      assert.equal(shared, app, `blendedRate(${JSON.stringify(pricing)}, ${JSON.stringify(mix)})`);
    }
  }
});

test('blendedRate: null cache_read falls back to the INPUT rate (does not drop the leg)', () => {
  // The regression: generate-seo used to compute input*0.025 + output*0.005 for
  // null-cache models, making them ~97% too cheap in the SEO top-25.
  const rate = blendedRate({ input: 0.019, output: 0.03, cache_read: null }, AGENTIC_MIX);
  const expected = 0.019 * 0.025 + 0.019 * 0.97 + 0.03 * 0.005;
  assert.ok(Math.abs(rate - expected) < 1e-12, `expected ${expected}, got ${rate}`);
});

test('blendedRate: $0 cache_read stays a $0 leg (no >0 guard on the fallback)', () => {
  const rate = blendedRate({ input: 2, output: 4, cache_read: 0 }, AGENTIC_MIX);
  const expected = 2 * 0.025 + 0 * 0.97 + 4 * 0.005;
  assert.ok(Math.abs(rate - expected) < 1e-12, `expected ${expected}, got ${rate}`);
});

test('blendedRate: unpriced input with inputPct > 0 returns null (cannot serve the mix)', () => {
  assert.equal(blendedRate({ input: null, output: 1 }, AGENTIC_MIX), null);
  // inputPct=0 → input price doesn't matter; output leg alone is priced: 1 × 100/100 = 1.0
  assert.equal(blendedRate({ input: null, output: 1 }, { inputPct: 0, cacheReadPct: 0, outputPct: 100 }), 1.0);
});

test('cheapestModels picks 25, ranks ascending, drops unpriced/free-negative entries', () => {
  const m = (id, input, output, cache_read) => ({ id, name: id, org: 'x', provider: 'p', pricing: { input, output, cache_read } });
  const models = [
    m('cheap', 0.01, 0.02, 0.001),
    m('zero-eff', 0, 0, null),                 // eff = 0 → dropped
    m('null-input', null, 1, null),            // eff null → dropped
    m('pricy', 5, 10, 1),
  ];
  const picked = cheapestModels(models, 25);
  assert.equal(picked.length, 2);
  assert.ok(picked[0].eff < picked[1].eff, 'ascending by effective rate');
  assert.equal(picked[0].m.id, 'cheap');
});

test('renderSeoTable includes id="cheapest" anchor and escapes data', () => {
  const priced = [{ m: { org: 'a', provider: 'p', name: 'M <script>', pricing: { input: 1, output: 2, cache_read: null } }, eff: 1.5 }];
  const html = renderSeoTable(priced, '2026-08-03');
  assert.ok(html.includes('class="seo-models" id="cheapest"'), 'anchor id must exist for the noscript #cheapest link');
  assert.ok(html.includes('M &lt;script&gt;'), 'model names must be HTML-escaped');
  assert.ok(html.includes('2026-08-03'));
});

test('renderCounts substitutes live counts in every placeholder', () => {
  const markup = '<title>{{modelCount}} across {{providerCount}}</title>'
    + ' "{{modelCount}} models across {{providerCount}} providers"'; // JSON-LD-style double mention
  const out = renderCounts(markup, 994, 81);
  assert.ok(!out.includes('{{'), 'no placeholders may survive replacement');
  assert.ok(out.includes('994') && out.includes('81'));
});

test('renderCounts throws when a placeholder cannot be resolved (drifted token)', () => {
  const drifted = 'Compare {{ modelCount }} models';
  assert.throws(() => renderCounts(drifted, 994, 81), /unreplaced count placeholder/);
});

test('buildSitemap / buildRobots are well-formed and reference the site', () => {
  const sitemap = buildSitemap('2026-08-03');
  assert.ok(sitemap.includes('<lastmod>2026-08-03</lastmod>'));
  assert.ok(sitemap.includes('https://tokenwatch.wyrdwerk.com/'));
  assert.ok((sitemap.match(/<url>/g) || []).length === 3);
  assert.ok(buildRobots().includes('Disallow: /api/'));
  assert.ok(buildRobots().includes('Sitemap: https://tokenwatch.wyrdwerk.com/sitemap.xml'));
});