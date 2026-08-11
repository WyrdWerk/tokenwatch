import { decodeSnapshot, renderSnapshotSvg } from '../public/share-snapshot.mjs';

const IMAGE_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=31536000, immutable',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'Content-Type': 'image/svg+xml; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
});

function errorResponse(message, status = 400) {
  return new Response(message, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    },
  });
}

/**
 * GET /share?d=<base64url>
 *
 * The URL contains a complete, validated snapshot of the visible card values.
 * It never reloads mutable pricing data, so the rendered image remains the exact
 * comparison/cost card that was shared. No storage or identifier lookup needed.
 */
export async function onRequest({ request }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return errorResponse('Method not allowed', 405);
  }

  const encoded = new URL(request.url).searchParams.get('d');
  if (!encoded) return errorResponse('Missing snapshot payload');

  try {
    const snapshot = decodeSnapshot(encoded);
    const svg = renderSnapshotSvg(snapshot);
    const headers = new Headers(IMAGE_HEADERS);
    headers.set('Content-Disposition', `inline; filename="tokenwatch-${snapshot.k}-snapshot.svg"`);
    return new Response(request.method === 'HEAD' ? null : svg, { status: 200, headers });
  } catch (error) {
    console.warn('Rejected TokenWatch share snapshot:', error?.message || error);
    return errorResponse('Invalid snapshot payload');
  }
}
