// TokenWatch — WebMCP site tools (progressive enhancement).
// Registers tools only after window.TWCatalog is ready (pricing.json loaded).
// Feature-detects document.modelContext; no-op on browsers without WebMCP.
// Unregisters on pagehide via AbortController. Never copies cost math — every
// write goes through TWCatalog, which drives the same UI the human sees.

const TEXT_TOOL_DEFS = JSON.parse(`
[
  {
    "name": "about_tokenwatch",
    "title": "Get operating methodology",
    "description": "Read-only. Returns the TokenWatch WebMCP operating brief (rules and page capability map) plus the URL of the full skill. Call this before ranking, filtering, or comparing so you use {provider, id} identity and the live table correctly.",
    "annotations": { "readOnlyHint": true },
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "get_view",
    "title": "Get current results",
    "description": "Read-only snapshot of the TokenWatch text calculator the human is looking at: current mix, modes, filters, active sort, compare tray, rowCount, and the top ranked offerings (rank, provider, id, name, cost, blended $/M, zdr, speedP50, ttftP50 in seconds, intelligence, coding, agentic). Missing quality scores are null, never zero. By default, top is sorted by total session cost ascending; use set_sort to change the field and direction programmatically. Use this after any write so you describe the live table, not a stale one. Row identity is {provider, id}, never a row number. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": true },
    "inputSchema": {
      "type": "object",
      "properties": {
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 25,
          "description": "How many ranked rows to include in top (default 10)."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "get_model",
    "title": "Get one offering",
    "description": "Read-only detail for one offering in the current view: pricing, context, cache, ZDR/subscription, benchmarks, Neuralwatt energy if present, speedP50, and ttftP50 (seconds). Requires {provider, id} from get_view. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": true },
    "inputSchema": {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "description": "Inference provider slug (e.g. deepinfra)."
        },
        "id": {
          "type": "string",
          "description": "Model id as shown in get_view (not a rank number)."
        }
      },
      "required": [
        "provider",
        "id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "set_sort",
    "title": "Sort results",
    "description": "Sets the active table sort and direction, then re-renders the same results. Sortable columns: org, provider, model, input, output, cache_read, context, speed, ttft, intelligence, coding, agentic, blended, and cost. Text fields sort alphabetically; numeric fields sort ascending or descending. ttft is time-to-first-token in seconds (lower is faster). intelligence/coding/agentic are Artificial Analysis 0-100 indices; missing scores sort last, never as zero. Returns a fresh get_view snapshot. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": false },
    "inputSchema": {
      "type": "object",
      "properties": {
        "by": {
          "type": "string",
          "enum": [
            "org",
            "provider",
            "model",
            "input",
            "output",
            "cache_read",
            "context",
            "speed",
            "ttft",
            "intelligence",
            "coding",
            "agentic",
            "blended",
            "cost"
          ],
          "description": "Column to sort by."
        },
        "dir": {
          "type": "string",
          "enum": [
            "asc",
            "desc"
          ],
          "description": "asc = low/alphabetical first; desc = high/reverse-alphabetical first."
        }
      },
      "required": [
        "by",
        "dir"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "explain_ranking",
    "title": "Explain why #1 beats #2",
    "description": "Read-only deterministic explanation of why the current #1 ranks ahead of #2 using the table's active sort and direction (cost, blended rate, speed, prices, context, provider, org, or model name). Includes the active ranking metric, ranking values, cost components, and how many offerings were excluded because they cannot serve the requested mix. Does not change the table. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": true },
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "list_presets",
    "title": "List workload presets",
    "description": "Read-only list of named mix presets (agentic, balanced, heavy-output, no-cache) with their token mix. Use apply_preset to apply one \u2014 that re-renders the table. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": true },
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "get_share_url",
    "title": "Get shareable URL",
    "description": "Read-only. Returns the current page URL including the hash of mix/filters so the human can open the same view in any browser without ChatGPT. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": true },
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "get_catalog_info",
    "title": "Get catalog freshness",
    "description": "Read-only. Page name, pricing.json generated_at, and catalog size. Use this instead of inventing how fresh the data is. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": true },
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "set_workload",
    "title": "Set workload",
    "description": "Sets tokens or budget, input/cache/output mix, per-session vs monthly, and forward vs budget mode. Re-renders the results table. Mix percentages must sum to 100 (\u00b10.5); they are not silently renormalized. Partial updates are allowed. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": false },
    "inputSchema": {
      "type": "object",
      "properties": {
        "totalTokensM": {
          "type": "number",
          "minimum": 0,
          "description": "Total tokens in millions (session total, or daily tokens when costMode is monthly)."
        },
        "mix": {
          "type": "object",
          "properties": {
            "input": {
              "type": "number",
              "description": "Uncached input percent."
            },
            "cache": {
              "type": "number",
              "description": "Cached input percent."
            },
            "output": {
              "type": "number",
              "description": "Output percent."
            }
          },
          "required": [
            "input",
            "cache",
            "output"
          ],
          "additionalProperties": false
        },
        "costMode": {
          "type": "string",
          "enum": [
            "perRequest",
            "monthly"
          ],
          "description": "perRequest = per session; monthly multiplies cost \u00d730 from daily tokens."
        },
        "computeBy": {
          "type": "string",
          "enum": [
            "tokens",
            "budget"
          ],
          "description": "tokens = cost from volume; budget = how many tokens a $ budget buys."
        },
        "budget": {
          "type": "number",
          "minimum": 0,
          "description": "USD budget when computeBy is budget."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "apply_preset",
    "title": "Apply a mix preset",
    "description": "Applies a named mix preset (agentic, balanced, heavy-output, no-cache) and re-renders the table. Does not change filters. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": false },
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "enum": [
            "agentic",
            "balanced",
            "heavy-output",
            "no-cache"
          ]
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "set_cache_write",
    "title": "Set cache-write amortization",
    "description": "Sets the one-time cache-write volume (millions of tokens) and amortization N, then re-renders the table. Included in Total Cost. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": false },
    "inputSchema": {
      "type": "object",
      "properties": {
        "tokens": {
          "type": "number",
          "minimum": 0,
          "description": "Cache-write tokens in millions."
        },
        "amortizeN": {
          "type": "integer",
          "minimum": 1,
          "description": "Amortize the write cost over this many requests."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "set_filters",
    "title": "Set filters",
    "description": "Partial update of filters: provider search, model search, ZDR only, subscription only, promos only, group-by, min intelligence/coding/agentic, benchmarked only, hideBatch (default true), cacheOnly, maxBlended $/M, minToks, hq country. Re-renders the table. Workload is unchanged. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": false },
    "inputSchema": {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string",
          "description": "Inference provider search (substring)."
        },
        "model": {
          "type": "string",
          "description": "Model name search (substring)."
        },
        "zdr": {
          "type": "boolean",
          "description": "If true, only Zero Data Retention offerings."
        },
        "sub": {
          "type": "boolean",
          "description": "If true, only subscription providers."
        },
        "promo": {
          "type": "boolean",
          "description": "If true, only promotional (discounted) prices."
        },
        "groupBy": {
          "type": "string",
          "enum": [
            "none",
            "org",
            "provider"
          ]
        },
        "minIntelligence": {
          "type": "integer",
          "minimum": 0,
          "description": "Minimum Artificial Analysis intelligence index."
        },
        "minCoding": {
          "type": "integer",
          "minimum": 0,
          "description": "Minimum Artificial Analysis coding index. Offerings without a coding score are excluded when this is set."
        },
        "minAgentic": {
          "type": "integer",
          "minimum": 0,
          "description": "Minimum Artificial Analysis agentic index. Offerings without an agentic score are excluded when this is set."
        },
        "benchmarked": {
          "type": "boolean",
          "description": "If true, only offerings that have a benchmarks block (any AA or Design Arena field)."
        },
        "hideBatch": {
          "type": "boolean",
          "description": "If true (the default), hide :batch and :free SKUs. Set false to include them."
        },
        "cacheOnly": {
          "type": "boolean",
          "description": "If true, only offerings with a numeric cache-read price."
        },
        "maxBlended": {
          "type": "number",
          "minimum": 0,
          "description": "Maximum blended $/M at the current mix. 0 or omitted means no cap."
        },
        "minToks": {
          "type": "number",
          "minimum": 0,
          "description": "Minimum throughput p50 in tokens/sec. Offerings with no speed data are excluded when this is set."
        },
        "hq": {
          "type": "string",
          "description": "Headquarters country code (US, SG, CN, FR, ES, NL, SE) or unknown. Empty string means any."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "clear_filters",
    "title": "Clear filters",
    "description": "Resets search, ZDR, subscription, promo, group-by, min-intelligence/coding/agentic, benchmarked-only, hide-batch (back to on), cache-only, max blended, min tok/s, and HQ filters. Keeps the current workload. Re-renders the table. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": false },
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "compare_models",
    "title": "Compare offerings",
    "description": "Add, remove, clear, or set the compare tray (max 6). Identity is {provider, id} from get_view, never a rank. Optionally open the side-by-side compare modal. Re-renders the table and tray. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": false },
    "inputSchema": {
      "type": "object",
      "properties": {
        "action": {
          "type": "string",
          "enum": [
            "add",
            "remove",
            "clear",
            "set"
          ]
        },
        "models": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "provider": {
                "type": "string"
              },
              "id": {
                "type": "string"
              }
            },
            "required": [
              "provider",
              "id"
            ],
            "additionalProperties": false
          }
        },
        "open": {
          "type": "boolean",
          "description": "If true, open the compare modal (needs \u22652 selected)."
        }
      },
      "required": [
        "action"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "open_detail",
    "title": "Open detail modal",
    "description": "Opens the detail modal for one offering that is in the current view (pricing, benchmarks, Neuralwatt energy). Requires {provider, id} from get_view. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": false },
    "inputSchema": {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string"
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "provider",
        "id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "highlight_tradeoff",
    "title": "Highlight tradeoffs",
    "description": "Fills the compare tray with cheapest / fastest / ZDR-cheapest / smartest (highest AA intelligence with a score) from the current view and opens the compare modal. Re-renders the table. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": false },
    "inputSchema": {
      "type": "object",
      "properties": {
        "kinds": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "cheapest",
              "fastest",
              "zdr_cheapest",
              "smartest"
            ]
          },
          "description": "Which tradeoffs to include (default all four)."
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "export_csv",
    "title": "Export CSV",
    "description": "Triggers a CSV download of the current ranked results (same as the Export CSV button). In-app browsers may block the download; the result still reports filename and rowCount. Prefer get_share_url if the file does not appear. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": false },
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "snapshot_compare",
    "title": "Download compare PNG",
    "description": "Opens the compare modal (needs \u22652 selected) and triggers a PNG download of the comparison card. In-app browsers may block the download; use get_share_url as a fallback. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": false },
    "inputSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "download_cost_card",
    "title": "Download cost card PNG",
    "description": "Triggers a PNG download of the cost card for one offering in the current view. In-app browsers may block the download; use get_share_url as a fallback. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": false },
    "inputSchema": {
      "type": "object",
      "properties": {
        "provider": {
          "type": "string"
        },
        "id": {
          "type": "string"
        }
      },
      "required": [
        "provider",
        "id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "switch_catalog",
    "title": "Switch catalog page",
    "description": "Navigates to another TokenWatch catalog (text, image, video, benchmarks). The next page may register a thinner tool set. This leaves the current page. For operational details, call about_tokenwatch.",
    "annotations": { "readOnlyHint": false },
    "inputSchema": {
      "type": "object",
      "properties": {
        "page": {
          "type": "string",
          "enum": [
            "text",
            "image",
            "video",
            "benchmarks"
          ]
        }
      },
      "required": [
        "page"
      ],
      "additionalProperties": false
    }
  }
]
`);

