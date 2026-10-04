import { USE_CASES, PRIORITY_PROVIDER_WEIGHTS } from './use-cases.mjs';

const PRIORITIES = new Set(Object.keys(PRIORITY_PROVIDER_WEIGHTS));
const PICKS = new Set(['quality', 'value', 'cheapest']);
const HOUR = 60 * 60 * 1000;

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

export function isCloseCall(confidence) {
  return confidence?.level === 'close_call';
}

export function isStale(generatedAt, now = Date.now(), maxAgeHours = 6) {
  const timestamp = Date.parse(generatedAt);
  if (!Number.isFinite(timestamp) || !Number.isFinite(now) || !Number.isFinite(maxAgeHours) || maxAgeHours < 0) return false;
  return now - timestamp > maxAgeHours * HOUR;
}
