/**
 * public/price-sparkline.js — dependency-free SVG price-history sparkline.
 *
 * Renders one series of daily blended $/M values. No framework, no charting
 * library, no build step — the same constraint the rest of public/ follows.
 *
 * Usage:
 *   const spark = createPriceSparkline(document.querySelector('#history'));
 *   spark.render({ state: 'loading' });
 *   spark.render({ state: 'ready', points, mix, providerSwitches });
 *
 * States are explicit because each one is a real situation the history API can
 * produce, and each must be visually distinguishable:
 *
 *   loading      — request in flight
 *   empty        — the API returned zero points (history starts at first snapshot)
 *   error        — the request failed or the binding is missing
 *   single       — one point; a line needs two, so draw a labelled dot
 *   flat         — every point has the same value; a normalised line would sit
 *                  on the axis and read as "broken", so it is drawn centred
 *   provider-switch — the cheapest provider changed between days; mark the days
 *                  it changed, since that is the thing the chart exists to show
 *
 * The component never fabricates data: a gap between days is a real gap in the
 * series, and an empty result renders the empty state rather than a zero line.
 */
(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var VIEW_W = 640;
  var VIEW_H = 120;
  var PAD = { top: 14, right: 12, bottom: 18, left: 46 };

  var COLORS = {
    line: 'var(--tw-spark-line, #2563eb)',
    switch: 'var(--tw-spark-switch, #d97706)',
    dot: 'var(--tw-spark-dot, #2563eb)',
  };

  function el(name, attrs) {
    var node = document.createElementNS(NS, name);
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key)) node.setAttribute(key, attrs[key]);
    }
    return node;
  }

  /** Format a $/M rate compactly: $0.284, $1.25, $12.00. */
  function fmtRate(value) {
    if (value === null || value === undefined || !isFinite(value)) return '—';
    if (value === 0) return '$0';
    if (value < 0.01) return '$' + value.toFixed(4);
    if (value < 1) return '$' + value.toFixed(3);
    return '$' + value.toFixed(2);
  }

  function fmtDay(day) {
    // '2026-09-14' → 'Sep 14'
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var parts = String(day).split('-');
    if (parts.length !== 3) return String(day);
    var month = months[Number(parts[1]) - 1];
    return month ? month + ' ' + Number(parts[2]) : String(day);
  }

  /**
   * Map the series into SVG coordinates.
   *
   * `flat` is detected here rather than in the renderer so the test can assert
   * the mapping directly: a flat series is centred in the plot area instead of
   * being pinned to the top or bottom edge.
   */
  function projectPoints(points) {
    var values = points.map(function (p) { return p.blended; });
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var flat = min === max;
    var plotW = VIEW_W - PAD.left - PAD.right;
    var plotH = VIEW_H - PAD.top - PAD.bottom;
    var midY = PAD.top + plotH / 2;

    return points.map(function (point, index) {
      var x = points.length === 1
        ? PAD.left + plotW / 2
        : PAD.left + (plotW * index) / (points.length - 1);
      var y = flat ? midY : PAD.top + plotH * (1 - (point.blended - min) / (max - min));
      return { x: x, y: y, point: point, index: index };
    }).map(function (projected) {
      projected.flat = flat;
      projected.min = min;
      projected.max = max;
      return projected;
    });
  }

  /** Days where the cheapest provider differs from the previous day. */
  function switchIndexes(points) {
    var indexes = [];
    for (var i = 1; i < points.length; i++) {
      if (points[i].provider !== points[i - 1].provider) indexes.push(i);
    }
    return indexes;
  }

  function createPriceSparkline(container) {
    if (!container) throw new Error('createPriceSparkline: container is required');

    container.classList.add('tw-spark');
    container.setAttribute('role', 'img');

    function clear() {
      while (container.firstChild) container.removeChild(container.firstChild);
      container.removeAttribute('data-state');
    }

    function message(state, text, detail) {
      clear();
      container.setAttribute('data-state', state);
      var box = document.createElement('div');
      box.className = 'tw-spark-message';
      box.textContent = text;
      if (detail) {
        var sub = document.createElement('span');
        sub.className = 'tw-spark-detail';
        sub.textContent = detail;
        box.appendChild(sub);
      }
      container.appendChild(box);
      container.setAttribute('aria-label', text + (detail ? ' ' + detail : ''));
      return container;
    }

    function render(options) {
      var opts = options || {};
      var state = opts.state || 'ready';
      var points = Array.isArray(opts.points) ? opts.points : [];

      if (state === 'loading') return message('loading', 'Loading price history…');
      if (state === 'error') {
        return message('error', 'Price history unavailable', opts.message || 'The history service did not respond.');
      }
      if (state === 'empty' || points.length === 0) {
        return message('empty', 'No price history yet', 'Snapshots begin with the first daily refresh.');
      }
      if (points.length === 1) return renderSingle(points[0], opts);

      return renderSeries(points, opts);
    }

    function renderSingle(point, opts) {
      clear();
      container.setAttribute('data-state', 'single');
      var svg = el('svg', {
        viewBox: '0 0 ' + VIEW_W + ' ' + VIEW_H,
        preserveAspectRatio: 'none',
        class: 'tw-spark-svg',
        'aria-hidden': 'true',
        focusable: 'false',
      });
      var plotH = VIEW_H - PAD.top - PAD.bottom;
      var cx = PAD.left + (VIEW_W - PAD.left - PAD.right) / 2;
      var cy = PAD.top + plotH / 2;

      // A baseline makes a lone point read as "one day so far", not a broken axis.
      svg.appendChild(el('line', {
        x1: PAD.left, y1: cy, x2: VIEW_W - PAD.right, y2: cy,
        stroke: 'currentColor', 'stroke-opacity': '0.18', 'stroke-dasharray': '3 4',
      }));
      svg.appendChild(el('circle', { cx: cx, cy: cy, r: 5, fill: COLORS.dot }));
      svg.appendChild(text(cx + 10, cy + 4, fmtRate(point.blended)));
      container.appendChild(svg);

      container.appendChild(caption([
        fmtDay(point.day),
        fmtRate(point.blended),
        point.provider,
        '1 day recorded',
      ].join(' · ')));
      container.setAttribute('aria-label',
        'Price history: one day recorded, ' + fmtRate(point.blended) + ' per million tokens on ' + fmtDay(point.day)
        + ' via ' + point.provider + '.');
      return container;
    }

    function renderSeries(points, opts) {
      clear();
      var switches = switchIndexes(points);
      container.setAttribute('data-state', switches.length ? 'provider-switch' : (projectFlat(points) ? 'flat' : 'ready'));

      var projected = projectPoints(points);
      var flat = projected[0].flat;
      var min = projected[0].min;
      var max = projected[0].max;

      var svg = el('svg', {
        viewBox: '0 0 ' + VIEW_W + ' ' + VIEW_H,
        preserveAspectRatio: 'none',
        class: 'tw-spark-svg',
        'aria-hidden': 'true',
        focusable: 'false',
      });

      // Horizontal gridlines at the series extremes.
      var plotH = VIEW_H - PAD.top - PAD.bottom;
      [PAD.top, PAD.top + plotH].forEach(function (y) {
        svg.appendChild(el('line', {
          x1: PAD.left, y1: y, x2: VIEW_W - PAD.right, y2: y,
          stroke: 'currentColor', 'stroke-opacity': '0.15',
        }));
      });

      // Y-axis labels (the range is what makes a flat line interpretable).
      svg.appendChild(text(PAD.left - 6, PAD.top + 4, fmtRate(max), 'end'));
      if (!flat) svg.appendChild(text(PAD.left - 6, PAD.top + plotH + 4, fmtRate(min), 'end'));

      // Provider-switch markers sit under the line so they never hide data.
      // non-scaling-stroke keeps them visible when the fixed viewBox is scaled
      // down to a narrow mobile container.
      switches.forEach(function (index) {
        var p = projected[index];
        svg.appendChild(el('line', {
          x1: p.x, y1: PAD.top, x2: p.x, y2: PAD.top + plotH,
          stroke: COLORS.switch, 'stroke-opacity': '0.75', 'stroke-width': '1.5',
          'stroke-dasharray': '3 3', 'vector-effect': 'non-scaling-stroke',
        }));
      });

      var d = projected.map(function (p, index) {
        return (index === 0 ? 'M' : 'L') + p.x.toFixed(2) + ' ' + p.y.toFixed(2);
      }).join(' ');
      svg.appendChild(el('path', {
        d: d, fill: 'none', stroke: COLORS.line, 'stroke-width': '2',
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        'vector-effect': 'non-scaling-stroke',
      }));

      // Endpoint marker so the current value is obvious.
      var last = projected[projected.length - 1];
      svg.appendChild(el('circle', {
        cx: last.x, cy: last.y, r: 3.5, fill: COLORS.dot,
        'vector-effect': 'non-scaling-stroke', 'stroke-width': '1.5',
      }));

      container.appendChild(svg);

      var cheapest = points.reduce(function (best, p) { return p.blended < best.blended ? p : best; }, points[0]);
      var dearest = points.reduce(function (best, p) { return p.blended > best.blended ? p : best; }, points[0]);
      var captionParts = [
        points.length + ' days',
        'latest ' + fmtRate(last.point.blended),
        'via ' + last.point.provider,
      ];
      if (flat) captionParts.push('flat at ' + fmtRate(min));
      else captionParts.push('low ' + fmtRate(cheapest.blended) + ' · high ' + fmtRate(dearest.blended));
      if (switches.length) {
        captionParts.push(switches.length + (switches.length === 1 ? ' provider switch' : ' provider switches'));
      }
      container.appendChild(caption(captionParts.join(' · ')));

      var label = 'Price history: ' + points.length + ' days, latest ' + fmtRate(last.point.blended)
        + ' per million tokens via ' + last.point.provider + '.';
      if (flat) label += ' Price was unchanged across the period at ' + fmtRate(min) + '.';
      else label += ' Range ' + fmtRate(cheapest.blended) + ' to ' + fmtRate(dearest.blended) + '.';
      if (switches.length) label += ' Cheapest provider changed ' + switches.length + ' time(s).';
      container.setAttribute('aria-label', label);
      container.setAttribute('data-flat', flat ? 'true' : 'false');
      container.setAttribute('data-switches', String(switches.length));
      return container;
    }

    function projectFlat(points) {
      return points.every(function (p) { return p.blended === points[0].blended; });
    }

    function text(x, y, content, anchor) {
      var node = el('text', {
        x: x, y: y, 'font-size': '10', 'text-anchor': anchor || 'start',
        fill: 'currentColor', 'fill-opacity': '0.7',
      });
      node.textContent = content;
      return node;
    }

    function caption(content) {
      var node = document.createElement('p');
      node.className = 'tw-spark-caption';
      node.textContent = content;
      return node;
    }

    return { render: render, container: container };
  }

  var api = {
    createPriceSparkline: createPriceSparkline,
    projectPoints: projectPoints,
    switchIndexes: switchIndexes,
    fmtRate: fmtRate,
    fmtDay: fmtDay,
    VIEW_W: VIEW_W,
    VIEW_H: VIEW_H,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PriceSparkline = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);