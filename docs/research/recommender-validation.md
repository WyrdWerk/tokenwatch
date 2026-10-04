# Recommender validation

**Checked:** 2026-10-04. **Conclusion:** this is a dated comparison of the recommendation snapshot with public benchmarks, preference boards, and usage rankings. It is not a claim that any source establishes the correct product weights, floors, or workload token shares. The original comparison did not change defaults; the subsequent product decision and resulting snapshot are recorded in the addendum below. The main tables remain the pre-change baseline.

## Addendum — Arena preference decision (2026-10-04; revised scoring)

The product decision is to rank creative writing primarily by human preference while keeping chat capability and preference distinct. TokenWatch reads the official [Arena leaderboard dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset), selecting Text Arena `overall` and `creative_writing` from its `text_style_control` configuration. The committed cache was fetched 2026-10-04; both selected boards' latest published rows are dated 2026-10-02. The dataset is licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); TokenWatch retains its source URL, dataset endpoint, license, and attribution in the cache/catalog and refreshes weekly. Only category filtering and conservative model-name matching are applied; source rating values are unchanged. The UI, API response metadata, methodology page, and WebMCP guidance carry source/license/date attribution. No coding, math, or web-development Arena categories are included.

The revised creative-writing composite uses Arena Creative Writing at 75% and AA intelligence at 25%; LiveBench language is removed. Its language subset covers only about 19 models and is indirect for writing preference. At 55% Arena weight, missing-signal shrinkage still stopped Kimi K3—Arena Creative Writing #1 at 1460.18—from winning best quality. The absolute floor is 1310, the ceiling of the interpolated p25 (1309.5047) among 65 open-weight, non-subscription, priceable, provider-qualified families meeting the 16K context requirement and having an Arena creative-writing score. Their median is 1362.5262. In the current pricing snapshot, 75 of 134 open-weight canonical IDs (56.0%) have a score in each selected Arena category; the 65-family set is the narrower creative-writing floor-calibration cohort.

Current creative-writing picks are **Kimi K3** (best quality), **MiMo V2.6 Pro** (best value), and **Gemma 3 12B IT** (cheapest above the Arena floor). The Arena Creative Writing favorite is **Kimi K3** (1460.18). Across 17 one-at-a-time sensitivity scenarios, best quality changed 0/17, best value 0/17, and cheapest-above-floor 2/17. Chat keeps capability-ranked picks (**DeepSeek V4 Pro**, **GLM-5.3 Flash**, **DeepSeek V4 Flash 0731**) and separately reports Arena Text's **Kimi K3** as people's favourite (1488.36). In 19 chat sensitivity scenarios, best quality changed 1/19, best value 4/19, and cheapest-above-floor 0/19. For both workloads the #1 provider on the baseline fixed model changed in all 11 provider-weight/mix scenarios; this is distinct from model pick stability and is not a guarantee about provider ranking.

This revised addendum supersedes the earlier 55%/25%/20% creative-writing weights and floor. It resolves the first open question: creative writing is preference-led; chat exposes capability and preference separately.

## Scope and method

