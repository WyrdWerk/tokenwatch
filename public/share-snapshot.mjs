// TokenWatch — immutable card snapshot codec + SVG renderer.
// Pure ESM: browser and Cloudflare Pages Functions compatible; no node: imports.

export const SNAPSHOT_LIMITS = Object.freeze({
  maxEncodedChars: 14000,
  maxJsonBytes: 10000,
  maxColumns: 6,
  maxRows: 24,
  maxTitleChars: 80,
  maxBasisChars: 600,
  maxCellChars: 180,
});

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(message) {
  throw new TypeError(`Invalid TokenWatch snapshot: ${message}`);
}

function cleanString(value, label, max, allowEmpty = false) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!allowEmpty && !cleaned) fail(`${label} is required`);
  if (cleaned.length > max) fail(`${label} is too long`);
  return cleaned;
}

/** Validate and normalize the compact, frozen snapshot payload. */
export function validateSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('payload must be an object');
  if (input.v !== 1) fail('unsupported version');
  if (input.k !== 'cost' && input.k !== 'comparison') fail('unknown card kind');

  const title = cleanString(input.t, 'title', SNAPSHOT_LIMITS.maxTitleChars);
  const basis = cleanString(input.b, 'basis', SNAPSHOT_LIMITS.maxBasisChars);
  const theme = input.m === 'dark' ? 'dark' : 'light';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(input.d || '') ? input.d : '';

  if (!Array.isArray(input.c) || input.c.length < 1 || input.c.length > SNAPSHOT_LIMITS.maxColumns) {
    fail(`columns must contain 1-${SNAPSHOT_LIMITS.maxColumns} entries`);
  }
  const columns = input.c.map((value, index) => cleanString(
    value,
    `column ${index + 1}`,
    SNAPSHOT_LIMITS.maxCellChars,
  ));

  if (!Array.isArray(input.r) || input.r.length < 1 || input.r.length > SNAPSHOT_LIMITS.maxRows) {
    fail(`rows must contain 1-${SNAPSHOT_LIMITS.maxRows} entries`);
  }
  const rows = input.r.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length < 2 || row.length > 3) fail(`row ${rowIndex + 1} is malformed`);
    const label = cleanString(row[0], `row ${rowIndex + 1} label`, SNAPSHOT_LIMITS.maxCellChars);
    if (!Array.isArray(row[1]) || row[1].length !== columns.length) {
      fail(`row ${rowIndex + 1} must have ${columns.length} values`);
    }
    const values = row[1].map((value, valueIndex) => cleanString(
      value,
      `row ${rowIndex + 1} value ${valueIndex + 1}`,
      SNAPSHOT_LIMITS.maxCellChars,
      true,
    ));
    const best = row[2] == null ? [] : row[2];
    if (!Array.isArray(best) || best.some((index) => !Number.isInteger(index) || index < 0 || index >= columns.length)) {
      fail(`row ${rowIndex + 1} has invalid highlighted cells`);
    }
    return [label, values, [...new Set(best)]];
  });

  if (input.k === 'cost' && columns.length !== 1) fail('cost cards require exactly one value column');

  return { v: 1, k: input.k, t: title, b: basis, c: columns, r: rows, m: theme, d: date };
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(encoded) {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - encoded.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Encode a validated snapshot as compact UTF-8 JSON in URL-safe base64. */
export function encodeSnapshot(input) {
  const snapshot = validateSnapshot(input);
  const bytes = encoder.encode(JSON.stringify(snapshot));
  if (bytes.length > SNAPSHOT_LIMITS.maxJsonBytes) fail('payload exceeds the share URL limit');
  const encoded = bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  if (encoded.length > SNAPSHOT_LIMITS.maxEncodedChars) fail('encoded payload exceeds the share URL limit');
  return encoded;
}

/** Decode, parse, and validate a URL-safe snapshot payload. */
export function decodeSnapshot(encoded) {
  if (typeof encoded !== 'string' || !encoded || encoded.length > SNAPSHOT_LIMITS.maxEncodedChars) {
    fail('encoded payload is missing or too large');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) fail('encoded payload contains invalid characters');
  let parsed;
  try {
    const bytes = base64ToBytes(encoded);
    if (bytes.length > SNAPSHOT_LIMITS.maxJsonBytes) fail('payload exceeds the share URL limit');
    parsed = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith('Invalid TokenWatch snapshot:')) throw error;
    fail('payload could not be decoded');
  }
  return validateSnapshot(parsed);
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char]);
}

