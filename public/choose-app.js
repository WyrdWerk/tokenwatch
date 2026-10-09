import { MIN_BENCHMARK_COVERAGE, shortlistModels, rankProviders } from '/shared/recommend.mjs';
import { USE_CASES } from '/shared/use-cases.mjs';
import {
  DEFAULT_CHOOSE_STATE,
  buildCalculatorHref,
  gateStatusText,
  isCloseCall,
  isStale,
  FEATURED_PROVIDER_COUNT,
  PRIORITY_ROLE_LABELS,
  modelDisplayName,
  providerDisplayName,
  pickFeaturedProviders,
  parseChooseHash,
  parseChooseLocation,
  shellQuote,
  serializeChooseState,
  stripUseCaseQuery,
  useCaseLabel,
} from '/shared/choose-page.mjs';


const PICK_OPTIONS = [
  { key: 'quality', label: 'Best quality', resultKey: 'bestQuality', tone: 'quality' },
  { key: 'value', label: 'Best value', resultKey: 'bestValue', tone: 'value' },
  { key: 'cheapest', label: 'Cheapest good-enough', resultKey: 'cheapestAboveFloor', tone: 'cheapest' },
];

const GATE_LABELS = {
  open_weights: 'Open-weight model',
  subscription: 'Subscription offering',
  tool_calling: 'Tool-calling support',
  structured_output: 'Structured-output support',
  minimum_context: 'Minimum context size',
  headquarters: 'Provider headquarters',
  excluded_headquarters: 'Excluded headquarters',
  minimum_uptime: 'Minimum uptime',
  known_issue: 'Known provider issues',
  lifecycle: 'Not deprecated (models.dev)',
  priceable_mix: 'Price for this workload mix',
  quantization_policy: 'Quantization policy',
  benchmark_coverage: 'Benchmark coverage',
  quality_floor: 'Minimum quality score',
};

const WARNING_REASON = /degraded warning|low-bit quantization|asynchronous batch|subscription plan|tool-choice control|no implicit prompt-caching|long-context price increase|pre-release offering/i;
const elements = Object.fromEntries([
  'chooseStatus', 'useCaseNotice', 'preferenceFeature', 'preferenceSummary', 'preferenceAttribution',
  'modelCards', 'alsoConsidered', 'notEnoughData',
  'hqOptions', 'requireZdr', 'includeProprietary', 'providerHeading', 'providerRows',
  'providerCloseNote', 'unverifiedSection', 'unverifiedRows', 'estimateBill',
  'compareModel', 'copySetup', 'shareLink', 'copyPrompt', 'actionStatus',
].map((id) => [id, document.getElementById(id)]));

window.TW.initTheme();

let catalogs;
let recommendations;
let providerCandidateOverride = null;
let state = parseChooseLocation(location.search, location.hash);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function formatRate(value) {
  return Number.isFinite(value)
    ? `$${value.toLocaleString('en-US', { maximumSignificantDigits: 4 })}`
    : 'Not priced';
}

function formatNumber(value, digits = 1) {
  return Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
}

function formatMix(mix) {
  return `${mix.inputPct}% input · ${mix.cacheReadPct}% cached input · ${mix.outputPct}% output`;
}

function sourceName(source) {
  if (typeof source === 'string') return source;
  if (!source || typeof source !== 'object') return 'Source not disclosed';
  const suffix = source.release ? ` · ${source.release}` : '';
  return `${source.name || source.transport || 'Source not disclosed'}${suffix}`;
}

function sourceWindow(source) {
  if (!source || typeof source !== 'object' || !source.window) return '';
  const labels = { '30m': 'last 30 min', '1h': 'last hour', '1d': 'last day' };
  return labels[source.window] || source.window;
}

function providerName(provider, offering = null) {
  return providerDisplayName(provider, offering, catalogs.pricing.providers, catalogs.pricing.providers_meta);
}

function countryLabel(country) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(country) || country;
  } catch {
    return country;
  }
}

function candidatesByPick() {
  return Object.fromEntries(PICK_OPTIONS.map(({ key, resultKey }) => [key, recommendations?.[resultKey] || null]));
}

function selectedCandidate() {
  if (providerCandidateOverride) return providerCandidateOverride;
  const picks = candidatesByPick();
  return picks[state.pick] || Object.values(picks).find(Boolean) || null;
}

function syncHash() {
  const hash = serializeChooseState(state);
  history.replaceState(null, '', `${location.pathname}${stripUseCaseQuery(location.search)}${hash}`);
}

function writeControlState() {
  const selectedUseCase = document.querySelector('input[name="useCase"]:checked');
  const selectedPriority = document.querySelector('input[name="priority"]:checked');
  state = {
    ...state,
    useCase: selectedUseCase?.value || DEFAULT_CHOOSE_STATE.useCase,
    priority: selectedPriority?.value || DEFAULT_CHOOSE_STATE.priority,
    requireZdr: elements.requireZdr.checked,
    includeProprietary: elements.includeProprietary.checked,
    excludeHQ: [...elements.hqOptions.querySelectorAll('input[name="excludeHQ"]:checked')].map((input) => input.value).sort(),
    provider: null,
  };
  providerCandidateOverride = null;
  syncHash();
  calculate();
}

