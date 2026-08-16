#!/usr/bin/env node
/**
 * Deploy ephemeral QA compose projects on glados for a PR.
 *
 *   node scripts/qa/deploy-pr.mjs --catalog deploy/apps.json --pr 42 --apps web --sha abc --owner r2pen2
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, resolveImageName } from "../lib/catalog.mjs";
import { qaContainerName, qaProjectName, qaUrl } from "../lib/naming.mjs";
import { generateCompose } from "./generate-compose.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infraRoot = path.resolve(__dirname, "../..");

const QA_ENV_DIR = "/opt/services/data/app-env/qa";
const QA_ASSETS_ROOT = "/opt/services/data/app-assets/qa";
const QA_COMPOSE_ROOT = "/opt/services/data/app-assets/qa/compose";

function parseArgs(argv) {
  const args = {
    catalog: "deploy/apps.json",
    pr: null,
    apps: [],
    sha: null,
    owner: process.env.GITHUB_REPOSITORY_OWNER || "r2pen2",
    out: null,
    cwd: process.cwd(),
    envExampleDir: "deploy/qa/env",
    firestoreScript: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--catalog" && argv[i + 1]) args.catalog = argv[++i];
    else if (a === "--pr" && argv[i + 1]) args.pr = String(argv[++i]);
    else if (a === "--apps" && argv[i + 1]) {
      args.apps = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--sha" && argv[i + 1]) args.sha = argv[++i];
    else if (a === "--owner" && argv[i + 1]) args.owner = argv[++i];
    else if (a === "--out" && argv[i + 1]) args.out = argv[++i];
    else if (a === "--cwd" && argv[i + 1]) args.cwd = argv[++i];
    else if (a === "--env-example-dir" && argv[i + 1]) args.envExampleDir = argv[++i];
    else if (a === "--firestore-script" && argv[i + 1]) {
      args.firestoreScript = argv[++i];
    }
  }
  if (!args.pr) throw new Error("--pr is required");
  if (!args.apps.length) throw new Error("--apps is required");
  return args;
}

function run(cmd, cmdArgs, opts = {}) {
  console.log(`+ ${cmd} ${cmdArgs.join(" ")}`);
  return execFileSync(cmd, cmdArgs, { stdio: "inherit", ...opts });
}

function sh(script) {
  run("bash", ["-lc", script]);
}

function ensureQaEnv(app, cwd, envExampleDir) {
  const dest = path.join(QA_ENV_DIR, `${app}.env`);
  const example = path.join(cwd, envExampleDir, `${app}.env.example`);
  const generic = path.join(cwd, envExampleDir, `_default.env.example`);
  sh(`sudo mkdir -p ${JSON.stringify(QA_ENV_DIR)}`);
  if (fs.existsSync(dest)) {
    console.log(`env exists: ${dest}`);
    return dest;
  }
  let src = null;
  if (fs.existsSync(example)) src = example;
  else if (fs.existsSync(generic)) src = generic;
  else {
    // Minimal empty env for static sites
    const tmp = path.join("/tmp", `qa-env-${app}.env`);
    fs.writeFileSync(tmp, "# QA env\n");
    src = tmp;
  }
  sh(`sudo cp ${JSON.stringify(src)} ${JSON.stringify(dest)}`);
  sh(`sudo chmod 640 ${JSON.stringify(dest)}`);
  console.log(`env seeded: ${dest}`);
  return dest;
}

function ensureAssets(pr, app, entry, cwd) {
  const root = path.join(QA_ASSETS_ROOT, `pr-${pr}`, app);
  sh(`sudo mkdir -p ${JSON.stringify(root)}`);
  if (entry.kind === "spa" && !entry.cms) {
    sh(`sudo mkdir -p ${JSON.stringify(path.join(root, "static"))}`);
    sh(`sudo mkdir -p ${JSON.stringify(path.join(root, "images"))}`);
    const sa = path.join(root, "serviceAccountKey.json");
    const placeholderSrc = path.join(cwd, "deploy/qa/firebase-placeholder.json");
    if (fs.existsSync(placeholderSrc)) {
      sh(
        `if [ ! -f ${JSON.stringify(sa)} ]; then sudo cp ${JSON.stringify(placeholderSrc)} ${JSON.stringify(sa)}; fi`,
      );
    } else {
      const tmp = path.join("/tmp", `qa-sa-${pr}-${app}.json`);
      fs.writeFileSync(tmp, "{}\n");
      sh(
        `if [ ! -f ${JSON.stringify(sa)} ]; then sudo cp ${JSON.stringify(tmp)} ${JSON.stringify(sa)}; fi`,
      );
    }
    if (entry.extraVolumes?.includes("cal")) {
      const cal = path.join(root, "cal.json");
      const calTmp = path.join("/tmp", `qa-cal-${pr}-${app}.json`);
      fs.writeFileSync(calTmp, "{}\n");
      sh(
        `if [ ! -f ${JSON.stringify(cal)} ]; then sudo cp ${JSON.stringify(calTmp)} ${JSON.stringify(cal)}; fi`,
      );
    }
  }
  return root;
}

function seedFirestore(pr, app, owner, catalog, firestoreScript, cwd) {
  const entry = catalog.byName[app];
  if (!entry?.cms || !firestoreScript) return;
  const image = `${resolveImageName(catalog, owner, app)}:pr-${pr}`;
  const scriptPath = path.resolve(cwd, firestoreScript);
  run("sudo", [
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
    "seed",
    "--pr",
    String(pr),
    "--app",
    app,
  ]);
}

function deployOne({ catalog, pr, app, owner, sha, cwd, envExampleDir, firestoreScript }) {
  const entry = catalog.byName[app];
  if (!entry) throw new Error(`Unknown app: ${app}`);

  ensureQaEnv(app, cwd, envExampleDir);
  ensureAssets(pr, app, entry, cwd);

  const project = qaProjectName(pr, app);
  const composeDir = path.join(QA_COMPOSE_ROOT, `pr-${pr}`, app);
  const composeFile = path.join(composeDir, "compose.yml");
  sh(`sudo mkdir -p ${JSON.stringify(composeDir)}`);

  const yaml = generateCompose({
    catalog,
    pr,
    app,
    owner,
    tag: `pr-${pr}`,
  });
  const tmp = path.join("/tmp", `qa-compose-${pr}-${app}.yml`);
  fs.writeFileSync(tmp, yaml);
  sh(`sudo cp ${JSON.stringify(tmp)} ${JSON.stringify(composeFile)}`);
  fs.unlinkSync(tmp);

  try {
    run("sudo", ["docker", "compose", "-p", project, "-f", composeFile, "pull"]);
  } catch (err) {
    const image = `${resolveImageName(catalog, owner, app)}:pr-${pr}`;
    try {
      execFileSync("sudo", ["docker", "image", "inspect", image], {
        stdio: "ignore",
      });
    } catch {
      throw err;
    }
  }

  seedFirestore(pr, app, owner, catalog, firestoreScript, cwd);

  run("sudo", [
    "docker",
    "compose",
    "-p",
    project,
    "-f",
    composeFile,
    "up",
    "-d",
    "--remove-orphans",
  ]);
  run("sudo", ["docker", "compose", "-p", project, "-f", composeFile, "ps"]);

  const url = qaUrl(pr, app, catalog.qaHostDomain);
  run("node", [
    path.join(infraRoot, "scripts/qa/update-active-json.mjs"),
    "upsert",
    "--pr",
    String(pr),
    "--app",
    app,
    "--url",
    url,
    "--sha",
    sha || "",
  ]);

  return {
    app,
    project,
    container: qaContainerName(pr, app),
    url,
    liveness: `${url}/liveness`,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog(args.catalog, args.cwd);
  for (const app of args.apps) {
    if (!catalog.byName[app]) throw new Error(`Unknown app: ${app}`);
  }
  sh(`sudo mkdir -p ${JSON.stringify(QA_ASSETS_ROOT)}`);
  const deployments = [];
  for (const app of args.apps) {
    deployments.push(
      deployOne({
        catalog,
        pr: args.pr,
        app,
        owner: args.owner,
        sha: args.sha,
        cwd: args.cwd,
        envExampleDir: args.envExampleDir,
        firestoreScript: args.firestoreScript,
      }),
    );
  }
  const summary = { ok: true, pr: Number(args.pr), deployments };
  console.log(JSON.stringify(summary, null, 2));
  if (args.out) {
    fs.writeFileSync(args.out, `${JSON.stringify(deployments)}\n`);
  }
}

main();
