#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
package="$root/packages/slashloop-skills"

cd "$package"
node ./scripts/sync-skills.js

if ! git -C "$root" diff --exit-code -- packages/slashloop-skills/skills >/dev/null; then
  echo "Bundled skills are stale. Commit packages/slashloop-skills/skills after syncing." >&2
  exit 1
fi

npm publish "$@"
