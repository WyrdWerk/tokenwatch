// Build-time homepage hero: "same model, different bill". Pure — takes the
// pricing catalog, returns markup. Injected by generate-seo via replaceSection.
import { blendedRate, AGENTIC_MIX } from '../shared/cost.mjs';
import { canonicalId } from '../shared/normalize.mjs';
import { esc, fmtPrice } from './seo-pages.mjs';

export const HERO_LANES = 5;
const MIN_PROVIDERS = 3;

function isBatchOrFree(id) {
  return /:batch$|:free$/i.test(String(id));
}

/** Friendly model name: prefer an "Org: Name" display name, else the canonical id. */
function heroModelName(models, canonical) {
  const named = models.find((m) => /^[^/:]+: /.test(m.name || ''));
  if (named) return named.name.split(': ').slice(1).join(': ');
  return canonical;
}

/** Pick the canonical model with the most distinct priced providers at
 *  AGENTIC_MIX (ties → id), keeping each provider's cheapest offering. */
export function pickHeroModel(models) {
  const groups = new Map();
  for (const m of models || []) {
    if (!m?.pricing || isBatchOrFree(m.id)) continue;
    const eff = blendedRate(m.pricing, AGENTIC_MIX);
    if (eff == null || !(eff > 0)) continue;
    const canonical = canonicalId(m.id);
    if (!groups.has(canonical)) groups.set(canonical, { canonical, offerings: [], byProvider: new Map() });
    const g = groups.get(canonical);
    g.offerings.push(m);
    const prev = g.byProvider.get(m.provider);
    if (!prev || eff < prev.eff) g.byProvider.set(m.provider, { model: m, eff });
  }
  let best = null;
  for (const g of groups.values()) {
    const n = g.byProvider.size;
    if (n < MIN_PROVIDERS) continue;
    if (!best || n > best.byProvider.size || (n === best.byProvider.size && g.canonical < best.canonical)) best = g;
  }
  if (!best) return null;
  const ranked = [...best.byProvider.values()].sort((a, b) => a.eff - b.eff || a.model.provider.localeCompare(b.model.provider));
  return {
    canonical: best.canonical,
    name: heroModelName(best.offerings, best.canonical),
    providerCount: ranked.length,
    ranked,
    spread: ranked.at(-1).eff / ranked[0].eff,
  };
}

/** Cheapest, 25th/50th/75th percentile and most expensive providers — an
 *  honest view of the spread rather than a cherry-picked pair. */
export function heroLanes(ranked, lanes = HERO_LANES) {
  if (!ranked?.length) return [];
  if (ranked.length <= lanes) return ranked.slice();
  const picks = [];
  const seen = new Set();
  for (let i = 0; i < lanes; i++) {
    const idx = Math.round((i * (ranked.length - 1)) / (lanes - 1));
    if (!seen.has(idx)) { seen.add(idx); picks.push(ranked[idx]); }
  }
  return picks;
}

function fmtSpread(x) {
  return x >= 10 ? `${Math.round(x)}×` : `${x.toFixed(1)}×`;
}

function providerLabel(model, providers) {
  return model.provider_display || providers?.find((p) => p.key === model.provider)?.name || model.provider;
}

