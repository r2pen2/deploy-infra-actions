#!/usr/bin/env node
/**
 * Tear down ephemeral QA projects for a PR and update active.json.
 *
 *   node scripts/qa/cleanup-pr.mjs --catalog deploy/apps.json --pr 42 [--prune-images]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, resolveImageName } from "../lib/catalog.mjs";
import { qaProjectName } from "../lib/naming.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infraRoot = path.resolve(__dirname, "../..");
const QA_COMPOSE_ROOT = "/opt/services/data/app-assets/qa/compose";
const QA_ASSETS_ROOT = "/opt/services/data/app-assets/qa";

function parseArgs(argv) {
  const args = {
    catalog: "deploy/apps.json",
    pr: null,
    pruneImages: false,
    owner: "r2pen2",
    cwd: process.cwd(),
    firestoreScript: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--catalog" && argv[i + 1]) args.catalog = argv[++i];
    else if (a === "--pr" && argv[i + 1]) args.pr = String(argv[++i]);
    else if (a === "--prune-images") args.pruneImages = true;
    else if (a === "--owner" && argv[i + 1]) args.owner = argv[++i];
    else if (a === "--cwd" && argv[i + 1]) args.cwd = argv[++i];
    else if (a === "--firestore-script" && argv[i + 1]) {
      args.firestoreScript = argv[++i];
    }
  }
  if (!args.pr) throw new Error("--pr is required");
  return args;
}

function run(cmd, cmdArgs, opts = {}) {
  console.log(`+ ${cmd} ${cmdArgs.join(" ")}`);
  try {
    return execFileSync(cmd, cmdArgs, { stdio: "inherit", ...opts });
  } catch (err) {
    if (opts.allowFail) {
      console.warn(`command failed (ignored): ${cmd} ${cmdArgs.join(" ")}`);
      return null;
    }
    throw err;
  }
}

function sh(script, allowFail = false) {
  run("bash", ["-lc", script], { allowFail });
}

function cleanupOne(pr, app) {
  const project = qaProjectName(pr, app);
  const composeFile = path.join(QA_COMPOSE_ROOT, `pr-${pr}`, app, "compose.yml");

  if (fs.existsSync(composeFile)) {
    run(
      "sudo",
      [
        "docker",
        "compose",
        "-p",
        project,
        "-f",
        composeFile,
        "down",
        "--remove-orphans",
      ],
      { allowFail: true },
    );
  } else {
    run(
      "sudo",
      ["docker", "compose", "-p", project, "down", "--remove-orphans"],
      { allowFail: true },
    );
  }

  sh(`sudo rm -rf ${JSON.stringify(path.join(QA_COMPOSE_ROOT, `pr-${pr}`, app))}`, true);
  sh(`sudo rm -rf ${JSON.stringify(path.join(QA_ASSETS_ROOT, `pr-${pr}`, app))}`, true);
}

function pruneImages(catalog, pr, owner) {
  for (const entry of catalog.qaApps) {
    const image = `${resolveImageName(catalog, owner, entry.app)}:pr-${pr}`;
    run("sudo", ["docker", "image", "rm", "-f", image], { allowFail: true });
  }
}

function cleanupFirestore(catalog, pr, owner, firestoreScript, cwd) {
  if (!firestoreScript) return;
  const cmsApps = catalog.qaApps.filter((a) => a.cms);
  for (const entry of cmsApps) {
    const tags = [`pr-${pr}`, "latest"];
    let ok = false;
    for (const tag of tags) {
      const image = `${resolveImageName(catalog, owner, entry.app)}:${tag}`;
      try {
        execFileSync("sudo", ["docker", "image", "inspect", image], {
          stdio: "ignore",
        });
        const scriptPath = path.resolve(cwd, firestoreScript);
        run(
          "sudo",
          [
            "docker",
            "run",
            "--rm",
            "-v",
            "/opt/services/data/app-env:/opt/services/data/app-env:ro",
            "-v",
            `${path.dirname(scriptPath)}:/repo/scripts:ro`,
            "--entrypoint",
            "node",
            image,
            `/repo/scripts/${path.basename(scriptPath)}`,
            "cleanup",
            "--pr",
            String(pr),
            "--app",
            entry.app,
          ],
          { allowFail: true },
        );
        ok = true;
        break;
      } catch {
        // next tag
      }
    }
    if (!ok) {
      console.warn(`firestore cleanup skipped for ${entry.app}`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog(args.catalog, args.cwd);

  for (const entry of catalog.qaApps) {
    cleanupOne(args.pr, entry.app);
  }
  cleanupFirestore(
    catalog,
    args.pr,
    args.owner,
    args.firestoreScript,
    args.cwd,
  );
  sh(`sudo rm -rf ${JSON.stringify(path.join(QA_COMPOSE_ROOT, `pr-${args.pr}`))}`, true);
  sh(`sudo rm -rf ${JSON.stringify(path.join(QA_ASSETS_ROOT, `pr-${args.pr}`))}`, true);

  run("node", [
    path.join(infraRoot, "scripts/qa/update-active-json.mjs"),
    "remove",
    "--pr",
    String(args.pr),
  ]);

  if (args.pruneImages) pruneImages(catalog, args.pr, args.owner);

  console.log(
    JSON.stringify(
      { ok: true, pr: Number(args.pr), pruned: args.pruneImages },
      null,
      2,
    ),
  );
}

main();
