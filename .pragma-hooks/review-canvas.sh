#!/usr/bin/env bash
set -euo pipefail
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root/packages/review-canvas"
pnpm typecheck
pnpm build
pnpm test
node "$repo_root/tests/check_typescript_examples.cjs" node_modules/tsc-rs/lib/tsc.js
