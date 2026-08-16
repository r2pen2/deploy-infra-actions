#!/usr/bin/env node
/**
 * Build and push GHCR images for catalog apps.
 *
 *   node scripts/build-push.mjs --catalog deploy/apps.json --apps web --owner r2pen2 --sha <sha>
 *   node scripts/build-push.mjs ... --tag-prefix pr-12
 *
 * Set GLADOS_DOCKER_BUILD=1 to use plain `docker build` + push (self-hosted).
 */
import { execFileSync } from "node:child_process";
import { loadCatalog, resolveImageName } from "./lib/catalog.mjs";

function parseArgs(argv) {
  const args = {
    catalog: "deploy/apps.json",
    apps: [],
    owner: process.env.GITHUB_REPOSITORY_OWNER || "r2pen2",
    sha: process.env.GITHUB_SHA || "local",
    tagPrefix: null,
    cwd: process.cwd(),
    push: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--catalog" && argv[i + 1]) args.catalog = argv[++i];
    else if (a === "--apps" && argv[i + 1]) {
      args.apps = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--owner" && argv[i + 1]) args.owner = argv[++i];
    else if (a === "--sha" && argv[i + 1]) args.sha = argv[++i];
    else if (a === "--tag-prefix" && argv[i + 1]) args.tagPrefix = argv[++i];
    else if (a === "--cwd" && argv[i + 1]) args.cwd = argv[++i];
    else if (a === "--no-push") args.push = false;
  }
  if (!args.apps.length) throw new Error("--apps is required");
  return args;
}

function run(cmd, cmdArgs, opts = {}) {
  console.log(`+ ${cmd} ${cmdArgs.join(" ")}`);
  return execFileSync(cmd, cmdArgs, { stdio: "inherit", ...opts });
}

function runDocker(args, cwd) {
  try {
    run("docker", args, { cwd });
  } catch {
    run("sudo", ["docker", ...args], { cwd });
  }
}

function buildArgsFor(entry) {
  const out = [];
  const merged = { ...entry.buildArgs };
  if (entry.packagePath) {
    merged.APP_DIR = merged.APP_DIR || entry.packagePath;
    merged.APP_NAME = merged.APP_NAME || entry.app;
  }
  if (entry.port != null && merged.PORT == null) {
    merged.PORT = String(entry.port);
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("BUILD_ARG_") && v != null && v !== "") {
      merged[k.slice("BUILD_ARG_".length)] = v;
    }
  }
  for (const [k, v] of Object.entries(merged)) {
    out.push("--build-arg", `${k}=${v}`);
  }
  return out;
}

function tagsFor(image, args) {
  if (args.tagPrefix) {
    return [
      `${image}:${args.tagPrefix}`,
      `${image}:${args.tagPrefix}-${args.sha}`,
    ];
  }
  return [`${image}:latest`, `${image}:${args.sha}`];
}

function preferPlainDocker() {
  if (process.env.GLADOS_DOCKER_BUILD === "1") return true;
  try {
    execFileSync("docker", ["buildx", "version"], { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

function buildOne(catalog, entry, args) {
  if (entry.image === false) {
    console.log(`skip build (no image): ${entry.app}`);
    return;
  }
  if (!entry.dockerfile) {
    throw new Error(`App ${entry.app} missing dockerfile`);
  }

  const image = resolveImageName(catalog, args.owner, entry.app);
  const tags = tagsFor(image, args);
  const bargs = buildArgsFor(entry);

  console.log(`::group::Build ${entry.app} → ${tags[0]}`);

  if (preferPlainDocker()) {
    runDocker(
      ["build", "--file", entry.dockerfile, ...bargs, ...tags.flatMap((t) => ["--tag", t]), "."],
      args.cwd,
    );
    if (args.push) {
      for (const t of tags) runDocker(["push", t], args.cwd);
    }
  } else {
    const cacheScope = args.tagPrefix ? `qa-${entry.app}` : entry.app;
    const cmd = [
      "buildx",
      "build",
      "--file",
      entry.dockerfile,
      ...bargs,
      ...tags.flatMap((t) => ["--tag", t]),
      "--cache-from",
      `type=gha,scope=${cacheScope}`,
      "--cache-to",
      `type=gha,mode=max,scope=${cacheScope}`,
      args.push ? "--push" : "--load",
      ".",
    ];
    runDocker(cmd, args.cwd);
  }

  console.log("::endgroup::");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog(args.catalog, args.cwd);
  for (const name of args.apps) {
    const entry = catalog.byName[name];
    if (!entry) throw new Error(`Unknown app: ${name}`);
    buildOne(catalog, entry, args);
  }
}

main();
