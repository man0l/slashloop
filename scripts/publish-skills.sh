#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
package="$root/packages/slashloop-skills"

# Use the Node executable that started this lifecycle for both skill syncing and
# publishing. Plain `node` and `npm` can resolve to an incompatible Windows/Bun
# shim in mixed Windows/WSL shells even though the parent `npm run` is healthy.
node_bin="${npm_node_execpath:-}"
npm_cli="${npm_execpath:-}"

if [[ -z "$node_bin" || -z "$npm_cli" ]]; then
  echo "publish:skills must be run through npm so the parent Node/npm paths are available." >&2
  exit 1
fi

# Windows npm can launch WSL Bash. Its executable path must be translated before
# WSL can start the same healthy Node executable; the npm CLI path stays in
# Windows form because that Node executable understands Windows paths.
if [[ "$node_bin" =~ ^([A-Za-z]):[\\/](.+)$ ]] && grep -qi microsoft /proc/version 2>/dev/null; then
  drive="${BASH_REMATCH[1],,}"
  windows_path="${BASH_REMATCH[2]//\\//}"
  node_bin="/mnt/$drive/$windows_path"
fi

cd "$package"
"$node_bin" ./scripts/sync-skills.js

if ! git -C "$root" diff --exit-code -- packages/slashloop-skills/skills >/dev/null; then
  echo "Bundled skills are stale. Commit packages/slashloop-skills/skills after syncing." >&2
  exit 1
fi

exec "$node_bin" "$npm_cli" publish "$@"
