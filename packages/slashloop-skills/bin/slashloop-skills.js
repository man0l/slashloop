#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundledSkillsDir = join(packageDir, "skills");
const usage = `Slashloop agent skill installer

Usage
  npx slashloop-skills list
  npx slashloop-skills install [skill ...] [options]
  npx slashloop-skills uninstall <skill> [options]
  npx slashloop-skills where [skill] [options]

Skills
  Omit skill names with install to install every bundled skill.

Options
  --target <dir>   Install into an exact skills directory.
  --codex          Use $CODEX_HOME/skills, or ~/.codex/skills by default.
  --claude         Use $CLAUDE_CONFIG_DIR/skills, or ~/.claude/skills by default.
  --project        Use ./.claude/skills in the current project.
  --dry-run        Show what would change without writing files.
  -h, --help       Show this help.
  -v, --version    Show package version.

Examples
  npx slashloop-skills install slashloop
  npx slashloop-skills install --all --codex
  npx slashloop-skills install slashloop-gallery --target ~/.claude/skills
`;

const fail = (message, code = 1) => {
  console.error(`error: ${message}`);
  console.error(usage);
  process.exit(code);
};

const validName = (name) => /^[a-z0-9][a-z0-9-]*$/.test(name);

const bundledSkills = () => {
  if (!existsSync(bundledSkillsDir)) fail(`bundled skills directory is missing: ${bundledSkillsDir}`);
  const names = readdirSync(bundledSkillsDir).filter((name) => {
    try {
      return statSync(join(bundledSkillsDir, name, "SKILL.md")).isFile();
    } catch {
      return false;
    }
  });
  if (names.length === 0) fail("no bundled skills found");
  return names.sort();
};

const defaultTarget = (profile) => {
  if (profile === "codex") {
    return process.env.CODEX_HOME
      ? join(process.env.CODEX_HOME, "skills")
      : join(os.homedir(), ".codex", "skills");
  }
  if (profile === "claude") {
    return process.env.CLAUDE_CONFIG_DIR
      ? join(process.env.CLAUDE_CONFIG_DIR, "skills")
      : join(os.homedir(), ".claude", "skills");
  }
  return resolve(".claude", "skills");
};

const parseArgs = (argv) => {
  const options = { profile: null, target: null, dryRun: false, skills: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--codex") options.profile = "codex";
    else if (arg === "--claude") options.profile = "claude";
    else if (arg === "--project") options.profile = "project";
    else if (arg === "--target") {
      const value = argv[++index];
      if (!value) fail("--target requires a directory");
      options.target = resolve(value);
    } else if (arg === "--all") {
      options.skills = bundledSkills();
    } else if (arg.startsWith("-")) {
      fail(`unknown option: ${arg}`);
    } else {
      if (!validName(arg)) fail(`invalid skill name: ${arg}`);
      options.skills.push(arg);
    }
  }
  return options;
};

const targetFor = (options) => {
  if (options.target && options.profile) fail("use either --target or a profile flag, not both");
  return options.target ?? defaultTarget(options.profile ?? "codex");
};

const selectedSkills = (options, command) => {
  let names = options.skills;
  if (command === "install" && names.length === 0) names = bundledSkills();
  if (command !== "install" && names.length !== 1) fail(`exactly one skill is required for ${command}`);
  for (const name of names) {
    if (!bundledSkills().includes(name)) fail(`unknown skill: ${name}. Run \`slashloop-skills list\``);
  }
  return [...new Set(names)];
};

const installSkill = (name, targetDir, dryRun) => {
  const source = join(bundledSkillsDir, name);
  const destination = join(targetDir, name);
  const action = existsSync(destination) ? "updated" : "installed";
  if (!dryRun) {
    mkdirSync(targetDir, { recursive: true });
    rmSync(destination, { recursive: true, force: true });
    cpSync(source, destination, { recursive: true });
    if (!existsSync(join(destination, "SKILL.md"))) {
      fail(`installation did not produce ${join(destination, "SKILL.md")}`);
    }
  }
  console.log(`${action}: ${name} -> ${destination}`);
};

const command = process.argv[2];

if (!command || command === "-h" || command === "--help" || command === "help") {
  console.log(usage.trim());
  process.exit(command ? 0 : 0);
}

if (command === "-v" || command === "--version" || command === "version") {
  const { createRequire } = await import("node:module");
  console.log(createRequire(import.meta.url)("../package.json").version);
  process.exit(0);
}

if (command === "list") {
  for (const name of bundledSkills()) console.log(name);
  process.exit(0);
}

if (command !== "install" && command !== "uninstall" && command !== "where") {
  fail(`unknown command: ${command}`);
}

const options = parseArgs(process.argv.slice(3));
const targetDir = targetFor(options);
const names = selectedSkills(options, command);

if (command === "where") {
  console.log(join(targetDir, names[0]));
  process.exit(0);
}

if (command === "uninstall") {
  const destination = join(targetDir, names[0]);
  if (options.dryRun) console.log(`would remove: ${destination}`);
  else if (existsSync(destination)) {
    rmSync(destination, { recursive: true, force: true });
    console.log(`removed: ${destination}`);
  } else {
    console.log(`already absent: ${destination}`);
  }
  process.exit(0);
}

for (const name of names) installSkill(name, targetDir, options.dryRun);
if (options.dryRun) console.log(`dry run complete: no files changed`);
else console.log(`done: ${names.length} skill(s) in ${targetDir}`);
