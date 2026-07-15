import path from "node:path";
import fs from "node:fs";
import type { Plugin } from "@opencode-ai/plugin";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SERVER = path.join(REPO_ROOT, "src", "index.ts");
const DB = path.join(REPO_ROOT, "prisma", "slashloop.db");
const ENV_FILE = path.join(REPO_ROOT, ".env");

function loadEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = { ...loadEnvFile(ENV_FILE), ...process.env };

if (!env.GEMINI_API_KEY) {
  console.error("[slashloop] WARNING: GEMINI_API_KEY is not set. Put it in .env — AI tools will fail.");
}
if (!fs.existsSync(DB)) {
  console.error(`[slashloop] WARNING: DB missing at ${DB}. Run: bun run db:push && bun run seed`);
}

export default (async () => ({
  config: (cfg) => {
    cfg.mcp = cfg.mcp ?? {};
    (cfg.mcp as Record<string, unknown>).slashloop = {
      type: "local",
      command: ["bun", SERVER],
      enabled: true,
      env: {
        DATABASE_URL: `file:${DB}`,
        GEMINI_API_KEY: env.GEMINI_API_KEY ?? "",
        APIFY_API_KEY: env.APIFY_API_KEY ?? "",
        APIFY_SPEND_CAP_CENTS: env.APIFY_SPEND_CAP_CENTS ?? "500",
        ...(env.APIFY_CAP_NOTIFICATION_HOOK
          ? { APIFY_CAP_NOTIFICATION_HOOK: env.APIFY_CAP_NOTIFICATION_HOOK }
          : {}),
      },
    };
  },
})) satisfies Plugin;
