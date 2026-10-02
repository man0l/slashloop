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
5. **Two repos, one host, ONE compose source.** Queue API *code* lives in
   `slashloop` (`src/queue/**`); queue *service config* is deployed from
   `salonease/docker-compose.prod.yml` and nowhere else — per rule 1, there
   is no second `-f` file on the VPS. Edit it there, via a branch + PR.
   Do NOT mirror it into `slashloop`: `deploy/queue-compose.fragment.yml`
   was exactly such a mirror, it was never deployed, and it silently
   drifted until a merged fix sat un-deployed for 4 days (SLA-330). It is
   now a stub that says so. "Mirror changes both ways" was retracted for
   that reason — mirroring had no reader and cost a real outage of trust
   in the deploy path.
6. **Host paths in compose are `/root/salonease/...` absolutes** where a
   bind mount is needed (relative sources resolve from the project dir;
   a missing source mounts as an empty directory).
7. **Proving it still works after any compose change:** `config --quiet`,
   container health, `GET /healthz` → 200, unsigned `POST /v1/jobs` → 401.
   Full signed-enqueue gate only when auth/env changed.
8. **Enforcement (not just convention):** salonease
   `.github/workflows/validate-compose.yml` + `.github/scripts/assert-compose.py`
   run on every compose edit (PR or master push) and fail on: published
   queue ports, non-GHCR queue-api image, changed router rule, missing
   secret file, volumes, healthchecks, or memory budgets. A green check
   on the commit is the "will it work" answer — VPS pulls only green
   master. Residual risk it does NOT cover: VPS-local drift (missing
   secret files, untracked edits) — `git status` on the VPS before pull.
