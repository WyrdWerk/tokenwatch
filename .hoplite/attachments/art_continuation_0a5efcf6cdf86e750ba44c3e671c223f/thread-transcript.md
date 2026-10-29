# Previous thread transcript

Source thread: Revise Coral Bricks Model Pricing
Source thread ID: thr_bd84d776ec1047ea80da4215c67fc9b8
Created: 2026-10-28T20:02:57.715Z

This transcript contains only user and agent messages. Tool details and hidden reasoning were excluded.

## User

https://www.coralbricks.ai/models
We need to revise Coral Brick's pricing. The previous pricing is no longer applicable. It's not publicly applicable, so we'll have to revise it.

You can probably use this website for now. We'll see if anything needs to be worked on the API key side. We might have to drop the API key, I think it's being sourced from API key, right? We might have to drop it entirely and replace it with this.

For now, you can just create this website and set it up to get this done. You can work end-to-end with testing and auto-fixing the PR, so that I only need to merge the PR. That's it.

## Agent

PR #58 is open and ready for you to merge: https://github.com/WyrdWerk/tokenwatch/pull/58. CI passed, GitHub reports no merge conflicts, and auto-fix is on, so any later failing checks or review comments will bring me back to the PR.

## What changed
Coral Bricks prices now come from `https://www.coralbricks.ai/api/public/models`. That's the data https://www.coralbricks.ai/models loads, and it needs no key. You were right that pricing came from the API key before. The key is no longer used for pricing.

- **`scripts/lib.mjs`:** the parser reads only the public data. I removed the code that fetched prices with the key and its fallback logic.
- **`scripts/fetch-pricing.mjs`:** the Coral Bricks entry is now just the public URL, the same no-key setup Batchrate uses.
- **Cache reads** now use Coral Bricks' published price. Before, they were counted as free.
- **Cache writes** still cost the input price plus the listed surcharge. Coral Bricks' pricing page still says "Cache writes pay input plus the listed surcharge", and that surcharge is currently $0.
- **Workflows:** I removed `CORAL_API_KEY` from the two steps that fetch prices, in `refresh-pricing.yml` and `refresh-aa.yml`.
- **Tests:** the test data is a fresh copy of the live endpoint. The workflow test now fails if a price-fetching step is given the key.
- **Docs:** `README.md` and `AGENTS.md` now describe the public source.

## Verification
- **CI:** the `test` check passed on the commit the PR points to (`4ebccd6`).
- **Local `npm test`:** 885 tests; 877 passed, 0 failed, 8 skipped. I ran it before and after the doc edits.
- **Live check:** I ran the new parser against the live endpoint, and it gave the website's prices:

| Model | Input $/1M | Output $/1M | Cache read $/1M |
|---|---|---|---|
| DeepSeek V4.1 Flash Fast (site currently shows $0.01 / $1.20) | 0.45 | 1.80 | 0.009 |
| DeepSeek V4.1 Flash Standard | 0.19 | 0.60 | 0.008 |

**Not verified yet:** the price change on the live site. The generated price file, `public/pricing.json`, can't be edited by hand under the repo's rules. The new prices will appear after the first scheduled two-hourly refresh once you merge.

## Decision for you: removing the key entirely
I kept `CORAL_API_KEY` for one thing: Coral Bricks speed data (decode speed, time to first token and cache-hit rate). The public page doesn't publish those numbers. If you remove the GitHub secret, nothing breaks, because the speed step already skips itself with a warning. Coral Bricks speed figures would just stop updating. Tell me if you want it removed completely and I'll do it as a follow-up PR.

