#!/usr/bin/env node
/**
 * Sync a repo's issue labels to match the canonical config (create/update,
 * and by default prune anything not in the config).
 *
 *   node scripts/labels/sync-labels.mjs --repo owner/repo --config labels.json
 *   node scripts/labels/sync-labels.mjs --repo owner/repo --config labels.json --no-prune
 *
 * Requires: gh auth, issues: write
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    repo: process.env.GITHUB_REPOSITORY || null,
    config: null,
    prune: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo" && argv[i + 1]) args.repo = argv[++i];
    else if (a === "--config" && argv[i + 1]) args.config = argv[++i];
    else if (a === "--no-prune") args.prune = false;
  }
  if (!args.repo) throw new Error("--repo or GITHUB_REPOSITORY required");
  if (!args.config) throw new Error("--config is required");
  return args;
}

function ghJson(args) {
  const out = execFileSync("gh", args, { encoding: "utf8" });
  return JSON.parse(out || "null");
}

function loadDesired(configPath) {
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.labels)) {
    throw new Error(`${configPath} must contain a top-level "labels" array`);
  }
  return parsed.labels;
}

function listExisting(repo) {
  const labels = ghJson(["api", `repos/${repo}/labels`, "--paginate"]);
  return Array.isArray(labels) ? labels : [];
}

function withInputFile(body, fn) {
  const tmp = path.join(
    os.tmpdir(),
    `label-sync-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(tmp, JSON.stringify(body));
  try {
    return fn(tmp);
  } finally {
    fs.unlinkSync(tmp);
  }
}

function createLabel(repo, label) {
  withInputFile(
    {
      name: label.name,
      color: label.color,
      description: label.description || "",
    },
    (tmp) =>
      execFileSync(
        "gh",
        ["api", "-X", "POST", `repos/${repo}/labels`, "--input", tmp],
        { stdio: "inherit" },
      ),
  );
  console.log(`created: ${label.name}`);
}

function updateLabel(repo, currentName, label) {
  withInputFile(
    {
      new_name: label.name,
      color: label.color,
      description: label.description || "",
    },
    (tmp) =>
      execFileSync(
        "gh",
        [
          "api",
          "-X",
          "PATCH",
          `repos/${repo}/labels/${encodeURIComponent(currentName)}`,
          "--input",
          tmp,
        ],
        { stdio: "inherit" },
      ),
  );
  console.log(`updated: ${label.name}`);
}

function deleteLabel(repo, name) {
  execFileSync(
    "gh",
    ["api", "-X", "DELETE", `repos/${repo}/labels/${encodeURIComponent(name)}`],
    { stdio: "inherit" },
  );
  console.log(`deleted: ${name}`);
}

function needsUpdate(current, desired) {
  return (
    current.name !== desired.name ||
    current.color.toLowerCase() !== desired.color.toLowerCase().replace("#", "") ||
    (current.description || "") !== (desired.description || "")
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const desired = loadDesired(args.config);
  const existing = listExisting(args.repo);
  const existingByKey = new Map(existing.map((l) => [l.name.toLowerCase(), l]));
  const desiredKeys = new Set(desired.map((l) => l.name.toLowerCase()));

  for (const label of desired) {
    const current = existingByKey.get(label.name.toLowerCase());
    if (!current) {
      createLabel(args.repo, label);
    } else if (needsUpdate(current, label)) {
      updateLabel(args.repo, current.name, label);
    }
  }

  if (args.prune) {
    for (const label of existing) {
      if (!desiredKeys.has(label.name.toLowerCase())) {
        deleteLabel(args.repo, label.name);
      }
    }
  }

  console.log(JSON.stringify({ ok: true, repo: args.repo, count: desired.length }));
}

main();
