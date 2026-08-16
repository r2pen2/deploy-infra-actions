#!/usr/bin/env node
/**
 * Deploy production compose stacks on glados.
 *
 *   node scripts/deploy-prod.mjs --catalog deploy/apps.json --apps web,api --sha <sha>
 *
 * Copies each app's compose file into /opt/services/apps/<serviceDir>/compose.yml
 * then pull + up -d. Optional image tag env vars from catalog.imageTagEnv.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadCatalog } from "./lib/catalog.mjs";

function parseArgs(argv) {
  const args = {
    catalog: "deploy/apps.json",
    apps: [],
    sha: process.env.GITHUB_SHA || "",
    cwd: process.cwd(),
    order: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--catalog" && argv[i + 1]) args.catalog = argv[++i];
    else if (a === "--apps" && argv[i + 1]) {
      args.apps = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--sha" && argv[i + 1]) args.sha = argv[++i];
    else if (a === "--cwd" && argv[i + 1]) args.cwd = argv[++i];
    else if (a === "--order" && argv[i + 1]) {
      args.order = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  if (!args.apps.length) throw new Error("--apps is required");
  return args;
}

function run(cmd, cmdArgs, opts = {}) {
  console.log(`+ ${cmd} ${cmdArgs.join(" ")}`);
  return execFileSync(cmd, cmdArgs, { stdio: "inherit", ...opts });
}

function ensureNetworks(entry) {
  for (const net of entry.networks || ["proxy"]) {
    if (net === "proxy") {
      try {
        execFileSync("sudo", ["docker", "network", "inspect", "proxy"], {
          stdio: "ignore",
        });
      } catch {
        throw new Error("FATAL: Traefik proxy network missing");
      }
      continue;
    }
    try {
      execFileSync("sudo", ["docker", "network", "inspect", net], {
        stdio: "ignore",
      });
    } catch {
      run("sudo", ["docker", "network", "create", net]);
    }
  }
}

function deployOne(catalog, appName, cwd, sha) {
  const entry = catalog.byName[appName];
  if (!entry) throw new Error(`Unknown app: ${appName}`);

  ensureNetworks(entry);

  const composeSrc = path.resolve(cwd, entry.compose);
  if (!fs.existsSync(composeSrc)) {
    throw new Error(`Compose file missing: ${composeSrc}`);
  }

  const destDir = `/opt/services/apps/${entry.serviceDir}`;
  const composeFile = `${destDir}/compose.yml`;
  run("sudo", ["mkdir", "-p", destDir]);
  run("sudo", ["cp", composeSrc, composeFile]);

  const env = { ...process.env };
  if (entry.imageTagEnv && sha) {
    env[entry.imageTagEnv] = sha;
  }

  console.log(`::group::Deploy ${entry.serviceDir}`);
  try {
    run("sudo", ["-E", "docker", "compose", "-f", composeFile, "pull"], {
      env,
      // pull may fail for local-only upstream tags; still try up
    });
  } catch {
    console.warn(`compose pull failed for ${appName}; continuing with up -d`);
  }
  run("sudo", ["-E", "docker", "compose", "-f", composeFile, "up", "-d"], {
    env,
  });
  run("sudo", ["-E", "docker", "compose", "-f", composeFile, "ps"], { env });
  console.log("::endgroup::");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog(args.catalog, args.cwd);

  for (const name of args.apps) {
    if (!catalog.byName[name]) throw new Error(`Unknown app: ${name}`);
  }

  let order = args.apps;
  if (args.order?.length) {
    const wanted = new Set(args.apps);
    const ranked = args.order.filter((a) => wanted.has(a));
    const rest = args.apps.filter((a) => !ranked.includes(a));
    order = [...ranked, ...rest];
  }

  for (const app of order) {
    deployOne(catalog, app, args.cwd, args.sha);
  }

  console.log(JSON.stringify({ ok: true, apps: order, sha: args.sha }));
}

main();