const MEDIA_TOOL_DEFS = JSON.parse(`
{
  "image": [
    {
      "name": "about_tokenwatch",
      "title": "Get operating methodology",
      "description": "Read-only. Returns the TokenWatch WebMCP operating brief (rules and page capability map) plus the URL of the full skill. Call this before ranking, filtering, or comparing so you use {provider, id} identity and the live table correctly.",
      "annotations": { "readOnlyHint": true },
      "inputSchema": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      }
    },
    {
      "name": "get_view",
      "title": "Get current image results",
      "description": "Read-only snapshot of the TokenWatch image calculator: current image count or budget mode, filters, active sort, rowCount, and the top ranked image offerings. By default, top is sorted by total cost ascending; use set_sort to change any table column and direction. Row identity is {provider, id}, never a row number. For operational details, call about_tokenwatch.",
      "annotations": { "readOnlyHint": true },
      "inputSchema": {
        "type": "object",
        "properties": {
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 25,
            "description": "How many ranked rows to include in top (default 10)."
          }
        },
        "additionalProperties": false
      }
    },
    {
      "name": "get_catalog_info",
      "title": "Get image catalog freshness",
      "description": "Read-only. Returns the image page name, pricing snapshot timestamp, catalog size, and distinct provider count. For operational details, call about_tokenwatch.",
      "annotations": { "readOnlyHint": true },
      "inputSchema": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      }
    },
    {
      "name": "set_sort",
      "title": "Sort image results",
      "description": "Sets the active image-table sort and direction, then re-renders the same results. Sortable columns: org, model, cost_per_unit, and cost. Text fields sort alphabetically; numeric fields sort ascending or descending. Returns a fresh get_view snapshot. For operational details, call about_tokenwatch.",
      "annotations": { "readOnlyHint": false },
      "inputSchema": {
        "type": "object",
        "properties": {
          "by": {
            "type": "string",
            "enum": [
              "org",
              "model",
              "cost_per_unit",
              "cost"
            ],
            "description": "Column to sort by."
          },
          "dir": {
            "type": "string",
            "enum": [
              "asc",
              "desc"
            ],
            "description": "asc = low/alphabetical first; desc = high/reverse-alphabetical first."
          }
        },
        "required": [
          "by",
          "dir"
        ],
        "additionalProperties": false
      }
    }
  ],
  "video": [
    {
      "name": "about_tokenwatch",
      "title": "Get operating methodology",
      "description": "Read-only. Returns the TokenWatch WebMCP operating brief (rules and page capability map) plus the URL of the full skill. Call this before ranking, filtering, or comparing so you use {provider, id} identity and the live table correctly.",
      "annotations": { "readOnlyHint": true },
      "inputSchema": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      }
    },
    {
      "name": "get_view",
      "title": "Get current video results",
      "description": "Read-only snapshot of the TokenWatch video calculator: current duration or budget mode, filters, active sort, rowCount, and the top ranked video offerings. By default, top is sorted by total cost ascending; use set_sort to change any table column and direction. Row identity is {provider, id}, never a row number. For operational details, call about_tokenwatch.",
      "annotations": { "readOnlyHint": true },
      "inputSchema": {
        "type": "object",
        "properties": {
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 25,
            "description": "How many ranked rows to include in top (default 10)."
          }
        },
        "additionalProperties": false
      }
    },
    {
      "name": "get_catalog_info",
      "title": "Get video catalog freshness",
      "description": "Read-only. Returns the video page name, pricing snapshot timestamp, catalog size, and distinct provider count. For operational details, call about_tokenwatch.",
      "annotations": { "readOnlyHint": true },
      "inputSchema": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      }
    },
    {
      "name": "set_sort",
      "title": "Sort video results",
      "description": "Sets the active video-table sort and direction, then re-renders the same results. Sortable columns: org, model, resolution, audio, cost_per_second, and cost. Text fields sort alphabetically; numeric fields sort ascending or descending. Returns a fresh get_view snapshot. For operational details, call about_tokenwatch.",
      "annotations": { "readOnlyHint": false },
      "inputSchema": {
        "type": "object",
        "properties": {
          "by": {
            "type": "string",
            "enum": [
              "org",
              "model",
              "resolution",
              "audio",
              "cost_per_second",
              "cost"
            ],
            "description": "Column to sort by."
          },
          "dir": {
            "type": "string",
            "enum": [
              "asc",
              "desc"
            ],
            "description": "asc = low/alphabetical first; desc = high/reverse-alphabetical first."
          }
        },
        "required": [
          "by",
          "dir"
        ],
        "additionalProperties": false
      }
    }
  ],
  "benchmarks": [
    {
      "name": "about_tokenwatch",
      "title": "Get operating methodology",
      "description": "Read-only. Returns the TokenWatch WebMCP operating brief (rules and page capability map) plus the URL of the full skill. Call this before ranking, filtering, or comparing so you use canonical model ids on this page (not {provider, id}).",
      "annotations": { "readOnlyHint": true },
      "inputSchema": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      }
    },
    {
      "name": "get_view",
      "title": "Get current benchmark results",
      "description": "Read-only snapshot of the Benchmarks page the human is looking at: use-case tab, mix, org/search filters, active sort, rowCount, and the top ranked canonical models (id, name, org, scores, cheapest from $/M, value). Identity is canonical id, never {provider, id}. Value is score-per-dollar normalized so the best in view = 100; it is not an absolute number. Missing scores are null, never zero. For operational details, call about_tokenwatch.",
      "annotations": { "readOnlyHint": true },
      "inputSchema": {
        "type": "object",
        "properties": {
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 25,
            "description": "How many ranked rows to include in top (default 10)."
          }
        },
        "additionalProperties": false
      }
    },
    {
      "name": "get_catalog_info",
      "title": "Get benchmarks catalog freshness",
      "description": "Read-only. Returns the benchmarks page name, benchmarks.json generated_at, model count, and source list. For operational details, call about_tokenwatch.",
      "annotations": { "readOnlyHint": true },
      "inputSchema": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      }
    },
    {
      "name": "get_model",
      "title": "Get one canonical model",
      "description": "Read-only detail for one canonical model in the current view: scores (AA, LiveBench, Design Arena), offerings, and cheapest blended $/M at the current mix. Requires {id} from get_view — a canonical model id, not a provider offering. For operational details, call about_tokenwatch.",
      "annotations": { "readOnlyHint": true },
      "inputSchema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "Canonical model id from get_view (e.g. claude-opus-4.6), not a provider slug."
          }
        },
        "required": ["id"],
        "additionalProperties": false
      }
    },
    {
      "name": "set_sort",
      "title": "Sort benchmark results",
      "description": "Sets the active benchmarks-table sort and direction, then re-renders. Sortable fields: score, value, price, name, org, plus the visible score-column keys for the current use-case tab. Missing scores sink. Returns a fresh get_view snapshot. For operational details, call about_tokenwatch.",
      "annotations": { "readOnlyHint": false },
      "inputSchema": {
        "type": "object",
        "properties": {
          "by": {
            "type": "string",
            "description": "Column to sort by: score, value, price, name, org, or a score key such as aa_intelligence."
          },
          "dir": {
            "type": "string",
            "enum": ["asc", "desc"],
            "description": "asc = low/alphabetical first; desc = high/reverse-alphabetical first."
          }
        },
        "required": ["by", "dir"],
        "additionalProperties": false
      }
    },
    {
      "name": "set_use_case",
      "title": "Set use-case tab",
      "description": "Switches the Benchmarks page use-case tab (agentic, reasoning, knowledge, ui_quality) and re-renders. This changes which score columns and Value metric are active. For operational details, call about_tokenwatch.",
      "annotations": { "readOnlyHint": false },
      "inputSchema": {
        "type": "object",
        "properties": {
          "uc": {
            "type": "string",
            "enum": ["agentic", "reasoning", "knowledge", "ui_quality"],
            "description": "Use-case tab key."
          }
        },
        "required": ["uc"],
        "additionalProperties": false
      }
    },
    {
      "name": "set_filters",
      "title": "Set benchmarks filters",
      "description": "Partial update of Benchmarks page filters: model search, org, and the Value-benchmark key (including __any__ for no score filter). Re-renders the table. For operational details, call about_tokenwatch.",
      "annotations": { "readOnlyHint": false },
      "inputSchema": {
        "type": "object",
        "properties": {
          "search": {
            "type": "string",
            "description": "Model name / org substring search."
          },
          "org": {
            "type": "string",
            "description": "Creator org slug. Empty string means all organizations."
          },
          "valueKey": {
            "type": "string",
            "description": "Score key driving Value, or __any__ to show every model with Value disabled."
          }
        },
        "additionalProperties": false
      }
    }
  ]
}
`);