function applyStateToControls() {
  const useCase = document.querySelector(`input[name="useCase"][value="${CSS.escape(state.useCase)}"]`);
  const priority = document.querySelector(`input[name="priority"][value="${CSS.escape(state.priority)}"]`);
  if (useCase) useCase.checked = true;
  if (priority) priority.checked = true;
  elements.requireZdr.checked = state.requireZdr;
  elements.includeProprietary.checked = state.includeProprietary;
  for (const input of elements.hqOptions.querySelectorAll('input[name="excludeHQ"]')) {
    input.checked = state.excludeHQ.includes(input.value);
  }
}

function renderHeadquartersOptions() {
  const countries = new Map();
  for (const model of catalogs.pricing.models) {
    const country = model.headquarters || model.hq || catalogs.pricing.providers_meta?.[model.provider]?.headquarters;
    if (typeof country === 'string' && /^[A-Za-z]{2}$/.test(country)) countries.set(country.toUpperCase(), country.toUpperCase());
  }
  elements.hqOptions.innerHTML = [...countries.values()].sort().map((country) => `
    <label class="choose-country"><input type="checkbox" name="excludeHQ" value="${escapeHtml(country)}" /> ${escapeHtml(countryLabel(country))} <span>${escapeHtml(country)}</span></label>
  `).join('') || '<span class="choose-muted">No headquarters locations are listed in this snapshot.</span>';
}

function confidenceBadge(confidence) {
  return isCloseCall(confidence) ? '<span class="choose-badge choose-badge-close">Close call</span>' : '';
}

// Only flag coverage that is genuinely low: below the engine's quality-eligibility
// threshold. The exact share is always listed under "Why this model?".
function coverageBadge(candidate) {
  if (Number.isFinite(candidate.qualityCoverage) && candidate.qualityCoverage < MIN_BENCHMARK_COVERAGE) {
    return '<span class="choose-badge choose-badge-partial">Low benchmark coverage</span>';
  }
  return '';
}

function batchBadge(candidate) {
  return /:batch$/i.test(candidate.offering?.id || '') || candidate.reasons?.some((reason) => /asynchronous batch/i.test(reason))
    ? '<span class="choose-badge choose-badge-batch">Batch endpoint</span>'
    : '';
}

function openWeightLabel(candidate) {
  if (candidate.openWeights === true) return `Open weights${candidate.openWeightsSource ? ` · ${escapeHtml(candidate.openWeightsSource)}` : ''}`;
  if (candidate.openWeights === false) return 'Proprietary weights';
  return 'Open-weight status unknown';
}

function explanationMarkup(candidate) {
  const explanation = candidate.explanation;
  const recommendedProvider = candidate.providers?.[0];
  const providerExplanation = recommendedProvider?.explanation;
  const signals = explanation.benchmark.signals.map((signal) => `
    <tr>
      <th scope="row">${escapeHtml(signal.field.replaceAll('_', ' '))}</th>
      <td>${signal.rawValue === null ? 'No score' : formatNumber(signal.rawValue, 2)}</td>
      <td>${escapeHtml(sourceName(signal.source))}</td>
      <td>${formatNumber(signal.weight * 100, 0)}%</td>
    </tr>
  `).join('');
  const weights = Object.entries(explanation.weights.benchmark)
    .map(([field, weight]) => `<li>${escapeHtml(field.replaceAll('_', ' '))}: ${formatNumber(weight * 100, 0)}%</li>`).join('');
  const gates = explanation.gates.map((gate) => (
    `<li><strong>${escapeHtml(GATE_LABELS[gate.key] || gate.key.replaceAll('_', ' '))}:</strong> ${escapeHtml(gateStatusText(gate))}</li>`
  )).join('');
  const providerWeights = Object.entries(providerExplanation?.weights || {})
    .map(([field, weight]) => `<li>${escapeHtml(field)}: ${formatNumber(weight * 100, 0)}%</li>`).join('');
  const providerSignals = (providerExplanation?.signals || []).map((signal) => `
    <tr><th scope="row">${escapeHtml(signal.field)}</th><td>${signal.rawValue === null ? 'No value' : formatNumber(signal.rawValue, 2)}</td>
      <td>${escapeHtml(sourceName(signal.source))}${sourceWindow(signal.source) ? ` · ${escapeHtml(sourceWindow(signal.source))}` : ''}</td><td>${formatNumber(signal.weight * 100, 0)}%</td></tr>
  `).join('');
  const providerMissing = providerExplanation?.missingSignals?.length
    ? `<ul>${providerExplanation.missingSignals.map((signal) => `<li>${escapeHtml(signal.field)}: ${escapeHtml(signal.reason)}</li>`).join('')}</ul>`
    : '<p>No provider telemetry signals are missing.</p>';
  const providerGates = (providerExplanation?.gates || []).map((gate) => (
    `<li><strong>${escapeHtml(GATE_LABELS[gate.key] || gate.key.replaceAll('_', ' '))}:</strong> ${escapeHtml(gateStatusText(gate))}</li>`
  )).join('');
  const missing = explanation.benchmark.missingSignals.length
    ? `<ul>${explanation.benchmark.missingSignals.map((signal) => `<li>${escapeHtml(signal.field.replaceAll('_', ' '))}: ${escapeHtml(signal.reason)}</li>`).join('')}</ul>`
    : '<p>No benchmark fields in this use case are missing.</p>';
  const mix = explanation.mix;
  return `<details class="choose-why">
    <summary>Why this model?</summary>
    <div class="choose-explanation">
      <p class="choose-coverage-line"><strong>Benchmark coverage: ${formatNumber(explanation.benchmark.coverage * 100, 0)}%</strong> of this use case’s benchmark weight has a published score (quality picks need at least ${formatNumber(MIN_BENCHMARK_COVERAGE * 100, 0)}%).</p>
      <h4>Benchmark weights</h4><ul>${weights}</ul>
      <h4>Raw benchmark scores and sources</h4>
      <div class="choose-table-wrap"><table><thead><tr><th scope="col">Signal</th><th scope="col">Raw score</th><th scope="col">Source</th><th scope="col">Weight</th></tr></thead><tbody>${signals}</tbody></table></div>
      <h4>Missing benchmark signals</h4>${missing}
      <h4>Eligibility gates</h4><ul>${gates}</ul>
      ${providerExplanation ? `<h4>Provider weights · ${escapeHtml(providerName(recommendedProvider.provider, recommendedProvider.offering))}</h4><ul>${providerWeights}</ul>
      <h4>Provider signals and sources</h4><div class="choose-table-wrap"><table><thead><tr><th scope="col">Signal</th><th scope="col">Raw value</th><th scope="col">Source / window</th><th scope="col">Weight</th></tr></thead><tbody>${providerSignals}</tbody></table></div>
      <h4>Missing provider signals</h4>${providerMissing}<h4>Provider gates</h4><ul>${providerGates}</ul>` : ''}
      <p><strong>Mix:</strong> ${formatMix(mix)} <span class="choose-assumed">Typical workload (assumed)</span></p>
      <p>Composite ${formatNumber(explanation.benchmark.finalScore)}/100; ${formatNumber(explanation.benchmark.coverage * 100, 0)}% of benchmark weight observed. Missing weight is shrunk toward the eligible cohort median.</p>
    </div>
  </details>`;
}

