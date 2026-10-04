import { USE_CASES, PRIORITY_PROVIDER_WEIGHTS } from './use-cases.mjs';

const PRIORITIES = new Set(Object.keys(PRIORITY_PROVIDER_WEIGHTS));
const PICKS = new Set(['quality', 'value', 'cheapest']);
const HOUR = 60 * 60 * 1000;

// Visitor-facing use-case wording shared by the /choose/ cards, its status
// line, and the homepage finder strip. Ids match USE_CASES in use-cases.mjs.
export const USE_CASE_CHOICES = Object.freeze([
  { id: 'agentic-coding', label: 'Coding agent', blurb: 'Write, edit, and debug code with tools.' },
  { id: 'tool-agents', label: 'Tool-using agent', blurb: 'Call tools and complete multi-step tasks.' },
  { id: 'long-context-rag', label: 'Chat over my documents', blurb: 'Find and synthesize long-context information.' },
  { id: 'structured-extraction', label: 'Extract data to JSON', blurb: 'Turn unstructured text into structured output.' },
  { id: 'high-volume-cheap', label: 'Cheap bulk processing', blurb: 'Run lots of requests at a controlled cost.' },
  { id: 'chat-assistant', label: 'Chatbot', blurb: 'Answer questions in an interactive conversation.' },
  { id: 'creative-writing', label: 'Creative writing', blurb: 'Draft and revise expressive long-form text.' },
  { id: 'reasoning-math', label: 'Reasoning / math', blurb: 'Work through multi-step questions and calculations.' },
  { id: 'frontend-ui', label: 'Websites / UI', blurb: 'Build and refine front-end experiences.' },
].map((choice) => Object.freeze(choice)));

export function useCaseLabel(id) {
  return USE_CASE_CHOICES.find((choice) => choice.id === id)?.label ?? id;
}

const ID_ACRONYMS = new Set(['glm', 'gpt', 'oss', 'qwq', 'ai', 'ui', 'vl', 'moe', 'llm', 'r1', 'tts']);

/** Readable name from a canonical or provider model id: `zai-org/GLM-5.3` → `GLM 5.3`, `gpt-oss-120b` → `GPT OSS 120B`. */
export function prettifyModelId(id) {
  const tail = String(id ?? '').split('/').pop().replace(/:[a-z]+$/i, '');
  if (!tail) return '';
  const keepCase = /[A-Z]/.test(tail);
  return tail.split(/[-_\s]+/).filter(Boolean).map((token) => {
    if (keepCase) return token;
    const lower = token.toLowerCase();
    if (ID_ACRONYMS.has(lower) || /^\d+(\.\d+)?[bkmt]?$/.test(lower) || /^[a-z]\d+(\.\d+)?[a-z]?$/.test(lower)) return token.toUpperCase();
    return lower[0].toUpperCase() + lower.slice(1);
  }).join(' ');
}

/**
 * Display name for a recommendation candidate. Prefers a catalog name of the
 * form "Org: Name" (from the group or any of its offerings) with the org
 * prefix stripped, then any non-id catalog name, then a prettified id.
 */
export function modelDisplayName(candidate = {}) {
  const id = String(candidate.id ?? '');
  const names = [
    candidate.name,
    candidate.offering?.name,
    ...(candidate.providers || []).map((provider) => provider?.offering?.name),
    ...(candidate.unverifiedProviders || []).map((provider) => provider?.offering?.name),
  ].filter((name) => typeof name === 'string' && name.trim());
  const prefixed = names.find((name) => /^[^/:]+: \S/.test(name));
  if (prefixed) return prefixed.slice(prefixed.indexOf(': ') + 2).trim();
  const plain = names.find((name) => !name.includes('/') && name.toLowerCase() !== id.toLowerCase());
  if (plain) return plain.trim();
  const rawId = names.find((name) => name.includes('/'));
  return prettifyModelId(rawId || id) || id;
}

export const FEATURED_PROVIDER_COUNT = 3;
export const PRIORITY_ROLE_LABELS = Object.freeze({ cheapest: 'Cheapest', fastest: 'Fastest', 'most-reliable': 'Most reliable' });

function providerKey(provider) {
  return `${provider.provider}|${provider.offering?.id || ''}`;
}

/**
 * Which ranked providers to show expanded. Normally the top three; on a close
 * call, the cheapest / fastest / most-reliable winners (`alternatives`, keyed by
 * priority) topped up from the ranking. A selected provider always stays
 * expanded. Returns the featured rows in display order and their role labels.
 */
