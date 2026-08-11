# ---------------------------------------------------------------------------
# VPS worker image — the long-running queue drainer (src/worker/index.ts).
#
# Same queue + codebase as the Vercel worker, but NO 60s ceiling: Apify
# downloads and OpenRouter video analysis (Qwen on full-length clips) can take
# 60s+, which the Vercel Hobby plan kills. This container runs the identical
# claim->process->complete/fail cycle against the same Supabase MediaJob table.
#
# Build:   docker build -t slashloop-worker -f worker/Dockerfile .
# Run:     docker run --env-file worker/.env.worker slashloop-worker
#          (or compose/systemd; WORKER_IDLE_MS controls the poll interval)
# ---------------------------------------------------------------------------

# The repo runs on Bun; use the official slim image with the lockfile.
FROM oven/bun:1.2-slim

WORKDIR /app

# Prisma's query engine needs OpenSSL at runtime; the slim image doesn't ship it.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Install deps first for layer caching (bun.lock drives the install).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Prisma needs its schema + the generated client before the worker can import
# src/db.ts. postinstall already runs `prisma generate`, so a second run here
# is a no-op safety net.
COPY prisma ./prisma
RUN bun run db:generate || true

# The whole source tree (the worker imports across src/ and lib/).
COPY . .

# Lay down the runtime .env AT BUILD TIME. The CI workflow assembles it from
# GitHub variables + secrets and writes it to .worker-env in the build context
# (NOT a BuildKit secret — the docker-container builder can't see the runner's
# filesystem, so secret-files don't reach the build). Bun auto-loads /app/.env
# at startup. Local builds without .worker-env get a placeholder .env.
RUN if [ -f .worker-env ]; then \
      mv .worker-env /app/.env && \
      echo "# .env baked in at build time from GitHub variables+secrets" >> /app/.env; \
    else \
      echo "# runtime env: CI writes .worker-env into the build context" > /app/.env; \
    fi

# The queue drainer. No server — it self-polls the MediaJob table.
#
# Deploy with a stop grace period long enough for one in-flight job: SIGTERM
# only sets a flag the loop checks BETWEEN jobs, and a batched refresh is a
# ~170s scrape plus fan-out across up to 10 sources. `stop_grace_period: 300s`
# in compose (or --stop-timeout 300). The default 10s SIGKILLs a batch that has
# already been billed. See docs/apify-multi-tenant-batching-plan.md §13.3.
STOPSIGNAL SIGTERM
CMD ["bun", "run", "worker"]
