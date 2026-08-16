#!/usr/bin/env node
/**
 * Detect which catalog apps changed between two git refs.
 *
 *   node scripts/detect-changed-apps.mjs --catalog deploy/apps.json --base SHA --head SHA [--scope qa|publish] [--json]
 *
 * Rules (generic):
 *   - Any path matching an app's watchPaths → that app
 *   - Shared triggers (optional --shared-prefix, default deploy/docker/, scripts/, package.json)
 *     → all buildable apps in scope (or all publish apps)
 *   - App-specific compose / dockerfile always counted via watchPaths
 */
import { execFileSync } from "node:child_process";
import { loadCatalog } from "./lib/catalog.mjs";

function parseArgs(argv) {
  const args = {
    catalog: "deploy/apps.json",
    base: null,
    head: "HEAD",
    json: false,
    scope: "publish",
    shared: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--catalog" && argv[i + 1]) args.catalog = argv[++i];
    else if (a === "--base" && argv[i + 1]) args.base = argv[++i];
    else if (a === "--head" && argv[i + 1]) args.head = argv[++i];
    else if (a === "--scope" && argv[i + 1]) args.scope = argv[++i];
    else if (a === "--shared" && argv[i + 1]) {
      args.shared = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--json") args.json = true;
  }
  if (!args.base) throw new Error("--base <ref> is required");
  if (args.scope !== "qa" && args.scope !== "publish") {
    throw new Error('--scope must be "qa" or "publish"');
  }
  if (!args.shared.length) {
    args.shared = [
      "deploy/docker/",
      "scripts/",
      "package.json",
      "package-lock.json",
      ".github/workflows/",
    ];
  }
  return args;
}

function changedFiles(base, head) {
  const out = execFileSync(
    "git",
    ["diff", "--name-only", `${base}...${head}`],
    { encoding: "utf8" },
  );
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function pathHit(file, watch) {
  if (!watch) return false;
  if (watch.endsWith("/")) return file.startsWith(watch) || file === watch.slice(0, -1);
  return file === watch || file.startsWith(`${watch}/`);
}

function detect(files, catalog, scope, sharedPrefixes) {
  const pool = scope === "qa" ? catalog.qaApps : catalog.publishApps;
  const selected = new Set();

  const sharedHit = files.some((f) =>
    sharedPrefixes.some((p) => pathHit(f, p) || f === p || f.startsWith(p)),
  );

  for (const entry of pool) {
    const hit =
      sharedHit ||
      files.some((f) => (entry.watchPaths || []).some((w) => pathHit(f, w)));
    if (!hit) continue;
    // Infra-only apps (image:false) only when their own paths change, not shared docker noise
    if (entry.image === false) {
      const own = files.some((f) =>
        (entry.watchPaths || []).some((w) => pathHit(f, w)),
      );
      if (!own) continue;
    }
    selected.add(entry.app);
  }

  // If shared hit selected nothing useful, fall back to all image apps
  if (sharedHit && selected.size === 0) {
    for (const a of catalog.buildApps) {
      if (scope === "qa" && a.qa === false) continue;
      selected.add(a.app);
    }
  }

  return pool.map((a) => a.app).filter((name) => selected.has(name));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog(args.catalog);
  const files = changedFiles(args.base, args.head);
  const apps = detect(files, catalog, args.scope, args.shared);
  const payload = {
    apps,
    files,
    base: args.base,
    head: args.head,
    scope: args.scope,
  };
  if (args.json) {
    console.log(JSON.stringify(payload));
  } else {
    console.log(apps.join("\n"));
  }
}

main();