- The pre-change comparison's pricing snapshot was generated at `2026-10-04T07:33:15.809Z` and its benchmark snapshot at `2026-10-04T07:34:28.292Z`; LiveBench was release `2026-06-25`. The addendum uses the same pricing/performance snapshot with Arena-enriched pricing and a rebuilt benchmark catalog.
- The main tables below preserve the pre-change picks and quality top-10 lists from those snapshots. The addendum reports the post-change creative-writing and chat results. The top-10 is the eligible quality ranking; some use cases have fewer than ten eligible models.
- Artificial Analysis (`AA`) scores are the AA fields in the local benchmark snapshot, filtered to entries marked open-weight and sorted by the corresponding score. They are the same benchmark feed the recommender consumes, not an independent retest. The separate AA Coding Agent Index v1.5 combines DeepSWE v1.1, Terminal-Bench 4.0, and SWE-Atlas-QnA; its visible chart compares configured coding agents as well as underlying models, so it is a different construct from our model-only `agentic_index` and `coding_index`. The page has no open-weight filter; chart/model-family matches below are filtered against our local open-weight tags. [6]
- LMArena positions are dated board ranks and reflect pairwise human preference, not necessarily benchmark accuracy. OpenRouter category positions are token-usage/adoption ranks, not quality ranks. These are different constructs and are evidence for comparison, not interchangeable score inputs.
- Model-family matches below collapse endpoint variants such as `:batch` when discussing outside boards. The full internal IDs are retained in our lists. A family-level match is not a claim that two endpoints have identical price, latency, or provider quality.
- The stability counts are deterministic, one-input-family-at-a-time perturbations of the two local snapshots; they are not probability estimates or confidence intervals. For each listed pick, the denominator includes every benchmark-weight perturbation, provider-weight perturbation, floor perturbation, and mix alternative for that use case. Provider stability is reported both across all scenarios (using each scenario's selected best-quality model) and in a decomposed provider-only check that holds the baseline best-quality model fixed and tests provider-weight and mix alternatives. A pick is stable at ≤10% changed scenarios, moderately stable at >10% through 35%, and a close call above 35%.

## Use-case comparisons

### Agentic coding

| Check | Finding |
|---|---|
| Picks (quality / value / cheapest above floor) | `glm-5.3` / `glm-5.3-flash` / `mimo-v2.5` |
| Our eligible quality top-10 | `glm-5.3`, `glm-5.3-flash`, `kimi-k3`, `kimi-k3-fast`, `qwen3.8-2.4t-a95b`, `glm-5.2`, `deepseek-v4-pro-0813`, `qwen3.8-27b`, `deepseek-v4-flash-0731`, `deepseek-v4-pro` |
| Outside leaders | AA `agentic_index` open-weight leaders in the local snapshot: GLM-5.3 (53.1), GLM-5.3 Flash (50.9), Kimi K3 (50.0). On AA's separate Coding Agent Index chart, the visible rows matching our locally tagged open-weight families include OpenCode + GLM-5.3 (54, chart rank #11) and Kimi Code CLI + Kimi K3 (52, #12); the chart ranks configured agents, not bare models, and has no open-weight filter. LMArena Coding: Kimi K3 #9 and MiMo-V2.6-Pro #10 among the reported open-weight leaders. OpenRouter Programming: GLM-5.3 Flash #5, GLM-5.3 #7, DeepSeek V4 Flash #8. [1][2][3][6] |
| Agreement / disagreement | Our first two picks are the top two on the local AA `agentic_index`; all three local AA agentic leaders appear in our top-10. OpenRouter usage also includes both GLM families near the top. The floor pick MiMo-V2.5 is not one of those leaders. The separate AA Coding Agent Index includes GLM-5.3 and Kimi K3, but those configured-agent ranks do not validate our model-only ranking; GLM-5.3 Flash is not among its visible chart rows. These differences reflect different benchmark mixes and agent harnesses, while the floor pick disagreement also reflects our price-first selection after an absolute quality gate. |
| Sensitivity | Quality `0/21` stable; value `1/21` stable; cheapest-above-floor `2/21` stable. Selected model's #1 provider: Neuralwatt changed `3/21` (moderately stable); holding baseline model fixed, provider/mix changes switched it `11/11` (close call). |
| Mix | **Assumed:** input 2.5% / cache-read 97% / output 0.5%. Published agent-cache hit rates do not establish this token-share mix. |

### Tool-using agents

| Check | Finding |
|---|---|
| Picks (quality / value / cheapest above floor) | `glm-5.3` / `glm-5.3-flash` / `deepseek-v4-flash-0731` |
| Our eligible quality top-10 | `glm-5.3`, `glm-5.3-flash`, `kimi-k3`, `kimi-k3-fast`, `qwen3.8-2.4t-a95b`, `deepseek-v4-pro-0813`, `qwen3.8-27b`, `deepseek-v4-flash-0731`, `glm-5.2`, `deepseek-v4-pro` |
| Outside leaders | AA `agentic_index`: GLM-5.3 (53.1), GLM-5.3 Flash (50.9), Kimi K3 (50.0). OpenRouter Programming's leading open-weight usage rows include DeepSeek V4.1 Flash #2, MiMo-V2.6 Flash #3, GLM-5.3 Flash #5, GLM-5.3 #7, and DeepSeek V4 Flash #8. [1][3] |
| Agreement / disagreement | The quality and value picks align with the first two AA agentic leaders; all three appear in our top-10. OpenRouter usage supports the visibility of the GLM/DeepSeek families but measures adoption, not tool-call success. The category does not have an exact public board for our configured tool-loop workload. |
| Sensitivity | Quality `0/21` stable; value `1/21` stable; cheapest-above-floor `1/21` stable. Selected model's #1 provider: Friendli changed `3/21` (moderately stable); holding baseline model fixed, provider/mix changes switched it `11/11` (close call). |
| Mix | **Assumed:** input 5% / cache-read 90% / output 5%. |

### Long-context RAG

| Check | Finding |
|---|---|
| Picks (quality / value / cheapest above floor) | `deepseek-v4-pro` / `glm-5.3-flash` / `deepseek-v4-flash-0731` |
| Our eligible quality top-10 | `deepseek-v4-pro`, `glm-5.3`, `glm-5.3-flash`, `kimi-k3`, `kimi-k3-fast`, `qwen3.8-2.4t-a95b`, `minimax-m3`, `glm-5.2`, `deepseek-v4-pro-0813`, `deepseek-v4-flash-0731` |
| Outside leaders | The AA-LCR leaderboard's visible open-weight leader is Kimi K3 (88.7) on the BenchLM mirror; this is a secondary mirror, not an AA-hosted page. AA broad Intelligence open-weight leaders are MiMo-V2.6-Pro (46.3), GLM-5.3 (44.8), Kimi K3 (43.6) in our AA-sourced snapshot. No comparable public RAG/retrieval board was captured. [1][4] |
| Agreement / disagreement | The broad AA proxy top-10 overlaps our ranking at GLM-5.3 and Kimi K3; Kimi K3 is #1 on the secondary LCR board but only #4 internally. None of our three picks is Kimi K3. This is a real ranking difference but not enough to conclude the picks are wrong: the engine has no dedicated retrieval-accuracy signal, and the LCR mirror is not independent. The current ranking is mainly a broad-capability proxy. |
| Sensitivity | Quality `4/23` moderately stable (all switches to `glm-5.3`); value `1/23` stable; cheapest-above-floor `1/23` stable. Selected model's #1 provider: DeepInfra changed `4/23` (moderately stable); holding baseline model fixed, provider/mix changes switched it `11/11` (close call). |
| Mix | **Assumed:** input 8% / cache-read 87% / output 5%. Public agent-cache hit-rate evidence does not provide RAG's token-share distribution. |

### Structured extraction

| Check | Finding |
|---|---|
| Picks (quality / value / cheapest above floor) | `deepseek-v4-pro` / `minimax-m3` / `deepseek-v4-flash-0731` |
| Our eligible quality top-10 | `deepseek-v4-pro`, `kimi-k2.6`, `glm-5.2`, `minimax-m3`, `deepseek-v4-flash`, `kimi-k2.7-code`, `qwen3.6-27b` (7 eligible models) |
| Outside leaders | No directly comparable schema-adherence/extraction leaderboard was found in the reviewed sources. The broad AA Intelligence leaders are MiMo-V2.6-Pro, GLM-5.3, and Kimi K3, but that index is only a proxy for extraction. [1] |
| Agreement / disagreement | **Evidence gap, not a validated disagreement.** None of the broad AA top three appears in our seven-model ranking, but broad intelligence is not structured extraction, and no outside source here measures schema validity or extraction exactness. The current 40% LiveBench instruction-following + 25% data-analysis weighting is a reasoned proxy, not a directly validated recipe. |
| Sensitivity | Quality `1/21` stable; value `3/21` moderately stable (all switches to `kimi-k2.6`); cheapest-above-floor `0/21` stable. Selected model's #1 provider: DeepInfra changed `1/21` (stable); holding baseline model fixed, provider/mix changes switched it `11/11` (close call). |
| Mix | **Assumed:** input 25% / cache-read 65% / output 10%. |

### High-volume, low-cost

| Check | Finding |
|---|---|
| Picks (quality / value / cheapest above floor) | `glm-5.3:batch` / `glm-5.3-flash:batch` / `gpt-oss-120b` |
| Our eligible quality top-10 | `glm-5.3:batch`, `glm-5.3`, `kimi-k2.6`, `kimi-k3`, `kimi-k3:batch`, `kimi-k3-fast`, `glm-5.3-flash:batch`, `glm-5.3-flash`, `qwen3.8-2.4t-a95b`, `deepseek-v4-pro` |
| Outside leaders | AA broad Intelligence open-weight leaders: MiMo-V2.6-Pro, GLM-5.3, Kimi K3. OpenRouter Programming includes GLM-5.3 Flash #5, GLM-5.3 #7, and GLM-5.2 #9 by category token volume. [1][3] |
| Agreement / disagreement | Partial agreement: the AA leaders GLM-5.3 and Kimi K3 are in our top-10; both GLM families selected for the first two picks also rank highly in OpenRouter Programming usage. Usage does not validate the 70/20/10 input/cache/output mix or establish cheapest-at-quality. `:batch` changes serving mode/pricing, not the evidence that the GLM model family is capable. |
| Sensitivity | Quality `3/19` moderately stable (all switches to `kimi-k2.6`); value `0/19` stable; cheapest-above-floor `2/19` moderately stable. Selected model's #1 provider: SiliconFlow changed `3/19` (moderately stable); holding baseline model fixed, provider/mix changes switched it `11/11` (close call). |
| Mix | **Assumed:** input 70% / cache-read 20% / output 10%. OpenRouter's category token totals do not disclose this input/cache/output split. |

### Chat assistant

| Check | Finding |
|---|---|
| Picks (quality / value / cheapest above floor) | `deepseek-v4-pro` / `glm-5.3-flash` / `deepseek-v4-flash-0731` |
| Our eligible quality top-10 | `deepseek-v4-pro`, `mimo-v2.6-pro`, `glm-5.3`, `kimi-k3`, `kimi-k3-fast`, `glm-5.3-flash`, `qwen3.8-2.4t-a95b`, `deepseek-v4.1-flash`, `mimo-v2.6-flash`, `deepseek-v4-pro-0813` |
| Outside leaders | LMArena Text's leading open-weight entries were Kimi K3 #16, MiMo-V2.6-Pro #26, and GLM-5.3 Max #27. OpenRouter's category usage also places MiMo-V2.6 Flash #3, GLM-5.3 Flash #5, and DeepSeek V4.1 Flash #2 in Programming, though that is not a chat-only category. [2][3] |
| Agreement / disagreement | The Arena open-weight leaders all appear in our top-10, but our quality pick is DeepSeek V4 Pro rather than those preference leaders. The best-value GLM Flash and cheapest DeepSeek Flash families have high OpenRouter adoption. Arena preference and Programming usage are imperfect proxies for general chat helpfulness; the discrepancy is a reason to decide whether the product means benchmark capability or user preference. |
| Sensitivity | Quality `1/19` stable; value `4/19` moderately stable (three switches to `mimo-v2.6-flash`, one to `deepseek-v4-flash-0731`); cheapest-above-floor `0/19` stable. Selected model's #1 provider: DeepInfra changed `0/19` (stable); holding baseline model fixed, provider/mix changes switched it `11/11` (close call). |
| Mix | **Assumed:** input 60% / cache-read 20% / output 20%. |

### Creative writing

| Check | Finding |
|---|---|
| Picks (quality / value / cheapest above floor) | `deepseek-v4-pro` / `minimax-m3` / `deepseek-v4-flash-0731` |
| Our eligible quality top-10 | `deepseek-v4-pro`, `kimi-k2.7-code`, `minimax-m3`, `glm-5.2`, `kimi-k2.6`, `deepseek-v4-flash`, `qwen3.6-27b` (7 eligible models) |
| Outside leaders | LMArena Creative Writing's leading open-weight entries were Kimi K3 #26, GLM-5.2 Max #32, and GLM-5.3 Max #34. Only the GLM-5.2 family appears in our current top-10; Kimi K3 is absent. AA broad Intelligence leaders are only a non-writing-specific proxy. [1][2] |
| Agreement / disagreement | This is the clearest construct mismatch. Our three picks omit Arena's top open-weight preference model, and the current recipe uses LiveBench language plus broad intelligence rather than a creative-writing preference score. This does not prove Arena is the desired objective, but if “creative writing” means audience preference/style, the current evidence is insufficient and the default is likely misaligned. The sensitivity result below only says this proxy-based ranking is robust to the tested perturbations. |
| Sensitivity | Quality `0/17` stable; value `0/17` stable; cheapest-above-floor `0/17` stable. Selected model's #1 provider: DeepInfra changed `0/17` (stable); holding baseline model fixed, provider/mix changes switched it `11/11` (close call). |
| Mix | **Assumed:** input 35% / cache-read 10% / output 55%. |

### Reasoning and math

| Check | Finding |
|---|---|
| Picks (quality / value / cheapest above floor) | `deepseek-v4-pro` / `deepseek-v4-pro` / `deepseek-v4-flash-0731` |
| Our eligible quality top-10 | `deepseek-v4-pro`, `glm-5.2`, `kimi-k2.6`, `kimi-k2.7-code`, `qwen3.6-27b`, `deepseek-v4-flash`, `minimax-m3` (7 eligible models) |
| Outside leaders | LMArena Math's reported open-weight leaders were GLM-5.3 Flash #13, DeepSeek V4.1 Flash Max #14, and Kimi K3 #16. The internal top-10 has a DeepSeek V4 Flash family entry, but not those exact board model IDs. [2] |
| Agreement / disagreement | Partial/weak family-level overlap through DeepSeek Flash, but the exact external model is a different version. Our ranking's math signal is more direct (LiveBench math 50% plus reasoning 25%) than broad AA, while Arena measures preference on its math prompts. The second pick duplicates best quality because the current Pareto frontier contains only one model; it is not independent corroboration. |
| Sensitivity | Quality `0/21` stable; value `0/21` stable; cheapest-above-floor `0/21` stable. Selected model's #1 provider: DeepInfra changed `0/21` (stable); holding baseline model fixed, provider/mix changes switched it `11/11` (close call). |
| Mix | **Assumed:** input 25% / cache-read 15% / output 60%. |

### Frontend and UI development

| Check | Finding |
|---|---|
| Picks (quality / value / cheapest above floor) | `kimi-k3` / `glm-5.3-flash` / `deepseek-v4-flash-0731` |
| Our eligible quality top-10 | `kimi-k3`, `kimi-k3-fast`, `glm-5.3`, `glm-5.2`, `glm-5.3-flash`, `kimi-k2.6`, `glm-5.1`, `kimi-k2.7-code`, `mimo-v2.5-pro`, `deepseek-v4-flash-0731` |
| Outside leaders | LMArena WebDev open-weight leaders include Kimi K3 #13, GLM-5.3 Max #20, and DeepSeek V4.1 Flash Max #21. AA `coding_index` open-weight leaders are Kimi K3 (76.2), GLM-5.3 (74.8), and GLM-5.3 Flash (71.5). OpenRouter Programming includes GLM-5.3 Flash #5, GLM-5.3 #7, DeepSeek V4 Flash #8. [1][2][3] |
| Agreement / disagreement | Good family-level alignment: Kimi K3 is our quality pick and AA coding leader; both GLM families are prominent in our top-10 and OpenRouter usage. The exact LMArena board versions differ from our endpoint IDs; its Kimi K3 preference rank directly supports the top pick. |
| Sensitivity | Quality `0/21` stable; value `0/21` stable; cheapest-above-floor `2/21` stable. Selected model's #1 provider: Fireworks changed `0/21` (stable); holding baseline model fixed, provider/mix changes switched it `0/11` (stable). |
| Mix | **Assumed:** input 35% / cache-read 15% / output 50%. |

## Cross-cutting conclusions and proposed defaults

1. **Do not silently retune weights or floors from these cross-source ranks.** AA capability indexes, Arena pairwise preference, and OpenRouter token adoption answer different questions. The current report does not establish a common scale or product objective from which new numeric weights/floors can be calculated.
2. **Baseline conclusion (superseded by the revised addendum):** creative writing was the strongest candidate for a preference signal because its earlier recipe had no direct human-preference measurement. The current recipe uses Arena Creative Writing at 75% with AA intelligence at 25% and calibrates the floor to the observed eligible-cohort p25; that threshold remains descriptive and may move with the published snapshot.
3. **Long-context RAG and structured extraction need task-specific evidence.** Add retrieval/long-context and schema-adherence results before changing the current broad proxies. The LCR comparison is a secondary mirror and the reviewed sources did not provide a direct extraction board.
4. **Provider selections are more sensitive than model picks when provider weights are isolated.** Holding the baseline best-quality model fixed, eight use cases changed the #1 provider in all 11 provider-weight/mix scenarios; frontend/UI changed in 0/11. When the selected model is allowed to change too, the overall provider changed in 0–4 scenarios out of 17–23. Keep both measures distinct: the former diagnoses provider-weight sensitivity; the latter answers how often the final recommendation changes under all tested inputs. Provider preferences should be communicated as contingent on the currently published 30-minute performance, uptime, and price snapshot.
5. **All nine token mixes remain assumed.** The reviewed OpenRouter category page exposes aggregate token usage, not per-use-case input/cache-read/output shares. The agentic-usage study reports cache-hit rates (about 90% within turns and 55% across boundaries) but not the volume shares needed to derive these mixes. Do not convert cache hit rate to cache-read token percentage. [5]

| Use case | Current input / cache-read / output | Evidence status |
|---|---:|---|
| Agentic coding | 2.5 / 97 / 0.5% | Assumed |
| Tool-using agents | 5 / 90 / 5% | Assumed |
| Long-context RAG | 8 / 87 / 5% | Assumed |
| Structured extraction | 25 / 65 / 10% | Assumed |
| High-volume, low-cost | 70 / 20 / 10% | Assumed |
| Chat assistant | 60 / 20 / 20% | Assumed |
| Creative writing | 35 / 10 / 55% | Assumed |
| Reasoning and math | 25 / 15 / 60% | Assumed |
| Frontend and UI development | 35 / 15 / 50% | Assumed |

## Open questions

1. **Resolved 2026-10-04:** chat retains benchmark capability as its primary ranking and exposes Arena Text preference separately; creative writing uses Arena creative-writing preference as its primary benchmark signal.
2. Should quality floors remain absolute benchmark-score cutoffs, or should the product define them by a use-case-specific acceptance test/cohort percentile? An outside leaderboard rank is not a calibrated pass threshold.
3. Can TokenWatch collect or publish representative per-use-case input, cache-read, and output token shares? Until then, the mixes should stay explicitly labeled as assumptions.
4. Is the `confidence` label intended to mean only score-margin closeness, or should the UI also display the separate perturbation stability counts (especially for provider rank, which is frequently scenario-sensitive)?
5. What is the acceptable freshness window for provider telemetry before a recommendation should be marked stale or lower-confidence? The current provider comparison includes OpenRouter's 30-minute latency/throughput window and 30-minute uptime where available, but external cross-checks cannot define an appropriate product threshold.

## Sources

1. [Artificial Analysis — open models and benchmark data](https://artificialanalysis.ai/models/open-source); local AA data fields and snapshot metadata are in [`public/benchmarks.json`](../../public/benchmarks.json). [Artificial Analysis — Coding Agent Index](https://artificialanalysis.ai/agents/coding-agents), methodology description for its v1.5 board.
2. LMArena dated leaderboards: [Text](https://lmarena.ai/leaderboard/text), [Coding](https://lmarena.ai/leaderboard/code), [Creative Writing](https://lmarena.ai/leaderboard/creative-writing), [Math](https://lmarena.ai/leaderboard/math), and [WebDev](https://lmarena.ai/leaderboard/webdev). Ranks quoted above are the Oct. 1–2, 2026 snapshots; positions can move as votes arrive.
3. [OpenRouter Programming collection](https://openrouter.ai/collections/programming) and [Programming rankings](https://openrouter.ai/rankings?category=programming&view=trending), observed in October 2026. Rankings use token volume for a recent rolling period and should be read as adoption, not quality. Only ranks exposed by the retrieved page text are quoted.
4. [BenchLM — AA-LCR leaderboard](https://benchlm.ai/benchmarks/lcr), a secondary mirror of the long-context benchmark; Kimi K3's visible open-weight score was 88.7. This is not an independent reproduction.
5. [Agentic usage telemetry study](https://arxiv.org/abs/2608.00101), July 2026; 3.2M users, 13M sessions, 761M calls, and 95T tokens. Its cache-hit statistics do not reveal input/cache-read/output volume shares for these nine TokenWatch workloads.
6. [Artificial Analysis — Coding Agent Index](https://artificialanalysis.ai/agents/coding-agents), v1.5 methodology and visible agent/model chart, retrieved 2026-10-04. Chart labels and plotted scores were read from the rendered page; open-weight family matches use TokenWatch's local open-weight tags rather than a page-provided filter.
7. [Arena — official leaderboard dataset](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset) and [CC BY 4.0 license](https://creativecommons.org/licenses/by/4.0/). The selected `text_style_control` categories are Text Arena overall and creative writing; the latest published rows in the 2026-10-04 cache are dated 2026-10-02.

For repeatable local sensitivity counts, run `node scripts/recommender-sensitivity.mjs`; the script also supports `--json` for machine-readable output.
