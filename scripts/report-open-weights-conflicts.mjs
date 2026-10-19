/** Called by actions/github-script after a refresh fetch; keeps one tracking issue in sync. */
import { canonicalId } from '../shared/normalize.mjs';

export const ISSUE_MARKER = '<!-- tokenwatch-open-weights-conflicts -->';
const ISSUE_TITLE = 'Open-weights conflicts need reviewed overrides';

/** Canonical models whose models.dev sources disagree and lack a reviewed override. */
export function findUnreviewedConflicts(pricing, overrides) {
  const byCanonical = new Map();
  for (const model of pricing.models || []) {
    for (const source of [model.modelsdev, model.modelsdev_model]) {
      if (typeof source?.open_weights !== 'boolean') continue;
      const id = canonicalId(model.id);
      if (!byCanonical.has(id)) byCanonical.set(id, []);
      byCanonical.get(id).push({ offering: model.id, provider: model.provider || null, open_weights: source.open_weights });
    }
  }
  const conflicts = [];
  for (const [id, sources] of byCanonical) {
    if (new Set(sources.map(s => s.open_weights)).size < 2) continue;
    const lookupId = id.replace(/(:batch|-turbo|-fast)$/i, '');
    const override = overrides[id] || overrides[lookupId];
    if (typeof override?.open_weights !== 'boolean') conflicts.push({ id, sources });
  }
  return conflicts.sort((a, b) => a.id.localeCompare(b.id));
}

export function renderIssueBody(conflicts, runUrl) {
  const rows = conflicts.map(({ id, sources }) => {
    const detail = sources.map(s => `${s.provider ?? '?'} \`${s.open_weights}\``).join(', ');
    return `| \`${id}\` | ${detail} |`;
  });
  return `${ISSUE_MARKER}\nmodels.dev reports conflicting \`open_weights\` values for these canonical models, `
    + 'and `data/open-weights-overrides.json` has no reviewed entry for them. '
    + 'Until one is added they resolve by strict majority, or to unknown on a tie. '
    + 'Refreshes are not blocked; PR CI fails until overrides are added.\n\n'
    + '| Canonical model | Sources |\n|---|---|\n'
    + `${rows.join('\n')}\n\nLast checked by [workflow run](${runUrl}).`;
}

export async function reportOpenWeightsConflicts({ github, context, conflicts }) {
  const run = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...context.repo, state: 'open', per_page: 100,
  });
  const existing = issues.find(issue => !issue.pull_request && issue.body?.includes(ISSUE_MARKER));
  if (!conflicts.length) {
    if (existing) {
      await github.rest.issues.createComment({
        ...context.repo, issue_number: existing.number,
        body: `Every open-weights conflict now has a reviewed override ([workflow run](${run})).`,
      });
      await github.rest.issues.update({ ...context.repo, issue_number: existing.number, state: 'closed' });
    }
    return;
  }
  const body = renderIssueBody(conflicts, run);
  if (existing) {
    // Edit in place rather than commenting every two hours.
    await github.rest.issues.update({ ...context.repo, issue_number: existing.number, body });
  } else {
    await github.rest.issues.create({ ...context.repo, title: ISSUE_TITLE, body });
  }
}