export function pickFeaturedProviders(providers = [], alternatives = null, selectedProvider = null, count = FEATURED_PROVIDER_COUNT) {
  const featured = [];
  const roles = new Map();
  const add = (provider) => { if (provider && !featured.includes(provider)) featured.push(provider); };
  for (const [priority, pick] of Object.entries(alternatives || {})) {
    if (!pick) continue;
    const match = providers.find((provider) => providerKey(provider) === providerKey(pick));
    if (!match) continue;
    add(match);
    roles.set(match, [...(roles.get(match) || []), PRIORITY_ROLE_LABELS[priority] || priority]);
  }
  for (const provider of providers) {
    if (featured.length >= count) break;
    add(provider);
  }
  if (selectedProvider) add(providers.find((provider) => provider.provider === selectedProvider));
  return { featured, roles };
}

export const DEFAULT_CHOOSE_STATE = Object.freeze({
  useCase: 'agentic-coding',
  priority: 'balanced',
  requireZdr: false,
  excludeHQ: Object.freeze([]),
  includeProprietary: false,
  pick: 'quality',
  provider: null,
});

function validProvider(value) {
  return typeof value === 'string' && /^[a-z0-9_-]{1,80}$/i.test(value) ? value : null;
}

function normalizeState(state = {}) {
  return {
    useCase: Object.hasOwn(USE_CASES, state.useCase) ? state.useCase : DEFAULT_CHOOSE_STATE.useCase,
    priority: PRIORITIES.has(state.priority) ? state.priority : DEFAULT_CHOOSE_STATE.priority,
    requireZdr: state.requireZdr === true,
    excludeHQ: [...new Set((Array.isArray(state.excludeHQ) ? state.excludeHQ : [])
      .filter((country) => typeof country === 'string' && /^[A-Z]{2}$/.test(country)))]
      .sort(),
    includeProprietary: state.includeProprietary === true,
    pick: PICKS.has(state.pick) ? state.pick : DEFAULT_CHOOSE_STATE.pick,
    provider: validProvider(state.provider),
  };
}

export function parseChooseHash(hash = '') {
  const params = new URLSearchParams(String(hash).replace(/^#/, ''));
  const excludeHQ = (params.get('excludeHQ') || '').split(',').filter(Boolean);
  return normalizeState({
    useCase: params.get('useCase'),
    priority: params.get('priority'),
    requireZdr: params.get('zdr') === '1',
    excludeHQ,
    includeProprietary: params.get('proprietary') === '1',
    pick: params.get('pick'),
    provider: params.get('provider'),
  });
}

/**
 * Initial page state from the URL. The hash is the page's own state; a
 * `?useCase=` query (the homepage finder's no-JS GET form) applies only when
 * the hash does not name a use case.
 */
export function parseChooseLocation(search = '', hash = '') {
  const state = parseChooseHash(hash);
  const hashParams = new URLSearchParams(String(hash).replace(/^#/, ''));
  const query = new URLSearchParams(String(search).replace(/^\?/, ''));
  if (!hashParams.has('useCase') && query.has('useCase')) {
    return normalizeState({ ...state, useCase: query.get('useCase') });
  }
  return state;
}

/** Query string without the one-shot `useCase` entry point, so the hash owns state afterwards. */
export function stripUseCaseQuery(search = '') {
  const query = new URLSearchParams(String(search).replace(/^\?/, ''));
  query.delete('useCase');
  const rest = query.toString();
  return rest ? `?${rest}` : '';
}

export function serializeChooseState(state) {
  const normalized = normalizeState(state);
  const params = new URLSearchParams();
  if (normalized.useCase !== DEFAULT_CHOOSE_STATE.useCase) params.set('useCase', normalized.useCase);
  if (normalized.priority !== DEFAULT_CHOOSE_STATE.priority) params.set('priority', normalized.priority);
  if (normalized.requireZdr) params.set('zdr', '1');
  if (normalized.excludeHQ.length) params.set('excludeHQ', normalized.excludeHQ.join(','));
  if (normalized.includeProprietary) params.set('proprietary', '1');
  if (normalized.pick !== DEFAULT_CHOOSE_STATE.pick) params.set('pick', normalized.pick);
  if (normalized.provider) params.set('provider', normalized.provider);
  const query = params.toString();
  return query ? `#${query}` : '';
}

export function buildCalculatorHref(modelId, mix) {
  const params = new URLSearchParams();
  params.set('model', String(modelId));
  params.set('mix', `${mix.inputPct},${mix.cacheReadPct},${mix.outputPct}`);
  return `/#${params.toString()}`;
}

/** Quote untrusted catalog text as one POSIX-shell word. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function isCloseCall(confidence) {
  return confidence?.level === 'close_call';
}

export function isStale(generatedAt, now = Date.now(), maxAgeHours = 6) {
  const timestamp = Date.parse(generatedAt);
  if (!Number.isFinite(timestamp) || !Number.isFinite(now) || !Number.isFinite(maxAgeHours) || maxAgeHours < 0) return false;
  return now - timestamp > maxAgeHours * HOUR;
}