function renderModelCard(candidate, option) {
  if (!candidate) {
    return `<article class="choose-model-card choose-model-card-empty"><p class="choose-pick-label">${escapeHtml(option.label)}</p><h3>No qualifying pick</h3><p>Current constraints leave no model in this category. Remove a filter or include proprietary models to broaden the search.</p></article>`;
  }
  const selected = state.pick === option.key;
  const mix = USE_CASES[state.useCase].mix;
  const coverage = Number.isFinite(candidate.qualityCoverage) ? formatNumber(candidate.qualityCoverage * 100, 0) : '—';
  const openWeight = openWeightLabel(candidate);
  const bestProvider = candidate.recommendedProvider
    ? providerName(candidate.recommendedProvider.provider, candidate.recommendedProvider.offering)
    : 'Provider not reported';
  const cheapest = candidate.blendedRate === null ? 'Not priced' : `${formatRate(candidate.blendedRate)} / M`;
  const signal = candidate.explanation.benchmark.signals.find((item) => item.field === USE_CASES[state.useCase].qualityFloor.field);
  return `<article class="choose-model-card${selected ? ' is-selected' : ''}" data-model-id="${escapeHtml(candidate.id)}">
    <div class="choose-card-topline"><p class="choose-pick-label">${escapeHtml(option.label)}</p><div class="choose-badges">${coverageBadge(candidate)}${batchBadge(candidate)}${confidenceBadge(candidate.confidence)}</div></div>
    <h3>${escapeHtml(modelDisplayName(candidate))}</h3>
    <p class="choose-model-id">${escapeHtml(candidate.id)}</p>
    <p class="choose-card-provider">Suggested provider: <strong>${escapeHtml(bestProvider)}</strong></p>
    <div class="choose-score-block"><strong>${formatNumber(candidate.qualityScore)}/100</strong><span>relative benchmark score · ${coverage}% covered</span></div>
    ${signal?.rawValue !== null && signal ? `<p class="choose-primary-score">${escapeHtml(signal.field.replaceAll('_', ' '))}: ${formatNumber(signal.rawValue, 2)} <span>(${escapeHtml(sourceName(signal.source))})</span></p>` : ''}
    <p class="choose-card-price"><strong>${cheapest}</strong><span>lowest eligible provider · blended at the mix below</span></p>
    <p class="choose-assumed-line"><span class="choose-assumed">Typical workload (assumed)</span> ${escapeHtml(formatMix(mix))}</p>
    <p class="choose-license-line"><span>${escapeHtml(openWeight)}</span><span>${candidate.license ? `License: ${escapeHtml(candidate.license)}` : 'License not disclosed'}</span></p>
    <a class="choose-workload-link" href="${escapeHtml(buildCalculatorHref(candidate.id, mix))}">Change workload in the Text calculator →</a>
    <button class="choose-select-model" type="button" data-pick="${option.key}" aria-pressed="${selected}">${selected ? 'Selected · showing providers' : 'Show providers for this model'}</button>
    ${explanationMarkup(candidate)}
  </article>`;
}

