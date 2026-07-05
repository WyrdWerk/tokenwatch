(function () {
  'use strict';

  // Determine API base URL from script src or fallback to relative
  var scriptSrc = (document.currentScript && document.currentScript.src) || '';
  // Fallback: find the last loaded script tag pointing to embed.js
  if (!scriptSrc) {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      var s = scripts[i];
      if (s.src && /\/widget\/embed\.js/.test(s.src)) { scriptSrc = s.src; break; }
    }
  }
  var baseUrl = scriptSrc ? scriptSrc.replace(/\/widget\/embed\.js.*$/, '') : '';
  // Allow explicit override via data attribute on any widget element
  if (!baseUrl) {
    var probe = document.querySelector('[data-tw-base]');
    if (probe) baseUrl = probe.getAttribute('data-tw-base').replace(/\/$/, '');
  }
  var API_BASE = baseUrl + '/api/v1/models';

  var DEFAULTS = {
    tokens: 1000,
    mix: '2.5,97,0.5',
    theme: 'auto',
  };

  function getTheme(attr) {
    if (attr === 'dark') return 'dark';
    if (attr === 'light') return 'light';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function fmtPrice(p) {
    if (p === null || p === undefined) return '—';
    if (p === 0) return 'Free';
    if (p < 0.01) return '$' + p.toFixed(4);
    return '$' + p.toFixed(2);
  }

  function fmtCost(c) {
    if (c === null || c === undefined) return 'N/A';
    if (c === 0) return '$0.00';
    if (c < 1) return '$' + c.toFixed(4);
    return '$' + c.toFixed(2);
  }

  function computeCost(pricing, totalTokens, mix, cacheWriteTokens, amortizeN) {
    var parts = mix.split(',').map(parseFloat);
    var inputPct = parts[0] || 0, cachePct = parts[1] || 0, outputPct = parts[2] || 0;
    var sum = inputPct + cachePct + outputPct;
    if (sum > 0 && Math.abs(sum - 100) > 1) {
      inputPct = inputPct / sum * 100;
      cachePct = cachePct / sum * 100;
      outputPct = outputPct / sum * 100;
    }
    var total = totalTokens * 1e6;
    var inputTokens = total * inputPct / 100;
    var cacheTokens = total * cachePct / 100;
    var outputTokens = total * outputPct / 100;

    var cost = 0;
    var valid = true;

    if (inputTokens > 0) {
      if (pricing.input === null || pricing.input === undefined) { valid = false; }
      else cost += (pricing.input * inputTokens) / 1e6;
    }
    if (cacheTokens > 0) {
      if (pricing.cache_read === null || pricing.cache_read === undefined) { valid = false; }
      else cost += (pricing.cache_read * cacheTokens) / 1e6;
    }
    if (outputTokens > 0) {
      if (pricing.output === null || pricing.output === undefined) { valid = false; }
      else cost += (pricing.output * outputTokens) / 1e6;
    }
    if (cacheWriteTokens > 0 && pricing.cache_write != null) {
      cost += (pricing.cache_write * cacheWriteTokens * 1e6) / 1e6 / (amortizeN || 1);
    }

    return valid ? cost : null;
  }

  var STYLES = {
    dark: {
      bg: '#1a1612', surface: '#242020', border: '#3a3530',
      text: '#e4e0d8', dim: '#9a9088', accent: '#1E6E8E', green: '#4a9d6f',
    },
    light: {
      bg: '#F8F5F0', surface: '#FFFFFF', border: '#E0D6CA',
      text: '#0D1725', dim: '#486680', accent: '#1E6E8E', green: '#2d8a5a',
    },
  };

  function renderWidget(target, data, tokens, mix) {
    var model = target.getAttribute('data-tw-model');
    if (tokens === undefined) tokens = parseFloat(target.getAttribute('data-tw-tokens')) || DEFAULTS.tokens;
    if (mix === undefined) mix = target.getAttribute('data-tw-mix') || DEFAULTS.mix;
    var cacheWrite = parseFloat(target.getAttribute('data-tw-cache-write')) || 0;
    var amortizeN = parseInt(target.getAttribute('data-tw-amortize'), 10) || 1;
    var theme = getTheme(target.getAttribute('data-tw-theme'));
    var c = STYLES[theme];

    var shadow = target.shadowRoot || target.attachShadow({ mode: 'open' });

    if (!data || data.error) {
      shadow.innerHTML = '<style>' + getCss(c) + '</style><div class="tw-card tw-error">' + (data && data.error ? esc(data.error) : 'Failed to load') + '</div>';
      return;
    }

    var providers = data.providers || [];
    if (providers.length === 0) {
      shadow.innerHTML = '<style>' + getCss(c) + '</style><div class="tw-card tw-error">No providers found for ' + esc(model) + '</div>';
      return;
    }

    var cheapest = providers[0]; // API returns sorted by cost
    var cost = computeCost(cheapest.pricing, tokens, mix, cacheWrite, amortizeN);
    var promo = cheapest.discount > 0 ? ' <span class="tw-promo">' + (cheapest.discount * 100).toFixed(0) + '% off</span>' : '';

    var html = '<style>' + getCss(c) + '</style>' +
      '<div class="tw-card">' +
        '<div class="tw-header">' +
          '<span class="tw-model">' + esc(model) + '</span>' +
          '<span class="tw-providers">' + providers.length + ' provider' + (providers.length === 1 ? '' : 's') + '</span>' +
        '</div>' +
        '<div class="tw-cheapest">' +
          '<span class="tw-provider-name">' + esc(cheapest.provider_display || cheapest.provider) + '</span>' + promo +
        '</div>' +
        '<div class="tw-prices">' +
          '<div class="tw-price-row"><span>Input</span><span>' + fmtPrice(cheapest.pricing.input) + '/M</span></div>' +
          '<div class="tw-price-row"><span>Output</span><span>' + fmtPrice(cheapest.pricing.output) + '/M</span></div>' +
          '<div class="tw-price-row"><span>Cache Read</span><span>' + fmtPrice(cheapest.pricing.cache_read) + '/M</span></div>' +
          '<div class="tw-price-row"><span>Cache Write</span><span>' + fmtPrice(cheapest.pricing.cache_write) + '/M</span></div>' +
        '</div>' +
        '<div class="tw-total">' +
          '<span>Cost for ' + tokens + 'M tokens</span>' +
          '<span class="tw-cost">' + fmtCost(cost) + '</span>' +
        '</div>' +
        '<a class="tw-powered" href="' + esc(baseUrl) + '/#model=' + encodeURIComponent(model) + '" target="_blank" rel="noopener">Powered by TokenWatch</a>' +
      '</div>';

    shadow.innerHTML = html;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getCss(c) {
    return '.tw-card{background:' + c.bg + ';border:1px solid ' + c.border + ';border-radius:8px;padding:1rem;max-width:320px;font-family:\'Space Grotesk\',system-ui,sans-serif;color:' + c.text + ';font-size:0.85rem;line-height:1.5}' +
      '.tw-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem}' +
      '.tw-model{font-weight:600;font-size:0.95rem}' +
      '.tw-providers{color:' + c.dim + ';font-size:0.75rem}' +
      '.tw-cheapest{margin-bottom:0.6rem}' +
      '.tw-provider-name{font-weight:500;color:' + c.accent + '}' +
      '.tw-promo{background:' + c.surface + ';color:' + c.dim + ';padding:0.1rem 0.4rem;border-radius:4px;font-size:0.7rem;margin-left:0.3rem}' +
      '.tw-prices{border-top:1px solid ' + c.border + ';padding-top:0.5rem;margin-bottom:0.5rem}' +
      '.tw-price-row{display:flex;justify-content:space-between;padding:0.15rem 0}' +
      '.tw-price-row span:first-child{color:' + c.dim + '}' +
      '.tw-total{display:flex;justify-content:space-between;align-items:center;border-top:1px solid ' + c.border + ';padding-top:0.5rem;font-weight:600}' +
      '.tw-cost{color:' + c.green + ';font-size:1.05rem}' +
      '.tw-powered{display:block;text-align:right;margin-top:0.5rem;font-size:0.7rem;color:' + c.dim + ';text-decoration:none}' +
      '.tw-powered:hover{text-decoration:underline}' +
      '.tw-error{color:' + c.dim + ';text-align:center;padding:1.5rem}' ;
  }

  async function fetchAndRender(target) {
    var model = target.getAttribute('data-tw-model');
    if (!model) return;
    var tokens = parseFloat(target.getAttribute('data-tw-tokens')) || DEFAULTS.tokens;
    var mix = target.getAttribute('data-tw-mix') || DEFAULTS.mix;

    var url = API_BASE + '/' + model.split('/').map(encodeURIComponent).join('/') + '/providers?tokens=' + encodeURIComponent(tokens) + '&mix=' + encodeURIComponent(mix);
    try {
      var res = await fetch(url);
      if (!res.ok) {
        renderWidget(target, { error: 'API error: ' + res.status + ' ' + res.statusText }, tokens, mix);
        return;
      }
      var data = await res.json();
      renderWidget(target, data, tokens, mix);
    } catch (err) {
      renderWidget(target, { error: 'Failed to fetch: ' + err.message }, tokens, mix);
    }
  }

  // Auto-detect and render on DOMContentLoaded
  function init() {
    var targets = document.querySelectorAll('[data-tw-model]');
    for (var i = 0; i < targets.length; i++) {
      fetchAndRender(targets[i]);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for manual usage
  window.TokenWatchWidget = {
    render: fetchAndRender,
    renderAll: init,
  };
})();
