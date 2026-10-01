# slashloop-skills

Install the [Slashloop](https://github.com/man0l/slashloop) agent skills into Codex, Claude, or another directory-based skills root. The package contains only Markdown skills and this small dependency-free installer; MCP tools remain on the remote Slashloop server.

## Install

```bash
# Codex personal skills ($CODEX_HOME/skills, or ~/.codex/skills)
npx slashloop-skills install --codex

# Claude personal skills ($CLAUDE_CONFIG_DIR/skills, or ~/.claude/skills)
npx slashloop-skills install --claude

# One skill
npx slashloop-skills install slashloop --codex

# An explicit target for any compatible agent
npx slashloop-skills install slashloop-gallery --target "$CODEX_HOME/skills"
```

`install` with no skill names installs every bundled skill. `--all` is also accepted.

## Other commands

```bash
npx slashloop-skills list
npx slashloop-skills where slashloop-gallery --codex
npx slashloop-skills install slashloop-gallery --codex --dry-run
npx slashloop-skills uninstall slashloop-gallery --codex
```

## Publish a new package version

1. Update `skills/*/SKILL.md`.
2. Run `node packages/slashloop-skills/scripts/sync-skills.js`.
3. Commit the refreshed snapshot.
4. Set the package version in `packages/slashloop-skills/package.json`.
5. Authenticate npm and publish:

   ```bash
   npm login
   npm run publish:skills
   ```

   The last command is the repository’s `scripts/publish-skills.sh`.

CI can publish from a `slashloop-skills-v*` tag when the repository has an `NPM_TOKEN` secret with permission for the `slashloop-skills` package.
