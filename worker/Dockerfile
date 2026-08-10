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

# Lay down the runtime .env AT BUILD TIME, from the BuildKit secret `worker_env`
# (the CI workflow assembles it from GitHub variables + secrets and passes it as
# a secret-file — NOT as an artifact or a git-committed file). Bun auto-loads
# /app/.env at startup. Local/builds-without-the-secret get a placeholder file
# so an env-less build still works (and the smoke test can boot the loop).
RUN --mount=type=secret,id=worker_env \
    if [ -f /run/secrets/worker_env ]; then \
      cp /run/secrets/worker_env /app/.env && \
      echo "# .env baked in at build time from GitHub variables+secrets" >> /app/.env; \
    else \
      echo "# runtime env: supply the 'worker_env' BuildKit secret at build time" > /app/.env; \
    fi

# The queue drainer. No server — it self-polls the MediaJob table.
CMD ["bun", "run", "worker"]
