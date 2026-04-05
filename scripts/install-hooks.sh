#!/bin/bash
# Install git hooks. Called automatically via `npm install` (prepare script).

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
  echo "install-hooks: not inside a git repo, skipping"
  exit 0
fi

HOOKS_SRC="$(cd "$(dirname "$0")/hooks" && pwd)"
HOOKS_DST="$REPO_ROOT/.git/hooks"

cp "$HOOKS_SRC/pre-commit" "$HOOKS_DST/pre-commit"
chmod +x "$HOOKS_DST/pre-commit"
echo "✓ Git pre-commit hook installed (prevents accidental key/token commits)"
