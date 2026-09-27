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
   `docker compose --env-file <svc>.env -f docker-compose.prod.yml up -d <services>`.
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
