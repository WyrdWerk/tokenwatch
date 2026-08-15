import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainKey, arenaKey, buildArenaIndex } from '../scripts/fetch-arena.mjs';

test('plainKey lowercases and strips punctuation, keeps effort suffix', () => {
  assert.equal(plainKey('claude-opus-4-6-high'), 'claudeopus46high');
  assert.equal(plainKey('Qwen3.8-Max'), 'qwen38max');
});

test('plainKey drops parenthetical qualifiers', () => {
  assert.equal(plainKey('muse-spark-1.2 (xHigh)'), 'musespark12');
});

test('arenaKey strips one trailing effort qualifier', () => {
  assert.equal(arenaKey('claude-opus-4-6-high'), 'claudeopus46');
  assert.equal(arenaKey('claude-opus-5-max'), 'claudeopus5');
  assert.equal(arenaKey('gemini-3.1-pro-preview'), 'gemini31pro');
});

test('buildArenaIndex: base entry beats effort variant on collision', () => {
  const models = [
    { model: 'claude-opus-4-6-high', score: 1505, votes: 72516 },
    { model: 'claude-opus-4-6', score: 1497, votes: 76474 },
  ];
  const idx = buildArenaIndex(models);
  // Family key collapses both; the base (non-variant) wins.
  assert.equal(idx.get('claudeopus46').arena_elo, 1497);
  // The variant is still reachable through its own plainKey.
  assert.equal(idx.get('claudeopus46high').arena_elo, 1505);
});

test('buildArenaIndex: two effort variants → higher Elo wins', () => {
  const models = [
    { model: 'claude-opus-5-max', score: 1489, votes: 9679 },
    { model: 'claude-opus-5-high', score: 1493, votes: 20030 },
  ];
  const idx = buildArenaIndex(models);
  assert.equal(idx.get('claudeopus5').arena_elo, 1493);
});

test('buildArenaIndex: genuine name token "max" stays reachable via plainKey', () => {
  // qwen3.8-max — "max" is part of the model name, not an effort suffix.
  const models = [ { model: 'qwen3.8-max', score: 1491, votes: 7004 } ];
  const idx = buildArenaIndex(models);
  assert.equal(idx.get('qwen38max').arena_elo, 1491);
});

test('buildArenaIndex: skips records without a numeric score', () => {
  const idx = buildArenaIndex([{ model: 'foo', score: null, votes: 1 }]);
  assert.equal(idx.size, 0);
});