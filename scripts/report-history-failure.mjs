/** Called by actions/github-script after a nonblocking snapshot failure. */
export const ISSUE_MARKER = '<!-- tokenwatch-price-history-failure -->';

export async function reportHistoryFailure({ github, context, error, secrets = [] }) {
  let detail = String(error);
  for (const secret of secrets.filter(Boolean)) detail = detail.split(secret).join('[REDACTED]');
  // Keep the final error, and avoid Markdown fences from untrusted log output.
  detail = detail.slice(-12000).replaceAll('```', "'''");
  const run = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
  const body = `${ISSUE_MARKER}\nDaily price-history update failed: [workflow run](${run}).\n\n`
    + 'Normal pricing refresh and deployment are not blocked.\n\n'
    + `\`\`\`text\n${detail}\n\`\`\``;
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...context.repo, state: 'open', per_page: 100,
  });
  const existing = issues.find(issue => !issue.pull_request && issue.body?.includes(ISSUE_MARKER));
  if (existing) {
    await github.rest.issues.createComment({ ...context.repo, issue_number: existing.number, body });
  } else {
    await github.rest.issues.create({ ...context.repo, title: 'Daily price-history updates failing', body });
  }
}