function cappedList(items, label, renderItem, limit = 8) {
  if (!items.length) return '<p class="choose-empty-list">No additional models in this group for the current filters.</p>';
  const visible = items.slice(0, limit).map(renderItem).join('');
  if (items.length <= limit) return `<ul>${visible}</ul>`;
  const remaining = items.slice(limit).map(renderItem).join('');
  return `<ul>${visible}</ul><details class="choose-list-more"><summary>Show all ${items.length} ${escapeHtml(label)}</summary><ul>${remaining}</ul></details>`;
}

function renderOtherModels() {
  const pickedIds = new Set(Object.values(candidatesByPick()).filter(Boolean).map((candidate) => candidate.id));
  const additional = recommendations.qualityRanking.filter((candidate) => !pickedIds.has(candidate.id));
  const partial = recommendations.partiallyBenchmarked;
  const rows = [...additional, ...partial].filter((candidate, index, candidates) =>
    candidates.findIndex((other) => other.id === candidate.id) === index);
  elements.alsoConsidered.innerHTML = cappedList(rows, 'models', (candidate) => `
    <li class="choose-list-row"><span><strong>${escapeHtml(modelDisplayName(candidate))}</strong><small>${escapeHtml(candidate.id)}</small></span>
      <span class="choose-list-meta">${formatNumber(candidate.qualityScore)}/100${coverageBadge(candidate)}${batchBadge(candidate)}${confidenceBadge(candidate.confidence)}</span></li>
  `);

  const notEnough = recommendations.unbenchmarked;
  elements.notEnoughData.innerHTML = cappedList(notEnough, 'models', (candidate) => `
    <li class="choose-list-row"><span><strong>${escapeHtml(modelDisplayName(candidate))}</strong><small>${escapeHtml(candidate.id)}</small></span>
      <span class="choose-list-meta">${candidate.blendedRate === null ? 'No workload price' : `${formatRate(candidate.blendedRate)} / M`}<span class="choose-badge choose-badge-partial">No benchmark score</span></span></li>
  `);
}

function isWarningReason(reason) {
  return WARNING_REASON.test(reason);
}

function staleLabel(timestamp, now) {
  return isStale(timestamp, now) ? '<span class="choose-stale">Stale · snapshot is over 6 hours old</span>' : '';
}

function providerMetric(label, value, source, stale = '') {
  const namedSource = sourceName(source);
  const window = sourceWindow(source);
  return `<div class="choose-provider-metric"><dt>${escapeHtml(label)}</dt><dd>${value}<small>${escapeHtml(namedSource)}${window ? ` · ${escapeHtml(window)}` : ''}${stale}</small></dd></div>`;
}

function renderProviderRow(provider, now, roles = []) {
  const offering = provider.offering || {};
  const signals = provider.explanation?.signals || [];
  const signal = (field) => signals.find((entry) => entry.field === field);
  const perfAt = catalogs.performance._meta?.generated_at;
  const perfStale = staleLabel(perfAt, now);
  const uptimeStale = staleLabel(catalogs.pricing.generated_at, now);
  const isSelected = state.provider === provider.provider;
  const source = (field) => signal(field)?.source;
  const metrics = [
    providerMetric('Blended $ / M', escapeHtml(formatRate(provider.blendedRate)), source('price')),
    providerMetric('Speed · throughput p50', Number.isFinite(provider.throughputP50) ? `${formatNumber(provider.throughputP50, 1)} tokens/s` : 'Not reported', source('throughput'), Number.isFinite(provider.throughputP50) ? perfStale : ''),
    providerMetric('TTFT p50', Number.isFinite(provider.ttftP50) ? `${formatNumber(provider.ttftP50, 1)} ms` : 'Not reported', source('ttft'), Number.isFinite(provider.ttftP50) ? perfStale : ''),
    providerMetric(provider.uptimeWindow === '1d' ? 'Uptime · 1 day' : 'Uptime · 30 min', Number.isFinite(provider.uptime) ? `${formatNumber(provider.uptime, 2)}%` : 'Not reported', source('uptime'), Number.isFinite(provider.uptime) ? uptimeStale : ''),
    providerMetric('Quantization', provider.quantization ? escapeHtml(provider.quantization) : 'Not disclosed', 'TokenWatch provider catalog'),
    providerMetric('Zero data retention', offering.zdr === true ? 'Yes' : offering.zdr === false ? 'No' : 'Not reported', 'TokenWatch provider catalog'),
  ].join('');
  const reasons = (provider.reasons || []).filter((reason) => !isWarningReason(reason));
  const warnings = (provider.reasons || []).filter(isWarningReason);
  const lists = [
    reasons.length ? `<div><h4>Reasons</h4><ul>${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></div>` : '',
    warnings.length ? `<div class="choose-warning-list"><h4>Warnings</h4><ul>${warnings.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></div>` : '',
    provider.unknowns?.length ? `<div class="choose-unknown-list"><h4>Unknowns</h4><ul>${provider.unknowns.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul></div>` : '',
  ].filter(Boolean).join('');
  const subscription = offering.subscription === true ? '<span class="choose-badge choose-badge-subscription">Subscription plan</span>' : '';
  const hq = offering.headquarters || offering.hq || catalogs.pricing.providers_meta?.[provider.provider]?.headquarters;
  return `<article class="choose-provider-card${isSelected ? ' is-selected' : ''}">
    <div class="choose-provider-title"><div><h3>${escapeHtml(providerName(provider.provider, offering))}</h3><p>${escapeHtml(offering.id || provider.canonicalId)}</p></div>
      <div class="choose-badges">${roles.map((role) => `<span class="choose-badge choose-badge-role">${escapeHtml(role)}</span>`).join('')}${subscription}${isCloseCall(provider.confidence) ? '<span class="choose-badge choose-badge-close">Close call</span>' : ''}</div></div>
    <dl class="choose-provider-metrics">${metrics}</dl>
    <p class="choose-provider-hq">Headquarters: ${hq ? `${escapeHtml(countryLabel(String(hq).toUpperCase()))} (${escapeHtml(hq)})` : 'Not disclosed'}</p>
    ${lists ? `<div class="choose-provider-notes">${lists}</div>` : ''}
    <button type="button" class="choose-provider-select" data-provider="${escapeHtml(provider.provider)}" aria-pressed="${isSelected}">${isSelected ? 'Selected for setup' : 'Use this provider'}</button>
  </article>`;
}

