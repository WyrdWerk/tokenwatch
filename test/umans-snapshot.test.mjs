/**
 * test/umans-snapshot.test.mjs — Tests for extractUmansSnapshot helper.
 *
 * Tests extraction of Umans AI performance data from status.umans.ai SSR HTML.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { extractUmansSnapshot } from '../shared/umans-status.mjs';

// Mock HTML with embedded Umans status data in __next_f format
const MOCK_HTML_WITH_DATA = `
<!DOCTYPE html>
<html>
<head><title>Umans Status</title></head>
<body>
<script>
self.__next_f = [];
self.__next_f.push([1,"initialSnapshot:{\\"models\\":{\\"umans-glm-5.2\\":{\\"latency\\":{\\"ttft_ms\\":{\\"p50\\":2143.44}},\\"output_tokens_per_second\\":{\\"p50\\":72.88}},\\"umans-kimi-k2.7\\":{\\"latency\\":{\\"ttft_ms\\":{\\"p50\\":1640.0}},\\"output_tokens_per_second\\":{\\"p50\\":104.4}},\\"umans-flash\\":{\\"latency\\":{\\"ttft_ms\\":{\\"p50\\":800.0}},\\"output_tokens_per_second\\":{\\"p50\\":250.0}},\\"umans-deepseek-v4-pro-dspark\\":{\\"latency\\":{\\"ttft_ms\\":{\\"p50\\":1500.0}},\\"output_tokens_per_second\\":{\\"p50\\":196.7}}},\\"generated_at\\":\\"2026-07-16T10:50:21Z\\"}"]);
</script>
</body>
</html>
`;

// Mock HTML without initialSnapshot
const MOCK_HTML_NO_SNAPSHOT = `
<!DOCTYPE html>
<html>
<head><title>Umans Status</title></head>
<body>
<p>Status page loaded</p>
</body>
</html>
`;

describe('extractUmansSnapshot', () => {
  it('should extract models and generated_at from valid HTML with initialSnapshot', () => {
    const result = extractUmansSnapshot(MOCK_HTML_WITH_DATA);
    
    assert.ok(result, 'Should return a result');
    assert.ok(result.models, 'Should have models');
    assert.ok(result.generated_at, 'Should have generated_at');
    
    // Check expected models exist
    assert.ok(result.models['umans-glm-5.2'], 'Should have umans-glm-5.2');
    assert.ok(result.models['umans-kimi-k2.7'], 'Should have umans-kimi-k2.7');
    assert.ok(result.models['umans-flash'], 'Should have umans-flash');
    assert.ok(result.models['umans-deepseek-v4-pro-dspark'], 'Should have umans-deepseek-v4-pro-dspark');
  });

  it('should have 4 model entries', () => {
    const result = extractUmansSnapshot(MOCK_HTML_WITH_DATA);
    
    assert.strictEqual(Object.keys(result.models).length, 4, 'Should have exactly 4 models');
  });

  it('should have numeric p50 values for latency and throughput', () => {
    const result = extractUmansSnapshot(MOCK_HTML_WITH_DATA);
    
    for (const [modelId, metrics] of Object.entries(result.models)) {
      const hasLatency = metrics.latency?.ttft_ms?.p50 !== undefined;
      const hasThroughput = metrics.output_tokens_per_second?.p50 !== undefined;
      
      assert.ok(
        hasLatency || hasThroughput,
        `Model ${modelId} should have latency or throughput`
      );
      
      if (hasLatency) {
        assert.strictEqual(
          typeof metrics.latency.ttft_ms.p50,
          'number',
          `Model ${modelId} latency p50 should be numeric`
        );
      }
      if (hasThroughput) {
        assert.strictEqual(
          typeof metrics.output_tokens_per_second.p50,
          'number',
          `Model ${modelId} throughput p50 should be numeric`
        );
      }
    }
  });

  it('should return null for empty HTML', () => {
    const result = extractUmansSnapshot('');
    assert.strictEqual(result, null, 'Should return null for empty string');
  });

  it('should return null for garbage HTML', () => {
    const result = extractUmansSnapshot('<html><body>garbage</body></html>');
    assert.strictEqual(result, null, 'Should return null for garbage HTML');
  });

  it('should return null for HTML without initialSnapshot', () => {
    const result = extractUmansSnapshot(MOCK_HTML_NO_SNAPSHOT);
    assert.strictEqual(result, null, 'Should return null for HTML without snapshot');
  });

  it('should return null for non-string input', () => {
    assert.strictEqual(extractUmansSnapshot(null), null);
    assert.strictEqual(extractUmansSnapshot(undefined), null);
    assert.strictEqual(extractUmansSnapshot(123), null);
    assert.strictEqual(extractUmansSnapshot({}), null);
  });

  it('should validate model data structure', () => {
    const result = extractUmansSnapshot(MOCK_HTML_WITH_DATA);
    
    for (const [modelId, metrics] of Object.entries(result.models)) {
      // Either latency or throughput must be present
      const hasLatency = metrics.latency !== null;
      const hasThroughput = metrics.throughput !== null;
      
      assert.ok(
        hasLatency || hasThroughput,
        `Model ${modelId} should have latency or throughput data`
      );
    }
  });
});