function wrapText(value, maxChars, maxLines) {
  const raw = String(value || '').trim();
  if (!raw) return [''];
  const tokens = [];
  for (const word of raw.split(/\s+/)) {
    if (word.length <= maxChars) tokens.push(word);
    else for (let i = 0; i < word.length; i += maxChars) tokens.push(word.slice(i, i + maxChars));
  }
  const lines = [];
  let line = '';
  for (const token of tokens) {
    const next = line ? `${line} ${token}` : token;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = token;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept.length - 1;
  kept[last] = `${kept[last].slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
  return kept;
}

function textLines(lines, x, top, rowHeight, anchor, color, weight = 400, size = 13) {
  const lineHeight = size + 4;
  const firstY = top + (rowHeight - lines.length * lineHeight) / 2 + size;
  return lines.map((line, index) =>
    `<text x="${x}" y="${firstY + index * lineHeight}" text-anchor="${anchor}" fill="${color}" font-size="${size}" font-weight="${weight}">${xml(line)}</text>`,
  ).join('');
}

/** Render the frozen snapshot as a standalone, directly shareable SVG image. */
export function renderSnapshotSvg(input) {
  const snapshot = validateSnapshot(input);
  const dark = snapshot.m === 'dark';
  const colors = dark
    ? { bg: '#1a1612', surface: '#242018', text: '#f0ebe3', dim: '#b7aea2', border: '#463e34', accent: '#69b8c1', green: '#78c79b', bestBg: '#183b2b', stripe: '#201c17' }
    : { bg: '#F8F5F0', surface: '#ffffff', text: '#1a1612', dim: '#6b635a', border: '#ddd5c8', accent: '#1E6E8E', green: '#2d8a5a', bestBg: '#e5f4eb', stripe: '#f5f1eb' };

  const pad = 24;
  const metricWidth = snapshot.k === 'cost' ? 190 : 168;
  const valueWidth = snapshot.k === 'cost' ? 330 : 160;
  const contentWidth = metricWidth + valueWidth * snapshot.c.length;
  const width = contentWidth + pad * 2;
  const lineHeight = 17;
  const basisLines = wrapText(snapshot.b, Math.max(24, Math.floor((contentWidth - 24) / 7)), 4);
  const basisHeight = Math.max(42, basisLines.length * lineHeight + 20);
  const headerCells = ['Metric', ...snapshot.c];
  const headerLines = headerCells.map((value, index) => wrapText(
    value,
    Math.max(12, Math.floor(((index === 0 ? metricWidth : valueWidth) - 24) / 7)),
    3,
  ));
  const headerHeight = Math.max(42, Math.max(...headerLines.map((lines) => lines.length)) * lineHeight + 18);

  const bodyLayouts = snapshot.r.map(([label, values]) => {
    const lines = [
      wrapText(label, Math.max(12, Math.floor((metricWidth - 24) / 7)), 2),
      ...values.map((value) => wrapText(value, Math.max(12, Math.floor((valueWidth - 24) / 7)), 2)),
    ];
    const height = Math.max(38, Math.max(...lines.map((entry) => entry.length)) * lineHeight + 16);
    return { lines, height };
  });

  const brandHeight = 40;
  const gap = 12;
  const footerHeight = 34;
  const height = pad + brandHeight + gap + basisHeight + gap + headerHeight
    + bodyLayouts.reduce((sum, row) => sum + row.height, 0) + footerHeight + pad;

  let y = pad;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="snapshot-title snapshot-desc">`,
    `<title id="snapshot-title">${xml(`TokenWatch ${snapshot.t}`)}</title>`,
    `<desc id="snapshot-desc">${xml(snapshot.b)}</desc>`,
    `<rect width="${width}" height="${height}" rx="10" fill="${colors.bg}"/>`,
    `<g font-family="Inter,system-ui,-apple-system,Segoe UI,sans-serif">`,
    `<text x="${pad}" y="${y + 24}" fill="${colors.accent}" font-size="15" font-weight="700">💰 TokenWatch</text>`,
    `<text x="${pad + 132}" y="${y + 24}" fill="${colors.text}" font-size="19" font-weight="650">${xml(snapshot.t)}</text>`,
  ];
  y += brandHeight + gap;

  out.push(`<rect x="${pad}" y="${y}" width="${contentWidth}" height="${basisHeight}" rx="6" fill="${colors.surface}" stroke="${colors.border}"/>`);
  out.push(textLines(basisLines, pad + 12, y, basisHeight, 'start', colors.text, 500, 13));
  y += basisHeight + gap;

  let x = pad;
  headerLines.forEach((lines, index) => {
    const cellWidth = index === 0 ? metricWidth : valueWidth;
    out.push(`<rect x="${x}" y="${y}" width="${cellWidth}" height="${headerHeight}" fill="${colors.surface}" stroke="${colors.border}"/>`);
    out.push(textLines(
      lines,
      index === 0 ? x + 12 : x + cellWidth - 12,
      y,
      headerHeight,
      index === 0 ? 'start' : 'end',
      colors.dim,
      650,
      12,
    ));
    x += cellWidth;
  });
  y += headerHeight;

  snapshot.r.forEach(([label, values, best], rowIndex) => {
    const layout = bodyLayouts[rowIndex];
    x = pad;
    const cells = [label, ...values];
    cells.forEach((value, cellIndex) => {
      const cellWidth = cellIndex === 0 ? metricWidth : valueWidth;
      const valueIndex = cellIndex - 1;
      const highlighted = valueIndex >= 0 && best.includes(valueIndex);
      const fill = highlighted ? colors.bestBg : (rowIndex % 2 ? colors.stripe : colors.bg);
      out.push(`<rect x="${x}" y="${y}" width="${cellWidth}" height="${layout.height}" fill="${fill}" stroke="${colors.border}"/>`);
      out.push(textLines(
        layout.lines[cellIndex],
        cellIndex === 0 ? x + 12 : x + cellWidth - 12,
        y,
        layout.height,
        cellIndex === 0 ? 'start' : 'end',
        highlighted ? colors.green : (cellIndex === 0 ? colors.dim : colors.text),
        highlighted || cellIndex === 0 ? 650 : 450,
        13,
      ));
      x += cellWidth;
    });
    y += layout.height;
  });

  const footer = snapshot.d
    ? `Snapshot ${snapshot.d} · tokenwatch.wyrdwerk.com`
    : 'tokenwatch.wyrdwerk.com';
  out.push(`<text x="${pad}" y="${height - pad}" fill="${colors.dim}" font-size="11">${xml(footer)}</text>`);
  out.push('</g></svg>');
  return out.join('');
}
