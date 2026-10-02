#!/bin/sh
# ===========================================================================
# queue-backup.sh — nightly pg_dump of queue-db (custom format) + retention.
#
# Runs inside the queue-backup sidecar (see the queue-backup service in
# salonease@docker-compose.prod.yml — the only compose source) as a
# 03:00 cron. Keeps BACKUP_RETENTION_DAYS (default 14) of local dumps in
# /backups; an OFF-HOST copy (host cron rsync to the backup destination in
# the Phase 0 baseline doc) is what survives a full VPS loss.
#
# Restore rehearsal (Phase 1 gate — run in staging before producer cutover):
#   1. Fresh container: docker run -d --name queue-restore-test postgres:17
#   2. pg_restore -h <test> -U postgres -d slashloop_queue \
#        /backups/queue-YYYYmmdd-HHMMSS.dump
#   3. Verify: SELECT count(*), min(created_at) FROM queue_jobs;
#      re-run queue/postgres/001_queue_foundation.sql (idempotent);
#      boot queue-api against the restored DB and GET /readyz.
#   4. Record the result (dump id, row counts, readyz) in the Phase 0
#      baseline doc — Phase 1 is not complete until a restore test proves
#      accepted jobs survive.
#
# Backup-age monitoring: the newest queue-*.dump mtime feeds the
# `slashloop_queue_backup_age_seconds` gauge (see deploy/queue-alerts.yml).
# ===========================================================================
set -eu

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/queue-$STAMP.dump"
export PGPASSWORD="$(cat "${PGPASSWORD_FILE:?missing PGPASSWORD_FILE}")"

mkdir -p "$BACKUP_DIR"
pg_dump -Fc -f "$OUT"

# Verify the dump is restorable-listable before trusting it.
pg_restore --list "$OUT" > /dev/null

# Bounded local retention.
find "$BACKUP_DIR" -maxdepth 1 -name 'queue-*.dump' -mtime +"$RETENTION_DAYS" -delete

echo "queue backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
