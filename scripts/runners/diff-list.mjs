#!/usr/bin/env node
/**
 * Diff runners.json between two git refs; print added (or all changed) repos.
 *
 *   node scripts/runners/diff-list.mjs --base origin/main --head HEAD [--json]
 */
import { execFileSync } from "node:child_process";

function parseArgs(argv) {
  const args = { base: null, head: "HEAD", json: false, file: "runners.json" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base" && argv[i + 1]) args.base = argv[++i];
    else if (a === "--head" && argv[i + 1]) args.head = argv[++i];
    else if (a === "--file" && argv[i + 1]) args.file = argv[++i];
    else if (a === "--json") args.json = true;
  }
  if (!args.base) throw new Error("--base is required");
  return args;
}

function readAt(ref, file) {
  try {
    const raw = execFileSync("git", ["show", `${ref}:${file}`], {
      encoding: "utf8",
    });
    return JSON.parse(raw);
  } catch {
    return { repos: [] };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const before = readAt(args.base, args.file);
  const after = readAt(args.head, args.file);
  const beforeRepos = new Set((before.repos || []).map((r) => r.repo));
  const added = (after.repos || []).filter((r) => !beforeRepos.has(r.repo));
  const payload = {
    added: added.map((r) => r.repo),
    addedEntries: added,
    all: (after.repos || []).map((r) => r.repo),
    count: added.length,
  };
  if (args.json) {
    console.log(JSON.stringify(payload));
  } else {
    console.log(payload.added.join("\n"));
  }
}

main();