function renderScene(lanes, providers) {
  const W = 560, H = 200, laneX = 238, meterX = 330, meterMax = 120;
  const top = 22, gap = (H - 2 * top) / Math.max(1, lanes.length - 1);
  const maxEff = Math.max(...lanes.map((l) => l.eff));
  const ys = lanes.map((_, i) => (lanes.length === 1 ? H / 2 : top + i * gap));
  const css = [];
  const parts = [];
  lanes.forEach((lane, i) => {
    const y = ys[i];
    const cheapest = i === 0;
    const w = Math.max(6, Math.round((lane.eff / maxEff) * meterMax));
    const cls = cheapest ? ' tw-hero-win' : '';
    parts.push(`<path class="tw-hero-lane${cls}" d="M200 100 C 220 100, 218 ${y}, ${laneX} ${y} L ${meterX - 8} ${y}"/>`);
    parts.push(`<rect class="tw-hero-track" x="${meterX}" y="${y - 7}" width="${meterMax}" height="14" rx="3"/>`);
    parts.push(`<rect class="tw-hero-meter${cls}" style="animation-delay:${(1.6 + i * 0.12).toFixed(2)}s" x="${meterX}" y="${y - 7}" width="${w}" height="14" rx="3"/>`);
    parts.push(`<text class="tw-hero-prov${cls}" x="${laneX}" y="${y - 6}">${esc(providerLabel(lane.model, providers))}</text>`);
    parts.push(`<text class="tw-hero-rate${cls}" x="${meterX + meterMax + 8}" y="${y + 4}">${esc(fmtPrice(lane.eff))}/M${cheapest ? ' 🏆' : ''}</text>`);
    // Three staggered token dots per lane, transform-only keyframes.
    css.push(`@keyframes tw-hero-flow-${i}{0%{transform:translate(34px,100px);opacity:0}8%{opacity:1}45%{transform:translate(200px,100px)}55%{transform:translate(${laneX}px,${y}px)}72%{transform:translate(${meterX - 8}px,${y}px);opacity:1}78%,100%{transform:translate(${meterX - 8}px,${y}px);opacity:0}}`);
    for (let d = 0; d < 3; d++) {
      parts.push(`<circle class="tw-hero-dot${cls}" r="3.2" style="animation-name:tw-hero-flow-${i};animation-delay:${(d * 0.45 + i * 0.08).toFixed(2)}s"/>`);
    }
  });
  const label = lanes.map((l) => `${providerLabel(l.model, providers)} ${fmtPrice(l.eff)} per million tokens`).join('; ');
  return `<svg class="tw-hero-scene" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`Blended price at an agentic mix: ${label}`)}">
    <style>${css.join('')}</style>
    <path class="tw-hero-trunk" d="M34 100 L 200 100"/>
    <circle class="tw-hero-prompt" cx="22" cy="100" r="12"/>
    <text class="tw-hero-prompt-label" x="22" y="128">prompt</text>
    ${parts.join('\n    ')}
  </svg>`;
}

/** Hero section markup. Falls back to pitch + CTAs when no model has enough providers. */
export function renderHero(pricing) {
  const models = pricing?.models || [];
  const providers = pricing?.providers || [];
  const pick = pickHeroModel(models);
  const providerTotal = new Set(models.map((m) => m.provider)).size;
  const mix = `${AGENTIC_MIX.inputPct}% input · ${AGENTIC_MIX.cacheReadPct}% cached · ${AGENTIC_MIX.outputPct}% output`;
  const pitch = pick
    ? `Same model. ${pick.providerCount} providers. Up to ${fmtSpread(pick.spread)} apart.`
    : `${providerTotal} providers. One workload. Very different bills.`;
  const sub = pick
    ? `${esc(pick.name)} at an agentic mix (${mix}), blended $/M. <a href="/docs/methodology/">How we calculate</a>`
    : `Prices are compared at your own token mix. <a href="/docs/methodology/">How we calculate</a>`;
  const compare = pick
    ? `<button type="button" class="tw-hero-cta tw-hero-cta-ghost" data-hero-model="${esc(pick.canonical)}">Compare ${esc(pick.name)}</button>`
    : '';
  const scene = pick ? renderScene(heroLanes(pick.ranked), providers) : '';
  return `<section class="tw-hero" id="twHero" aria-label="Why the provider matters">
  <div class="tw-hero-copy">
    <p class="tw-hero-pitch">${esc(pitch)}</p>
    <p class="tw-hero-sub">${sub}</p>
    <div class="tw-hero-ctas">
      <button type="button" class="tw-hero-cta" data-hero-action="estimate">Estimate my workload ↓</button>
      ${compare}
    </div>
  </div>
  ${scene}
</section>`;
}