function alternativeProviders(candidate) {
  if (!candidate?.providers?.length) return {};
  const offerings = candidate.providers.map((provider) => provider.offering).filter(Boolean);
  const constraints = {
    requireZdr: state.requireZdr,
    excludeHQ: state.excludeHQ,
    providersMeta: catalogs.pricing.providers_meta,
  };
  return Object.fromEntries(['cheapest', 'fastest', 'most-reliable'].map((priority) => {
    const ranked = rankProviders(state.useCase, candidate.id, offerings, catalogs.performance, { ...constraints, priority });
    return [priority, ranked.ranked[0] || null];
  }));
}

const KEY_REASON = /lowest blended price|lowest .*ttft|highest throughput|reported uptime|only qualifying option|subscription plan|low-bit quantization/i;

function providerKeyReason(provider) {
  const reasons = provider.reasons || [];
  return reasons.find((reason) => KEY_REASON.test(reason)) || reasons.find(isWarningReason)
    || (provider.unknowns?.[0] ? `Unknown: ${provider.unknowns[0]}` : '') || reasons[0] || '';
}

function compactProviderRow(provider, now) {
  const offering = provider.offering || {};
  const speed = Number.isFinite(provider.throughputP50) ? `${formatNumber(provider.throughputP50, 0)} tok/s` : '—';
  const uptime = Number.isFinite(provider.uptime) ? `${formatNumber(provider.uptime, 1)}%` : '—';
  return `<li class="choose-provider-row${state.provider === provider.provider ? ' is-selected' : ''}"><details>
    <summary>
      <span class="choose-provider-row-name"><strong>${escapeHtml(providerName(provider.provider, offering))}</strong><small>${escapeHtml(offering.id || provider.canonicalId)}</small></span>
      <span class="choose-provider-row-metric" data-label="$/M">${escapeHtml(formatRate(provider.blendedRate))}</span>
      <span class="choose-provider-row-metric" data-label="Speed">${speed}</span>
      <span class="choose-provider-row-metric" data-label="Uptime">${uptime}</span>
      <span class="choose-provider-row-reason">${escapeHtml(providerKeyReason(provider))}</span>
    </summary>
    ${renderProviderRow(provider, now)}
  </details></li>`;
}

