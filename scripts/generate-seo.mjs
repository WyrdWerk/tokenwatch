/**
 * generate-seo.mjs — build-time SEO generation.
 * Server-renders cheapest models into index.html for crawlability, substitutes
 * live model/provider counts into the head/JSON-LD/FAQ copy, and regenerates
 * sitemap.xml + robots.txt. Idempotent.
 *
 * Pure builders (renderSeoTable / renderCounts / buildSitemap / buildRobots) are
 * exported for tests; main() runs only when invoked as a script.
 */
import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { blendedRate, AGENTIC_MIX } from "../shared/cost.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "..", "public");
const SITE = "https://tokenwatch.wyrdwerk.com";
const TOP_N = 25;

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtPrice(v) {
  if (v === null || v === undefined) return "—";
  if (v === 0) return "$0";
  if (v < 0.01) return "$" + v.toFixed(4);
  if (v < 1) return "$" + v.toFixed(3);
  return "$" + v.toFixed(2);
}

/**
 * Pick the 25 cheapest models by effective $/M at the agentic mix.
 * Uses shared/cost.mjs blendedRate — the SAME null semantics as the app's
 * blendedCostFor (cache_read null → charged at the input rate). Pure.
 */
export function cheapestModels(models, topN = TOP_N) {
  return models
    .filter((m) => m.pricing && (m.pricing.input > 0 || m.pricing.output > 0))
    .map((m) => ({ m, eff: blendedRate(m.pricing, AGENTIC_MIX) }))
    .filter((x) => x.eff != null && x.eff > 0)
    .sort((a, b) => a.eff - b.eff)
    .slice(0, topN);
}

/** Render the `<section class="seo-models" id="cheapest">…</section>` block. Pure. */
export function renderSeoTable(priced, lastmod) {
  const rows = priced.map(({ m, eff }) => {
    const p = m.pricing || {};
    return "      <tr>"
      + "        <td>" + esc(m.org || m.provider) + "</td>"
      + "        <td>" + esc(m.provider) + "</td>"
      + "        <td>" + esc(m.name || m.id) + "</td>"
      + "        <td class=\"num\">" + fmtPrice(p.input) + "</td>"
      + "        <td class=\"num\">" + fmtPrice(p.output) + "</td>"
      + "        <td class=\"num\">" + fmtPrice(p.cache_read) + "</td>"
      + "        <td class=\"num\">" + fmtPrice(eff) + "</td>"
      + "      </tr>";
  }).join("\n");

  return "    <section class=\"seo-models\" id=\"cheapest\" aria-label=\"Cheapest LLM API models\">"
    + "      <h2>Cheapest LLM API models right now</h2>"
    + "      <p>Ranked by effective cost at a typical agentic mix (2.5% input, 97% cached input, 0.5% output). Prices are USD per million tokens. Use the calculator above to compute your exact workload cost.</p>"
    + "      <div class=\"table-wrap\">"
    + "        <table>"
    + "          <caption>Cheapest LLM API models by effective per-million-token cost</caption>"
    + "          <thead><tr><th scope=\"col\">Org</th><th scope=\"col\">Provider</th><th scope=\"col\">Model</th><th scope=\"col\" class=\"num\">Input $/M</th><th scope=\"col\" class=\"num\">Output $/M</th><th scope=\"col\" class=\"num\">Cache $/M</th><th scope=\"col\" class=\"num\">Effective $/M</th></tr></thead>"
    + "          <tbody>"
    + rows
    + "          </tbody>"
    + "        </table>"
    + "      </div>"
    + "      <p class=\"seo-note\">Pricing refreshed " + esc(lastmod) + " from public provider APIs. Always verify on the provider official pricing page.</p>"
    + "    </section>";
}

/**
 * Substitute live counts into the {{modelCount}} / {{providerCount}} placeholders
 * (head title/description, og/twitter, JSON-LD WebSite + FAQPage, subtitle, FAQ).
 * Global replace — the JSON-LD block and FAQ carry the counts in multiple spots.
 * Throws if any placeholder survives (a hand-edit changing the token text would
 * otherwise ship unreplaced markup silently). Pure.
 */
export function renderCounts(markup, modelCount, providerCount) {
  const out = markup
    .replaceAll("{{modelCount}}", String(modelCount))
    .replaceAll("{{providerCount}}", String(providerCount));
  if (out.includes("{{")) {
    throw new Error(`generate-seo: unreplaced count placeholder remains in index.html (model=${modelCount}, provider=${providerCount})`);
  }
  return out;
}

/** Sitemap for the three static pages, lastmod from pricing.generated_at. Pure. */
export function buildSitemap(lastmod) {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
    + "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">"
    + "  <url><loc>" + SITE + "/</loc><lastmod>" + lastmod + "</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>"
    + "  <url><loc>" + SITE + "/image</loc><lastmod>" + lastmod + "</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>"
    + "  <url><loc>" + SITE + "/video</loc><lastmod>" + lastmod + "</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>"
    + "</urlset>";
}

/** robots.txt — allow crawl, disallow the API, point at the sitemap. Pure. */
export function buildRobots() {
  return "User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: " + SITE + "/sitemap.xml\n";
}

/** Atomic write (tmp + rename) so a runner death can never leave a truncated file. */
async function writeAtomic(filePath, content) {
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, filePath);
}

async function main() {
  let pricing;
  try {
    pricing = JSON.parse(await readFile(join(PUBLIC, "pricing.json"), "utf8"));
  } catch (err) {
    console.error("generate-seo: pricing.json not found — run fetch-pricing.mjs first.");
    process.exit(1);
  }
  const models = pricing.models || [];
  const generatedAt = pricing.generated_at || new Date().toISOString();
  const lastmod = generatedAt.slice(0, 10);

  const priced = cheapestModels(models);

  let indexHtml = await readFile(join(PUBLIC, "index.html"), "utf8");
  const seoTable = renderSeoTable(priced, lastmod);
  const seoMarker = 'class="seo-models"';
  if (indexHtml.includes(seoMarker)) {
    // Consume the preceding newline + indentation so the replacement is canonical:
    // rerunning generate-seo must be byte-idempotent (no indentation creep per run).
    indexHtml = indexHtml.replace(/(?:\r?\n)[ \t]*<section[^>]*class="seo-models"[^>]*>[\s\S]*?<\/section>/, "\n" + seoTable);
  } else {
    indexHtml = indexHtml.replace("</main>", seoTable + "\n  </main>");
  }

  const providerCount = new Set(models.map((m) => m.provider)).size;
  indexHtml = renderCounts(indexHtml, models.length, providerCount);
  await writeAtomic(join(PUBLIC, "index.html"), indexHtml);
  console.log("generate-seo: rendered " + priced.length + " cheapest models and counts (" + models.length + " models / " + providerCount + " providers) into index.html");

  await writeAtomic(join(PUBLIC, "sitemap.xml"), buildSitemap(lastmod));
  console.log("generate-seo: wrote sitemap.xml");

  await writeAtomic(join(PUBLIC, "robots.txt"), buildRobots());
  console.log("generate-seo: wrote robots.txt");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => { console.error("generate-seo failed:", err); process.exit(1); });
}