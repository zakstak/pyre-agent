#!/usr/bin/env bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
# Fixture repositories must not inherit the hook's Git directory or index.
while IFS= read -r git_variable; do
  unset "$git_variable"
done < <(git rev-parse --local-env-vars)
cd "$repo_root"
exec python3 -m unittest discover -s tests