function renderProviders(candidate) {
  elements.providerHeading.textContent = candidate ? `Providers for ${modelDisplayName(candidate)}` : 'Providers for this model';
  if (!candidate) {
    elements.providerRows.innerHTML = '<p class="choose-empty-list">Choose a recommendation with eligible providers to see the comparison.</p>';
    elements.providerRows.setAttribute('aria-busy', 'false');
    elements.providerCloseNote.hidden = true;
    elements.unverifiedSection.hidden = true;
    return;
  }
  const providers = candidate.providers || [];
  const now = Date.now();
  const close = isCloseCall(providers[0]?.confidence);
  const alternatives = close ? alternativeProviders(candidate) : null;
  if (close) {
    elements.providerCloseNote.innerHTML = `<strong>Top picks are close.</strong> The current ranking doesn’t establish one clear winner. Best by priority: ${Object.keys(PRIORITY_ROLE_LABELS).map((priority) => {
      const pick = alternatives[priority];
      return pick ? `<span>${PRIORITY_ROLE_LABELS[priority]}: <b>${escapeHtml(providerName(pick.provider, pick.offering))}</b></span>` : '';
    }).filter(Boolean).join(' · ')}`;
    elements.providerCloseNote.hidden = false;
  } else {
    elements.providerCloseNote.hidden = true;
  }
  if (providers.length) {
    const { featured, roles } = pickFeaturedProviders(providers, alternatives, state.provider);
    const rest = providers.filter((provider) => !featured.includes(provider));
    const cards = featured.map((provider) => renderProviderRow(provider, now, roles.get(provider))).join('');
    const more = rest.length ? `<details class="choose-provider-more">
      <summary>Show all ${providers.length} providers <span>${rest.length} more, in ranked order</span></summary>
      <div class="choose-provider-row-head" aria-hidden="true"><span>Provider</span><span>$/M</span><span>Speed</span><span>Uptime</span><span>Key reason</span></div>
      <ul class="choose-provider-rows">${rest.map((provider) => compactProviderRow(provider, now)).join('')}</ul>
    </details>` : '';
    elements.providerRows.innerHTML = `<div class="choose-provider-featured">${cards}</div>${more}`;
  } else {
    elements.providerRows.innerHTML = '<p class="choose-empty-list">No priced provider passes the current constraints. Try relaxing a filter.</p>';
  }
  elements.providerRows.setAttribute('aria-busy', 'false');

  const unverified = candidate.unverifiedProviders || [];
  elements.unverifiedSection.hidden = !unverified.length;
  elements.unverifiedRows.innerHTML = unverified.length ? cappedList(unverified, 'unverified providers', (provider) => {
    const notes = [...(provider.unknowns || []).map((item) => `Unknown: ${item}`), ...(provider.reasons || [])];
    return `<li class="choose-list-row choose-unverified-row"><details><summary><span><strong>${escapeHtml(providerName(provider.provider, provider.offering))}</strong><small>${escapeHtml(provider.offering?.id || candidate.id)}</small></span>
      <span class="choose-list-meta">${provider.blendedRate === null ? 'Price unavailable' : `${formatRate(provider.blendedRate)} / M`}${provider.unknowns?.length ? `<small>${escapeHtml(provider.unknowns[0])}${provider.unknowns.length > 1 ? ` +${provider.unknowns.length - 1} more` : ''}</small>` : ''}</span></summary>
      ${notes.length ? `<ul class="choose-unverified-notes">${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>` : ''}</details></li>`;
  }, FEATURED_PROVIDER_COUNT) : '';
}

function selectedProvider(candidate) {
  const providers = candidate?.providers || [];
  return providers.find((provider) => provider.provider === state.provider) || providers[0] || null;
}

// Setup hints from models.dev provider metadata. Only well-formed names are echoed into the
// copyable shell snippet; anything else is dropped rather than quoted. models.dev lists every
// env var a provider needs (e.g. an account id next to the key), unordered, so API_KEY is only
// wired when exactly one name looks like a credential.
function setupHintLines(providerKey) {
  const meta = catalogs?.pricing?.providers_meta?.[providerKey];
  const lines = [];
  const envNames = (Array.isArray(meta?.setup_env) ? meta.setup_env : [])
    .filter((name) => typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name));
  const credentials = envNames.length === 1 ? envNames : envNames.filter((name) => /(?:_API_KEY|_API_TOKEN|_TOKEN)$/.test(name));
  if (credentials.length === 1) {
    lines.push(`# API key variable listed by models.dev: ${credentials[0]}`, `export API_KEY="\${${credentials[0]}}"`);
  }
  const others = envNames.filter((name) => name !== credentials[0] || credentials.length !== 1);
  if (others.length) lines.push(`# Also required by this provider (models.dev): ${others.join(', ')}`);
  const sdkPackage = meta?.ai_sdk_package;
  if (typeof sdkPackage === 'string' && /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(sdkPackage)) {
    lines.push(`# Vercel AI SDK provider package: ${sdkPackage}`);
  }
  return lines;
}

function setupText(provider) {
  const offering = provider.offering;
  const baseURL = offering.modelsdev?.base_url || offering.base_url || null;
  const modelId = offering.modelsdev?.model_id || offering.id;
  const baseURLForCopy = baseURL || 'https://YOUR_PROVIDER_BASE_URL/v1';
  const comment = [providerName(provider.provider, offering), offering.id]
    .map((value) => String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim())
    .join(' · ');
  const curlPayload = JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'Hello' }] }, null, 2);
  return [
    `# ${comment}`,
    `# ${baseURL ? 'Base URL from models.dev/catalog' : 'Base URL is not published in this catalog; replace this placeholder with the provider endpoint'}`,
    `export BASE_URL=${shellQuote(baseURLForCopy)}`,
    `export MODEL_ID=${shellQuote(modelId)}`,
    ...setupHintLines(provider.provider),
    '',
    '# curl',
    'curl "$BASE_URL/chat/completions" \\',
    '  -H "Authorization: Bearer $API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '${curlPayload.replaceAll("'", "'\\''")}'`,
    '',
    '# Python OpenAI SDK',
    'import os',
    'from openai import OpenAI',
    'client = OpenAI(api_key=os.environ["API_KEY"], base_url=os.environ["BASE_URL"])',
    'response = client.chat.completions.create(',
    '    model=os.environ["MODEL_ID"],',
    '    messages=[{"role": "user", "content": "Hello"}],',
    ')',
    'print(response.choices[0].message.content)',
  ].join('\n');
}

