# about_tokenwatch Implementation Plan

**Goal:** Agents see a first-sorted WebMCP tool that returns a brief sliced from SKILL.md, plus a public /skill.md URL.
**Architecture:** SKILL.md is the only authored contract. A build script extracts a marked brief and copies the full skill to public/skill.md. about_tokenwatch fetches that generated JSON at execute time. One identical one-liner is appended to every tool description.
**Tech stack:** existing Node ESM scripts, public/webmcp.js JSON.parse tool defs, node:test.
**Out of scope:** {full:true}, MCP resources, renaming existing tools, sitemap entry for /skill.md.

Live-tool coverage (this session closed the leftover 8): text open_detail, highlight_tradeoff, export_csv, snapshot_compare, download_cost_card, switch_catalog; image set_sort; video set_sort.
