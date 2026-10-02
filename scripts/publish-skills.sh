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

# Invoke the npm CLI through the Node executable that started this lifecycle.
# Plain `npm` can resolve to an incompatible Windows/Bun shim in mixed Windows/WSL
# shells even though the parent `npm run` itself is healthy.
node_bin="${npm_node_execpath:-node}"
npm_cli="${npm_execpath:-$(command -v npm)}"

exec "$node_bin" "$npm_cli" publish "$@"