function agentPrompt(candidate, provider) {
  const useCase = USE_CASES[state.useCase];
  const modelId = provider.offering.modelsdev?.model_id || provider.offering.id;
  const scores = candidate.explanation.benchmark.signals.filter((signal) => signal.rawValue !== null)
    .map((signal) => `${signal.field} ${formatNumber(signal.rawValue, 2)} (${sourceName(signal.source)})`).join('; ');
  return `I’m considering ${modelDisplayName(candidate)} (provider model id ${modelId}) on ${providerName(provider.provider, provider.offering)} for ${useCaseLabel(state.useCase)}. TokenWatch’s benchmark-based score is ${formatNumber(candidate.qualityScore)}/100 with ${formatNumber(candidate.qualityCoverage * 100, 0)}% coverage. Available raw signals: ${scores || 'none disclosed'}. The assumed token mix is ${formatMix(useCase.mix)} and the current blended rate is ${formatRate(provider.blendedRate)} per million tokens. Please assess fit for my actual task, identify capability or privacy questions to verify, and compare alternatives rather than treating this snapshot as a guarantee. Check the provider’s current price and retention policy before use.`;
}

function renderActions(candidate) {
  const provider = selectedProvider(candidate);
  if (!candidate || !provider) {
    elements.estimateBill.href = '/';
    elements.compareModel.href = '/';
    elements.copySetup.disabled = true;
    elements.copyPrompt.disabled = true;
    return;
  }
  elements.copySetup.disabled = false;
  elements.copyPrompt.disabled = false;
  elements.estimateBill.href = buildCalculatorHref(candidate.id, USE_CASES[state.useCase].mix);
  elements.compareModel.href = buildCalculatorHref(candidate.id, USE_CASES[state.useCase].mix);
}

function renderPreference() {
  const preference = recommendations?.preference;
  const favorite = preference?.favorite;
  if (!preference || !favorite) {
    elements.preferenceFeature.hidden = true;
    elements.preferenceSummary.replaceChildren();
    elements.preferenceAttribution.replaceChildren();
    return;
  }

  const ratingDate = preference.source?.rating_date;
  const isShowingProviders = providerCandidateOverride?.id === favorite.id;
  elements.preferenceSummary.innerHTML = `<p><strong>People’s favourite:</strong> ${escapeHtml(modelDisplayName(favorite))} <span>(Arena ${escapeHtml(preference.board)}, rating ${formatNumber(favorite.rating, 2)})</span></p>
    <button type="button" class="choose-preference-provider" data-show-preference-providers aria-pressed="${isShowingProviders}">${isShowingProviders ? 'Showing this model’s providers' : 'Show this model’s providers'}</button>`;
  const sourceUrl = preference.source?.url || 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset';
  const licenseUrl = preference.source?.license_url || 'https://creativecommons.org/licenses/by/4.0/';
  const dateText = ratingDate ? `<time datetime="${escapeHtml(ratingDate)}">${escapeHtml(ratingDate)}</time>` : 'date not reported';
  elements.preferenceAttribution.innerHTML = `Preference ratings: <a href="${escapeHtml(sourceUrl)}" rel="noreferrer">LMArena leaderboard (Hugging Face dataset)</a>, <a href="${escapeHtml(licenseUrl)}" rel="license noreferrer">CC BY 4.0</a>, ratings dated ${dateText}.`;
  elements.preferenceFeature.hidden = false;
}

function renderUseCaseNotice() {
  const notes = {
    'chat-assistant': 'Chat picks rank benchmark capability; the Arena Text people’s preference is shown separately above.',
    'creative-writing': 'Creative writing is preference-led: the Arena Creative Writing rating leads, with AA intelligence as a smaller capability signal.',
  };
  const note = notes[state.useCase];
  elements.useCaseNotice.textContent = note || '';
  elements.useCaseNotice.hidden = !note;
}

function render() {
  const candidateByKey = candidatesByPick();
  elements.modelCards.innerHTML = PICK_OPTIONS.map((option) => renderModelCard(candidateByKey[option.key], option)).join('');
  elements.modelCards.setAttribute('aria-busy', 'false');
  renderOtherModels();
  renderPreference();
  const candidate = selectedCandidate();
  renderProviders(candidate);
  renderActions(candidate);
  renderUseCaseNotice();
  elements.chooseStatus.textContent = `Showing ${useCaseLabel(state.useCase)} recommendations. Typical workload (assumed): ${formatMix(USE_CASES[state.useCase].mix)}.`;
}

