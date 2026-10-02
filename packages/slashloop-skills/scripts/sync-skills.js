#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(packageDir, "../../skills");
const targetDir = join(packageDir, "skills");

if (!existsSync(sourceDir)) {
  throw new Error(`Missing skill source directory: ${sourceDir}`);
}

const skillNames = readdirSync(sourceDir).filter((name) => {
  if (name.startsWith(".")) return false;
  const skillFile = join(sourceDir, name, "SKILL.md");
  try {
    return statSync(skillFile).isFile();
  } catch {
    return false;
  }
});

if (skillNames.length === 0) {
  throw new Error("No skills with a SKILL.md file were found");
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
for (const name of skillNames) {
  cpSync(join(sourceDir, name), join(targetDir, name), { recursive: true });
}

console.log(`Synced ${skillNames.length} skill(s) into ${targetDir}`);
