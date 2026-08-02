/**
 * generate-seo.mjs — build-time SEO generation.
 * Server-renders cheapest models into index.html for crawlability,
 * regenerates sitemap.xml + robots.txt. Idempotent.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

  const priced = models
    .filter((m) => m.pricing && (m.pricing.input > 0 || m.pricing.output > 0))
    .map((m) => {
      const { input = 0, output = 0, cache_read = null } = m.pricing;
      const eff = cache_read != null && cache_read > 0
        ? input * 0.025 + cache_read * 0.97 + output * 0.005
        : input * 0.025 + output * 0.005;
      return { m, eff };
    })
    .filter((x) => x.eff > 0)
    .sort((a, b) => a.eff - b.eff)
    .slice(0, TOP_N);

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

  const seoTable = "    <section class=\"seo-models\" aria-label=\"Cheapest LLM API models\">"
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

  let indexHtml = await readFile(join(PUBLIC, "index.html"), "utf8");
  const seoMarker = 'class="seo-models"';
  if (indexHtml.includes(seoMarker)) {
    indexHtml = indexHtml.replace(/<section class="seo-models"[\s\S]*?<\/section>/, seoTable);
  } else {
    indexHtml = indexHtml.replace("</main>", seoTable + "\n  </main>");
  }
  await writeFile(join(PUBLIC, "index.html"), indexHtml);
  console.log("generate-seo: rendered " + priced.length + " cheapest models into index.html");

  const sitemap = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
    + "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">"
    + "  <url><loc>" + SITE + "/</loc><lastmod>" + lastmod + "</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>"
    + "  <url><loc>" + SITE + "/image</loc><lastmod>" + lastmod + "</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>"
    + "  <url><loc>" + SITE + "/video</loc><lastmod>" + lastmod + "</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>"
    + "</urlset>";
  await writeFile(join(PUBLIC, "sitemap.xml"), sitemap);
  console.log("generate-seo: wrote sitemap.xml");

  const robots = "User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: " + SITE + "/sitemap.xml\n";
  await writeFile(join(PUBLIC, "robots.txt"), robots);
  console.log("generate-seo: wrote robots.txt");
}

main().catch((err) => { console.error("generate-seo failed:", err); process.exit(1); });