function calculate() {
  elements.modelCards.setAttribute('aria-busy', 'true');
  elements.providerRows.setAttribute('aria-busy', 'true');
  elements.chooseStatus.textContent = 'Updating recommendations…';
  try {
    recommendations = shortlistModels(state.useCase, catalogs.pricing, {
      benchmarks: catalogs.benchmarks,
      performance: catalogs.performance,
      providersMeta: catalogs.pricing.providers_meta,
      priority: state.priority,
      requireZdr: state.requireZdr,
      excludeHQ: state.excludeHQ,
      includeProprietary: state.includeProprietary,
    });
    let activeOption = PICK_OPTIONS.find((option) => option.key === state.pick);
    if (!activeOption || !recommendations[activeOption.resultKey]) {
      activeOption = PICK_OPTIONS.find((option) => recommendations[option.resultKey]);
      state.pick = activeOption?.key || DEFAULT_CHOOSE_STATE.pick;
    }
    const active = activeOption ? recommendations[activeOption.resultKey] : null;
    if (state.provider && !active?.providers?.some((provider) => provider.provider === state.provider)) state.provider = null;
    syncHash();
    render();
  } catch (error) {
    elements.chooseStatus.textContent = `Recommendations could not be calculated: ${error.message}`;
    elements.modelCards.setAttribute('aria-busy', 'false');
    elements.providerRows.setAttribute('aria-busy', 'false');
  }
}

async function loadCatalogs() {
  const [pricingResponse, benchmarkResponse, performanceResponse] = await Promise.all([
    fetch('/pricing.json'), fetch('/benchmarks.json'), fetch('/performance.json'),
  ]);
  if (![pricingResponse, benchmarkResponse, performanceResponse].every((response) => response.ok)) {
    throw new Error('A catalog snapshot could not be loaded. Refresh the page and try again.');
  }
  const [pricing, benchmarks, performance] = await Promise.all([
    pricingResponse.json(), benchmarkResponse.json(), performanceResponse.json(),
  ]);
  if (!Array.isArray(pricing.models) || !Array.isArray(benchmarks.models)) throw new Error('The model or benchmark catalog is incomplete.');
  catalogs = { pricing, benchmarks, performance };
  renderHeadquartersOptions();
  applyStateToControls();
  calculate();
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const temporary = document.createElement('textarea');
  temporary.value = value;
  temporary.setAttribute('readonly', '');
  temporary.style.position = 'fixed';
  temporary.style.opacity = '0';
  document.body.append(temporary);
  temporary.select();
  const copied = document.execCommand('copy');
  temporary.remove();
  if (!copied) throw new Error('Clipboard access is unavailable in this browser.');
}

async function performCopy(button, makeValue, successMessage) {
  const candidate = selectedCandidate();
  const provider = selectedProvider(candidate);
  if (!candidate || !provider) return;
  button.disabled = true;
  elements.actionStatus.textContent = 'Preparing…';
  try {
    await copyText(makeValue(candidate, provider));
    elements.actionStatus.textContent = successMessage;
  } catch (error) {
    elements.actionStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

document.querySelectorAll('input[name="useCase"], input[name="priority"], #requireZdr, #includeProprietary')
  .forEach((input) => input.addEventListener('change', writeControlState));
elements.hqOptions.addEventListener('change', writeControlState);

elements.modelCards.addEventListener('click', (event) => {
  const button = event.target.closest('[data-pick]');
  if (!button) return;
  state.pick = button.dataset.pick;
  state.provider = null;
  providerCandidateOverride = null;
  syncHash();
  render();
  elements.modelCards.querySelector(`[data-pick="${state.pick}"]`)?.focus();
});

elements.preferenceSummary.addEventListener('click', (event) => {
  const button = event.target.closest('[data-show-preference-providers]');
  if (!button || !recommendations?.preference?.favorite) return;
  providerCandidateOverride = recommendations.preference.favorite;
  state.provider = null;
  render();
  elements.providerHeading.scrollIntoView({
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start',
  });
});

elements.providerRows.addEventListener('click', (event) => {
  const button = event.target.closest('[data-provider]');
  if (!button) return;
  state.provider = button.dataset.provider;
  syncHash();
  renderProviders(selectedCandidate());
  renderActions(selectedCandidate());
  [...elements.providerRows.querySelectorAll('[data-provider]')]
    .find((providerButton) => providerButton.dataset.provider === state.provider)?.focus();
});

elements.copySetup.addEventListener('click', () => performCopy(elements.copySetup, (_, provider) => setupText(provider), 'Setup copied. Replace the API key before making a request.'));
elements.copyPrompt.addEventListener('click', () => performCopy(elements.copyPrompt, (candidate, provider) => agentPrompt(candidate, provider), 'Agent prompt copied.'));
elements.shareLink.addEventListener('click', async () => {
  try {
    await copyText(location.href);
    elements.actionStatus.textContent = 'Share link copied with the current use case, filters, pick, and provider.';
  } catch (error) {
    elements.actionStatus.textContent = error.message;
  }
});

window.addEventListener('hashchange', () => {
  state = parseChooseHash(location.hash);
  providerCandidateOverride = null;
  if (!catalogs) return;
  applyStateToControls();
  calculate();
});

loadCatalogs().catch((error) => {
  elements.chooseStatus.textContent = error.message;
  elements.modelCards.setAttribute('aria-busy', 'false');
  elements.providerRows.setAttribute('aria-busy', 'false');
});