## What the public page doesn't provide
- Image-input and tool-calling flags, and the precision label, are now blank rather than guessed.
- Context length shows as 1,000,000 (from the page's "1M") instead of 1,048,576.
- `public/pricing.json` still lists `CORAL_API_KEY` as the key a visitor needs to call Coral Bricks themselves. That comes from models.dev rather than our pricing fetch, so I left it.

## User

All CI checks on PR #58 are green, and there is no new unresolved human review feedback. Perform one final merge-readiness pass.

This automated fix run has a wall-clock work budget ending at 2026-10-28T22:12:56.792Z, followed by a final grace window ending at 2026-10-28T22:27:56.792Z. Commit a coherent fix early instead of deferring the commit until the end; that commit is the durable checkpoint if later work is interrupted. As the work-budget deadline approaches, stop broad exploration, run the narrowest decisive checks, preserve the best safe state in a commit, and finish the turn.

Do source-control work through the shell, exactly as in a user-driven turn: `git` and `gh` are already authenticated in this workspace, and only genuinely dangerous commands are refused (writing the repository's default branch, printing the installation token, merging a pull request). There is no separate source-control tool to call, so never stop on a missing tool: run the equivalent `git` or `gh` command instead.

This pull request's head branch is `hoplite/phanagoria-bd84d776` (base: `main`). Before editing, make sure the workspace is checked out on the head branch — `git fetch origin hoplite/phanagoria-bd84d776` then `git checkout hoplite/phanagoria-bd84d776` when the current branch differs — and commit your fixes there.

Do not merge or close the pull request. If repository changes are still needed, make and verify them now. If nothing remains, state clearly that the PR is ready to merge once the user gives permission.

Before declaring readiness, perform a full internal release audit. Check the diff and relevant repository configuration for: environment variables, runtime secrets, API keys, certificates, credential rotation, database migrations, schema branches, extensions, connection settings, production data backfills, infrastructure and Terraform changes, cloud resources, IAM roles, service accounts, network policies, third-party setup, OAuth, GitHub App permissions, webhooks, feature flags, allowlists, tenant settings, rollout controls, DNS, domains, TLS, CDN behavior, queues, workers, cron jobs, event subscriptions, observability, deployment ordering, one-time commands, permissions, quotas, compatibility, validation, rollback, documentation, and ownership handoff.
Keep that audit internal. In the user-facing conclusion, add a short ‘Before merge’ section only when the audit finds a concrete follow-up introduced by this PR. Group the findings by migrations and configuration, name the affected file or setting, identify who should review it, and say whether it blocks merging or only deployment when that distinction matters. Do not enumerate categories that need no action, speculate about unchanged systems, or turn the result into a release plan. If no follow-up is introduced, say so in one sentence.

## Agent

PR #58 is ready to merge whenever you give the go-ahead: https://github.com/WyrdWerk/tokenwatch/pull/58. I haven't merged or closed it, and this pass found nothing that needed changing.

## Final check results

- **Branch:** the workspace is on `hoplite/phanagoria-bd84d776` with no uncommitted changes. The local and remote heads are both `4ebccd6`, and the branch is up to date with `main` (`9a145c8`).
- **PR state:** open, not a draft, and GitHub reports `MERGEABLE` / `CLEAN`.
- **CI:** the `test` check passed on `4ebccd6`. Locally, `npm test` passed 877 of 885 tests, with 0 failures and 8 skipped.
- **Reviews:** the only review is an automated one from capy-ai, and it says "Capy found no issues." There are no PR comments and no unresolved review threads.
- **Price-change guards:** nothing in the pricing refresh will block Flash Fast's input price moving from $0.01 to $0.45 after merge:
  - The models.dev price-drift report (`scripts/fetch-pricing.mjs:1349`) only writes a step summary. It doesn't block or change prices.
  - `checkCoverageDrop` (`scripts/lib.mjs:1515`) only trips if the total model count drops by more than 15%. Coral Bricks still has two models, so it won't trip.
- **Scope:** the 9 changed files are only workflows, docs, scripts, tests and one test fixture. There are no migrations, infrastructure changes or generated catalogs.

## What happens after merge

The site's catalog updates on the next scheduled two-hourly refresh after you merge. At that point, DeepSeek V4.1 Flash Fast should show $0.45 / $1.80 with a $0.009 cache read, and Flash Standard $0.19 / $0.60 with a $0.008 cache read. Those prices match https://www.coralbricks.ai/models. I can't confirm the live site until that refresh runs.

This PR doesn't need any configuration or deployment steps before or after merge. Keep the `CORAL_API_KEY` repository secret, since the Coral Bricks speed-data steps still use it.

## Still your call

Dropping the key entirely is up to you, and so far I've only removed it from pricing. If you remove it completely, nothing breaks, but Coral Bricks speed figures (decode speed, time to first token, cache-hit rate) stop updating. Tell me if you want that, and I'll do it in a follow-up PR.

## Agent

PR #58 is merged into `main` as `54868a3`, but the site still shows the old Coral Bricks prices. They should update at the next scheduled pricing refresh, around 22:00 UTC. Nothing failed because of this change, so no follow-up fix is needed.

## What the post-merge runs did
- **Scheduled refresh that started 40 seconds before the merge (run 40765264942): failed, but not because of this PR.** It ran on the old commit `9a145c8`, so it produced the old prices anyway. All of its fetch steps worked. It failed at the last step: when it tried to push its catalog commit, `main` already had the merge on it, so GitHub rejected the push (`! [rejected] main -> main (fetch first)`). That's a timing collision, not a problem in the code. Its commit was dropped, which is what we'd want, since it contained the old prices.
- **Run started by the merge (run 40765376465): passed.** `test` passed, `deploy` passed and `refresh` was skipped. The refresh job only runs on scheduled or manual runs (`refresh-pricing.yml:48`), so the skip is expected. The deploy published the new code but used the existing catalog file.

## When the prices change
The catalog on `main` (`public/pricing.json`) still lists DeepSeek V4.1 Flash Fast at $0.01 / $1.20. The pricing workflow runs every two hours (`0 */2 * * *`). Its next run, around 22:00 UTC, is the first one that will use the new code. It should write:

| Model | Input $/1M | Output $/1M | Cache read $/1M |
|---|---|---|---|
| DeepSeek V4.1 Flash Fast | 0.45 | 1.80 | 0.009 |
| DeepSeek V4.1 Flash Standard | 0.19 | 0.60 | 0.008 |

I'm not waiting the roughly 80 minutes to confirm it, so the live prices are still unverified. If you want them sooner, start **Refresh Pricing** by hand from the Actions tab on `main`. My GitHub access can't start workflows.

## Still your call
`CORAL_API_KEY` now only feeds Coral Bricks speed data: decode speed, time to first token and cache-hit rate. If you remove the secret, nothing breaks, but those figures stop updating. Tell me if you want it removed and I'll do it in a follow-up PR.
