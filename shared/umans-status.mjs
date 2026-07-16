/**
 * shared/umans-status.mjs — Umans AI status snapshot extraction.
 *
 * Extracts performance data from status.umans.ai SSR HTML.
 * The Next.js page embeds the status snapshot in __next_f flight data.
 *
 * PURE function — no imports, no fetch, no node: deps.
 * Safe to import from Cloudflare Workers.
 */

/**
 * Extract the Umans status snapshot from the HTML of status.umans.ai.
 *
 * The Next.js SSR page embeds the status data in __next_f push chunks.
 * The snapshot is in a chunk containing "initialSnapshot".
 *
 * @param {string} html - Raw HTML string from status.umans.ai
 * @returns {{models: Object, generated_at: string} | null} Parsed snapshot or null if extraction fails
 */
export function extractUmansSnapshot(html) {
  if (!html || typeof html !== 'string') return null;

  try {
    // Find __next_f push chunks - handle both single and multi-line formats
    // Format: self.__next_f.push([1,"..."])
    const pushRegex = /self\.__next_f\.push\(\[1,("([^"\\]|\\.)*")\]\)/g;
    
    let match;
    let snapshotData = null;

    while ((match = pushRegex.exec(html)) !== null) {
      const quotedContent = match[1];
      // Remove outer quotes
      const chunk = quotedContent.slice(1, -1);
      
      // Look for chunks containing initialSnapshot or model data
      if (chunk.includes('initialSnapshot') || chunk.includes('"models"')) {
        // Decode Next.js RSC escaping
        let decoded = chunk
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
          .replace(/\\\$\\/g, '$');
        
        // Try to extract JSON object - look for { ... "models": { ... } ... }
        // Use a more permissive regex that handles nested braces
        let braceCount = 0;
        let startIndex = -1;
        let endIndex = -1;
        
        for (let i = 0; i < decoded.length; i++) {
          if (decoded[i] === '{') {
            if (braceCount === 0) startIndex = i;
            braceCount++;
          } else if (decoded[i] === '}') {
            braceCount--;
            if (braceCount === 0 && startIndex !== -1) {
              endIndex = i;
              break;
            }
          }
        }
        
        if (startIndex !== -1 && endIndex !== -1) {
          const jsonStr = decoded.substring(startIndex, endIndex + 1);
          try {
            snapshotData = JSON.parse(jsonStr);
            break;
          } catch (e) {
            // Continue searching
          }
        }
      }
    }

    // Validate the extracted data
    if (snapshotData && snapshotData.models && typeof snapshotData.models === 'object') {
      // Validate each model has required fields
      const models = snapshotData.models;
      for (const [modelId, metrics] of Object.entries(models)) {
        if (!metrics) continue;
        
        const hasLatency = metrics.latency?.ttft_ms?.p50 !== undefined;
        const hasThroughput = metrics.output_tokens_per_second?.p50 !== undefined;
        
        if (!hasLatency && !hasThroughput) {
          // Model doesn't have valid metrics, skip this model
          delete models[modelId];
        }
      }

      // Return result if valid models remain
      if (Object.keys(models).length > 0) {
        return {
          models,
          generated_at: snapshotData.generated_at || new Date().toISOString(),
        };
      }
    }
    
    // If __next_f extraction failed or returned no valid models, try HTML fallback
    // If __next_f extraction failed or returned no valid models, try HTML fallback
    return extractUmansFromHTML(html);
  } catch (err) {
    // If everything failed, try HTML fallback
    return extractUmansFromHTML(html);
  }
}

/**
 * Alternative extraction: parse HTML-rendered metrics directly.
 * This is a fallback when __next_f extraction fails.
 *
 * @param {string} html - Raw HTML string
 * @returns {{models: Object, generated_at: string} | null}
 */
export function extractUmansFromHTML(html) {
  if (!html || typeof html !== 'string') return null;

  try {
    const models = {};
    
    // Extract model IDs from anchor tags: <a href="/status/umans-glm-5.2">Umans GLM 5.2</a>
    const modelIdRegex = /\/status\/(umans-[a-z0-9.-]+)"[^>]*>Umans\s+([A-Za-z0-9\s.]+)<\/a>/g;
    let modelMatch;
    const modelNames = new Map();
    
    while ((modelMatch = modelIdRegex.exec(html)) !== null) {
      const modelId = modelMatch[1];
      const displayName = modelMatch[2].trim();
      modelNames.set(modelId, displayName);
    }
    
    // Extract throughput values: <span class="status_mv__...">72.9</span><span class="status_mu___...">tok/s</span>
    const tpsRegex = /<span class="status_mv__[^"]+">(\d+\.?\d*)<\/span><span class="status_mu___[^"]+">tok\/s<\/span>/g;
    let tpsMatch;
    const tpsValues = [];
    
    while ((tpsMatch = tpsRegex.exec(html)) !== null) {
      const tps = parseFloat(tpsMatch[1]);
      if (!isNaN(tps)) tpsValues.push(tps);
    }
    
    // Extract TTFT values: <span class="status_mv__...">2.14</span><span class="status_mu___...">s</span>
    const ttftRegex = /<span class="status_mv__[^"]+">(\d+\.?\d*)<\/span><span class="status_mu___[^"]+">s<\/span>/g;
    let ttftMatch;
    const ttftValues = [];
    
    while ((ttftMatch = ttftRegex.exec(html)) !== null) {
      const ttftSec = parseFloat(ttftMatch[1]);
      if (!isNaN(ttftSec)) ttftValues.push(ttftSec * 1000); // Convert to ms
    }
    
    // Match models with their metrics (assuming same order in HTML)
    const modelIds = [...modelNames.keys()];
    for (let i = 0; i < modelIds.length && i < tpsValues.length && i < ttftValues.length; i++) {
      const modelId = modelIds[i];
      // Skip variant models (e.g., umans-glm-5.2-nvfp4)
      if (modelId.includes('-nvfp4') || modelId.includes('-fp8')) continue;
      
      models[modelId] = {
        latency: { ttft_ms: { p50: Math.round(ttftValues[i]) } },
        output_tokens_per_second: { p50: tpsValues[i] },
      };
    }

    if (Object.keys(models).length === 0) return null;

    return {
      models,
      generated_at: new Date().toISOString(),
    };
  } catch (err) {
    return null;
  }
}
