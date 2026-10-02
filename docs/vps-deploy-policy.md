# VPS deploy policy (CEO-mandated, 2026-09-27)

Binding on every agent that touches the Contabo VPS (`157.173.195.4`).
Set after SLA-15: a bespoke side-override compose file on the VPS was
rejected — the model below is the ONLY way.

1. **Everything via `docker-compose.prod.yml` (salonease repo) + GitHub
   Actions.** Service images are built in GitHub Actions and referenced
   by tag in compose prod (e.g. `ghcr.io/man0l/slashloop-queue-api:master`
   via `build-queue-api-image.yml`; DB/sidecars use stock images).
   Never `docker build` on the VPS. Never add a second `-f` override file
   on the VPS. Never `docker run` long-lived containers by hand.
2. **The only "deploy" job on the VPS is `git pull` (+ `.env` vars if
   needed).** Commit the change to the repo, push, then on the VPS:
   `git pull --ff-only`, then
   `docker compose -f docker-compose.prod.yml up -d <services>`.
   Interpolation vars live in the project `.env` (`/root/salonease/.env`,
   mode 600, never committed) — never pass `--env-file`: it shadows
   `.env` and breaks other services' interpolation.
3. **Before pulling, check `git status`:** the VPS working tree can hold
   legitimate server edits (precedent: `paperclip/codex-home` mount).
   Preserve them — fold into the repo commit first, then pull.
4. **Secrets live ONLY on the host** (`/root/salonease/<svc>/`, mode 600:
   `.env` files + compose `secrets.file` absolutes). Never committed,
   never pasted in chat/comments, never baked into images.
5. **Two repos, one host:** queue API code + its fragment mirror live in
   `slashloop` (`deploy/queue-compose.fragment.yml`); the DEPLOYED
   services live in `salonease/docker-compose.prod.yml`. Mirror changes
   both ways and say so in the commit.
6. **Host paths in compose are `/root/salonease/...` absolutes** where a
   bind mount is needed (relative sources resolve from the project dir;
   a missing source mounts as an empty directory).
7. **Proving it still works after any compose change:** `config --quiet`,
   container health, `GET /healthz` → 200, unsigned `POST /v1/jobs` → 401.
   Full signed-enqueue gate only when auth/env changed.
8. **Enforcement (not just convention), live since SLA-332:** salonease
   `.github/workflows/validate-compose.yml` +
   `.github/scripts/assert-compose.py` run on **every pull request** and on
   **every push to master**. Two steps: `docker compose -f
   docker-compose.prod.yml config --quiet` (the file is still valid compose),
   then `python3 .github/scripts/assert-compose.py --self-test` — which also
   re-runs the assertions against 21 deliberately broken copies of the file,
   so a guard that stops biting fails the build too, and against 3 legitimate
   ones that must stay accepted, so the gate cannot pass by being noisy.
   They fail on: any service on a `ghcr.io/man0l/*` image with a mutable tag
   that is not watchtower-managed (see below); a published host port (or
   changed `expose`) on `queue-db`/`queue-api`; a
   `queue-api` image off `ghcr.io/man0l/slashloop-queue-api:master`, or a
   `build:` block on any queue service; a Traefik router rule that is not
   byte-identical to the expected allowlist, or that appears twice; a moved or
   missing `slashloop-queue/db_password` secret file, or `queue-api`
   credentials inlined instead of interpolated from the host `.env`; changed
   pgdata/backup volume mounts, `queue-db`/`queue-api` healthchecks, or
   CPU/memory ceilings; `queue-api`/`queue-backup` no longer waiting for a
   **healthy** `queue-db`. Read-only — `permissions: contents: read`, no
   secrets, and it reads only the committed compose file, never the VPS
   `.env`. So a green check answers "this file still says what it must say",
   which is the "will it work" answer for the compose *edit*. (Until SLA-332
   this rule described files that did not exist: `master` had only
   `main.yaml` and no `.github/scripts/`, so "green" meant "GitGuardian
   ran". If you ever find the workflow absent again, treat that as a
   regression and say so.)
   - **Watchtower coverage is swept, not enumerated.** watchtower runs
     `--label-enable`, so it updates ONLY containers labelled
     `com.centurylinklabs.watchtower.enable=true`. Any service on a
     `ghcr.io/man0l/*` image with a mutable tag and no such label is silently
     never updated: merges go green and stay dead in prod. That is SLA-330
     (4 days), and it is not queue-specific — so the gate sweeps every service
     in the file rather than listing them, because a service added tomorrow is
     covered by the same rule today. In scope: `ghcr.io/man0l/*` on
     `master`/`main`/`latest`/`edge`/`dev`. Out of scope: third-party images
     (nobody rebuilds them here) and images on a pinned tag (nothing
     overwrites them in place). Opting out is `UNMANAGED_BY_DESIGN` in the
     script, currently empty — adding an entry is a reviewed diff with a
     stated reason, never a service quietly going un-managed.
9. **What that gate does NOT cover — do not read green as "deployed":**
   - **VPS-local drift:** missing host secret files, untracked or hand-edited
     files on the box. `git status` on the VPS before pull (§3).
   - **The Salonease services** in the same compose file: beyond the
     watchtower sweep, no invariants are asserted on them. `config --quiet`
     only proves they parse.
   - **The other repo:** a green check in *this* repo says nothing about
     `salonease/docker-compose.prod.yml`, and vice versa. Queue service
     config has one source (§5); the gate for it lives over there.
   - **Runtime behaviour:** after any compose change, still do §7 —
     container health, `GET /healthz` → 200, unsigned `POST /v1/jobs` → 401.
