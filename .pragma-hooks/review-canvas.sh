#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)/packages/review-canvas"
pnpm typecheck
pnpm build
pnpm test
