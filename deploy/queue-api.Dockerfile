# ---------------------------------------------------------------------------
# queue-api runtime image — the signed producer boundary (src/queue/server.ts).
#
# Same base as worker/Dockerfile (oven/bun:1.2-slim) so system deps match.
# Listens on $QUEUE_API_PORT (default 4100); never published directly —
# Traefik fronts it on queue.slashloop.dev (see deploy/queue-compose.*).
# ---------------------------------------------------------------------------
FROM oven/bun:1.2-slim

WORKDIR /app

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY prisma ./prisma
RUN bun run db:generate || true

COPY . .

EXPOSE 4100

STOPSIGNAL SIGTERM
CMD ["bun", "src/queue/server.ts"]
