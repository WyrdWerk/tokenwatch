#!/usr/bin/env bash
set -euo pipefail

for attempt in 1 2 3 4; do
  echo "Push attempt $attempt/4"
  if git push; then
    exit 0
  fi
  if [ "$attempt" -eq 4 ]; then
    echo "Push failed after 4 attempts" >&2
    exit 1
  fi
  echo "Push failed; retrying after fetching and rebasing main" >&2
  sleep 10
  git fetch origin main
  if ! git rebase origin/main; then
    echo "Rebase failed; aborting refresh push" >&2
    git rebase --abort || true
    exit 1
  fi
done
