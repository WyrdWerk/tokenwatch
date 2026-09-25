/**
 * public/model-history.js — wires the price-history sparkline into a model
 * experience surface.
 *
 * This is the PR 2 "model page/model experience" attachment point. It is
 * deliberately independent of any specific model-page implementation:
 *
 *   1. Declarative: mark up a container with
 *        <div class="price-history" data-price-history="glm-5.2">
 *          <h2>Daily price history</h2>
 *          <div data-price-history-chart></div>
 *        </div>
 *      and this script finds it, fetches /api/v1/models/<id>/history, and
 *      renders into it.
 *   2. Imperative: call `window.ModelHistory.mount(container, canonicalId, opts)`.
 *
 * The mix follows the visitor's saved calculator mix (localStorage 'tw-mix'),
 * so the chart matches the numbers shown everywhere else on the page. That is
 * the whole point of storing raw snapshots: the same rows serve every mix.
 *
 * States are rendered explicitly and never faked — a failed request shows the
 * error state, and a model with no snapshots yet shows the empty state instead
 * of a zero-valued line.
 */
(function (global) {
  'use strict';

  var DEFAULT_DAYS = 90;
  var DEFAULT_MIX = [2.5, 97, 0.5];

  /**
   * Read the visitor's saved workload mix.
   *
   * The calculator (`public/app.js`) persists this as raw CSV — it literally
   * writes `${inputPct},${cacheReadPct},${outputPct}`, e.g. `10,0,90`. That CSV
   * form is the real contract and must be parsed as such. JSON array and object
   * forms are also accepted for robustness (older builds, hand-set values, and
   * any future writer), but the CSV path is the one that matters in production.
   *
   * Anything unusable falls back to the agentic default rather than producing a
   * request the API would reject with a 400.
   */
  function readMix() {
    try {
      var raw = global.localStorage && global.localStorage.getItem('tw-mix');
      if (!raw) return DEFAULT_MIX.slice();
      return normalizeMix(String(raw)) || DEFAULT_MIX.slice();
    } catch (err) {
      return DEFAULT_MIX.slice();
    }
  }

  /**
   * Parse a stored mix into `[inputPct, cacheReadPct, outputPct]`, or null when
   * the value is not a usable mix.
   */
  function normalizeMix(raw) {
    var text = String(raw).trim();
    if (!text) return null;

    var values = null;
    if (text.charAt(0) === '[' || text.charAt(0) === '{') {
      // JSON array or {inputPct, cacheReadPct, outputPct} object.
      var parsed;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return null;
      }
      if (Array.isArray(parsed)) values = parsed;
      else if (parsed && typeof parsed === 'object') values = [parsed.inputPct, parsed.cacheReadPct, parsed.outputPct];
    } else {
      // The production contract: 'input,cacheRead,output'.
      values = text.split(',');
    }
    if (!values || values.length !== 3) return null;

    var nums = values.map(function (value) { return Number(String(value).trim()); });
    if (nums.some(function (n) { return !isFinite(n) || n < 0; })) return null;
    var total = nums[0] + nums[1] + nums[2];
    if (Math.abs(total - 100) > 0.5) return null;
    return nums;
  }

  function historyUrl(canonicalId, days, mix) {
    return '/api/v1/models/' + encodeURIComponent(canonicalId)
      + '/history?days=' + encodeURIComponent(days)
      + '&mix=' + mix.join(',');
  }

  function createModelHistory(chart, canonicalId, options) {
    var opts = options || {};
    var spark = global.PriceSparkline.createPriceSparkline(chart);
    var note = opts.note || null;
    var mix = opts.mix || readMix();
    var days = opts.days || DEFAULT_DAYS;
    var controller = null;

    function setNote(text) {
      if (!note) return;
      note.textContent = text;
    }

    function describeMix() {
      return mix[0] + '% input · ' + mix[1] + '% cached · ' + mix[2] + '% output';
    }

    async function load() {
      if (controller) controller.abort();
      controller = typeof AbortController !== 'undefined' ? new AbortController() : null;

      spark.render({ state: 'loading' });
      setNote('Blended at your workload mix (' + describeMix() + ').');

      var response;
      try {
        response = await fetch(historyUrl(canonicalId, days, mix), {
          signal: controller ? controller.signal : undefined,
          headers: { Accept: 'application/json' },
        });
      } catch (err) {
        if (err && err.name === 'AbortError') return null;
        spark.render({ state: 'error', message: 'Could not reach the history API.' });
        setNote('History could not be loaded. The rest of this page is unaffected.');
        return null;
      }

      if (!response.ok) {
        var detail = 'The history API returned HTTP ' + response.status + '.';
        if (response.status === 503) {
          detail = 'Price history is not enabled in this environment yet.';
        } else if (response.status === 404) {
          detail = 'This model is not in the current catalog.';
        }
        spark.render({ state: 'error', message: detail });
        setNote('History is unavailable for this model right now.');
        return null;
      }

      var body;
      try {
        body = await response.json();
      } catch (err) {
        spark.render({ state: 'error', message: 'The history response was not valid JSON.' });
        return null;
      }

      var points = Array.isArray(body.points) ? body.points : [];
      if (!points.length) {
        spark.render({ state: 'empty' });
        setNote('No snapshots recorded yet — history starts with the first daily refresh.');
        return body;
      }

      spark.render({ state: 'ready', points: points });
      var switches = typeof body.provider_switches === 'number' ? body.provider_switches : 0;
      setNote(
        'Cheapest provider per day at your workload mix (' + describeMix() + '). '
        + points.length + ' day' + (points.length === 1 ? '' : 's') + ' recorded'
        + (switches ? ', ' + switches + ' provider switch' + (switches === 1 ? '' : 'es') : '')
        + '. Gaps are days with no snapshot.',
      );
      return body;
    }

    return { load: load, spark: spark, mix: mix, days: days };
  }

  /** Mount every [data-price-history] container found in `root`. */
  function mountAll(root, options) {
    var scope = root || global.document;
    if (!scope || !scope.querySelectorAll) return [];
    var mounted = [];
    scope.querySelectorAll('[data-price-history]').forEach(function (wrapper) {
      var canonicalId = wrapper.getAttribute('data-price-history');
      if (!canonicalId) return;
      var chart = wrapper.querySelector('[data-price-history-chart]') || wrapper;
      var note = wrapper.querySelector('[data-price-history-note]');
      var instance = createModelHistory(chart, canonicalId, Object.assign({}, options, { note: note }));
      mounted.push(instance);
      instance.load();
    });
    return mounted;
  }

  var api = {
    createModelHistory: createModelHistory,
    mountAll: mountAll,
    historyUrl: historyUrl,
    readMix: readMix,
    DEFAULT_MIX: DEFAULT_MIX,
    DEFAULT_DAYS: DEFAULT_DAYS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.ModelHistory = api;

  if (global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', function () { mountAll(); });
    } else {
      mountAll();
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);