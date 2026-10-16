#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)/packages/review-canvas"
pnpm typecheck
pnpm build
pnpm test
node "$(git rev-parse --show-toplevel)/tests/check_typescript_examples.cjs" node_modules/tsc-rs/lib/tsc.js