function asResult(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}


let aboutCache = null;
async function aboutTokenwatch() {
  if (aboutCache) return aboutCache;
  const res = await fetch('/webmcp-about.json');
  if (!res.ok) {
    return { error: 'Could not load about_tokenwatch brief. Try /skill.md.', skillUrl: '/skill.md' };
  }
  aboutCache = await res.json();
  return aboutCache;
}

function catalogExecutors(catalog) {
  return {
    about_tokenwatch: () => aboutTokenwatch(),
    get_view: (input) => catalog.getView(input),
    get_model: (input) => catalog.getModel(input),
    set_use_case: (input) => catalog.setUseCase(input),
    set_sort: (input) => catalog.setSort(input),
    explain_ranking: () => catalog.explainRanking(),
    list_presets: () => catalog.listPresets(),
    get_share_url: () => catalog.getShareUrl(),
    get_catalog_info: () => catalog.getCatalogInfo(),
    set_workload: (input) => catalog.setWorkload(input),
    apply_preset: (input) => catalog.applyPreset(input?.name),
    set_cache_write: (input) => catalog.setCacheWrite(input),
    set_filters: (input) => catalog.setFilters(input),
    clear_filters: () => catalog.clearFilters(),
    compare_models: (input) => catalog.compareModels(input),
    open_detail: (input) => catalog.openDetail(input),
    highlight_tradeoff: (input) => catalog.highlightTradeoff(input),
    export_csv: () => catalog.exportCsv(),
    snapshot_compare: () => catalog.snapshotCompare(),
    download_cost_card: (input) => catalog.downloadCostCard(input),
    switch_catalog: (input) => catalog.switchCatalog(input?.page),
  };
}

