import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CHOOSE_STATE,
  buildCalculatorHref,
  isCloseCall,
  isStale,
  parseChooseHash,
  serializeChooseState,
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

test('calculator links carry the selected model and exact workload mix in the existing hash format', () => {
  const href = buildCalculatorHref('glm-5.3-flash', { inputPct: 35, cacheReadPct: 10, outputPct: 55 });
  const params = new URLSearchParams(href.slice(2));
  assert.match(href, /^\/#/);
  assert.equal(params.get('model'), 'glm-5.3-flash');
  assert.equal(params.get('mix'), '35,10,55');
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