function waitForCatalog(timeoutMs) {
  if (window.TWCatalog?.ready) return Promise.resolve(window.TWCatalog);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    document.addEventListener('tw-catalog-ready', () => {
      clearTimeout(timer);
      resolve(window.TWCatalog || null);
    }, { once: true });
  });
}

async function registerPageTools(catalog, defs, signal) {
  const ctx = document.modelContext;
  const exec = catalogExecutors(catalog);
  await Promise.all(defs.map((def) => {
    const run = exec[def.name];
    return ctx.registerTool({
      name: def.name,
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: def.annotations || {},
      execute: async (input, extras) => {
        try {
          if (extras?.signal?.aborted) {
            return asResult({ error: 'Tool execution was cancelled.' });
          }
          const result = await run(input || {}, extras);
          return asResult(result);
        } catch (err) {
          return asResult({ error: err?.message || String(err) });
        }
      },
    }, { signal });
  }));
}

async function bootWebmcp() {
  if (!document.modelContext || typeof document.modelContext.registerTool !== 'function') {
    return;
  }
  const catalog = await waitForCatalog(15_000);
  if (!catalog?.ready) return;

  const defs = catalog.page === 'text' ? TEXT_TOOL_DEFS : (MEDIA_TOOL_DEFS[catalog.page] || []);
  if (!defs.length) return;

  const controller = new AbortController();
  window.addEventListener('pagehide', () => controller.abort(), { once: true });
  try {
    await registerPageTools(catalog, defs, controller.signal);
  } catch (err) {
    console.warn('TokenWatch WebMCP: tool registration failed', err);
  }
}

bootWebmcp();
