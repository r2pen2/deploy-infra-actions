#!/usr/bin/env node
/**
 * Register (or skip if already online) repo-scoped GitHub Actions runners on glados.
 *
 * Must run ON glados. Needs a token that can mint registration tokens for each
 * target repo (PAT with admin on those repos), via:
 *   GH_TOKEN / RUNNER_ADMIN_PAT / GITHUB_TOKEN (current repo only)
 *
 *   node scripts/runners/register.mjs --repo r2pen2/nutrifit
 *   node scripts/runners/register.mjs --from-list runners.json
 *   node scripts/runners/register.mjs --from-list runners.json --only r2pen2/nutrifit,r2pen2/citrus
 *   node scripts/runners/register.mjs --from-list runners.json --dry-run
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const DEFAULT_LABELS = ["self-hosted", "glados"];

function parseArgs(argv) {
  const args = {
    list: null,
    only: [],
    repo: null,
    dryRun: false,
    force: false,
    home: process.env.HOME || os.homedir(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from-list" && argv[i + 1]) args.list = argv[++i];
    else if (a === "--only" && argv[i + 1]) {
      args.only = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--repo" && argv[i + 1]) args.repo = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else if (a === "--home" && argv[i + 1]) args.home = argv[++i];
  }
  if (!args.list && !args.repo) {
    throw new Error("Provide --from-list runners.json and/or --repo owner/name");
  }
  return args;
}

function token() {
  return (
    process.env.RUNNER_ADMIN_PAT ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    ""
  );
}

function gh(args, opts = {}) {
  const env = { ...process.env, GH_TOKEN: token(), GH_PROMPT_DISABLED: "1" };
  const r = spawnSync("gh", args, {
    encoding: "utf8",
    env,
    ...opts,
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").trim();
    throw new Error(`gh ${args.join(" ")} failed: ${err}`);
  }
  return r.stdout;
}

function loadList(listPath) {
  const resolved = path.resolve(repoRoot, listPath);
  const data = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const defaultLabels = data.labels || DEFAULT_LABELS;
  return (data.repos || []).map((r) => ({
    repo: r.repo,
    name: r.name || `glados-${r.repo.split("/")[1].toLowerCase()}`,
    dir: r.dir || `actions-runner-${r.repo.split("/")[1].toLowerCase()}`,
    labels: r.labels || defaultLabels,
  }));
}

function entryForRepo(repo) {
  const short = repo.split("/")[1];
  return {
    repo,
    name: `glados-${short.toLowerCase()}`,
    dir: `actions-runner-${short.toLowerCase()}`,
    labels: DEFAULT_LABELS,
  };
}

function listOnlineRunners(repo) {
  try {
    const raw = gh([
      "api",
      `repos/${repo}/actions/runners?per_page=100`,
      "--jq",
      ".runners",
    ]);
    return JSON.parse(raw || "[]");
  } catch (err) {
    console.warn(`Could not list runners for ${repo}: ${err.message}`);
    return [];
  }
}

function alreadyOnline(entry) {
  const runners = listOnlineRunners(entry.repo);
  return runners.some(
    (r) =>
      r.name === entry.name &&
      (r.status === "online" || r.status === "idle" || r.busy === true),
  );
}

function ensureRunnerPackage(runnerDir) {
  fs.mkdirSync(runnerDir, { recursive: true });
  if (fs.existsSync(path.join(runnerDir, "config.sh"))) return;

  console.log(`Downloading Actions runner into ${runnerDir}...`);
  const ver = gh([
    "api",
    "repos/actions/runner/releases/latest",
    "--jq",
    ".tag_name",
  ])
    .trim()
    .replace(/^v/, "");
  if (!ver) throw new Error("Could not resolve actions/runner latest version");
  const tar = `actions-runner-linux-x64-${ver}.tar.gz`;
  const url = `https://github.com/actions/runner/releases/download/v${ver}/${tar}`;
  execFileSync("curl", ["-fsSL", "-o", tar, url], {
    cwd: runnerDir,
    stdio: "inherit",
  });
  execFileSync("tar", ["xzf", tar], { cwd: runnerDir, stdio: "inherit" });
  fs.unlinkSync(path.join(runnerDir, tar));
}

function registrationToken(repo) {
  const raw = gh([
    "api",
    "-X",
    "POST",
    `repos/${repo}/actions/runners/registration-token`,
    "--jq",
    ".token",
  ]);
  const t = raw.trim();
  if (!t) throw new Error(`Empty registration token for ${repo}`);
  return t;
}

function runConfig(runnerDir, args) {
  execFileSync("./config.sh", args, { cwd: runnerDir, stdio: "inherit" });
}

function ensureService(runnerDir) {
  const svc = path.join(runnerDir, "svc.sh");
  if (!fs.existsSync(svc)) return;
  // Install+start if not already a service; ignore failures when already installed.
  try {
    execFileSync("sudo", ["./svc.sh", "status"], {
      cwd: runnerDir,
      stdio: "ignore",
    });
    execFileSync("sudo", ["./svc.sh", "start"], {
      cwd: runnerDir,
      stdio: "inherit",
    });
  } catch {
    try {
      execFileSync("sudo", ["./svc.sh", "install"], {
        cwd: runnerDir,
        stdio: "inherit",
      });
      execFileSync("sudo", ["./svc.sh", "start"], {
        cwd: runnerDir,
        stdio: "inherit",
      });
    } catch (err) {
      console.warn(
        `Service install/start skipped for ${runnerDir}: ${err.message}`,
      );
      console.warn(`Start manually: cd ${runnerDir} && ./run.sh`);
    }
  }
}

function registerOne(entry, { dryRun, force, home }) {
  const runnerDir = path.join(home, entry.dir);
  console.log(`\n=== ${entry.repo} → ${entry.name} (${runnerDir}) ===`);

  if (!force && alreadyOnline(entry)) {
    console.log(`Skip: ${entry.name} already online for ${entry.repo}`);
    return { repo: entry.repo, action: "skipped", reason: "online" };
  }

  if (dryRun) {
    console.log(`Dry-run: would register ${entry.name} for ${entry.repo}`);
    return { repo: entry.repo, action: "dry-run" };
  }

  if (!token()) {
    throw new Error(
      "Set RUNNER_ADMIN_PAT or GH_TOKEN (must mint registration tokens for target repos)",
    );
  }

  ensureRunnerPackage(runnerDir);
  const regToken = registrationToken(entry.repo);

  // Remove prior registration for this directory if present
  try {
    runConfig(runnerDir, ["remove", "--token", regToken]);
  } catch {
    // not configured yet
  }

  // Fresh token after remove (remove may invalidate)
  const regToken2 = registrationToken(entry.repo);
  runConfig(runnerDir, [
    "--unattended",
    "--url",
    `https://github.com/${entry.repo}`,
    "--token",
    regToken2,
    "--name",
    entry.name,
    "--labels",
    entry.labels.join(","),
    "--work",
    "_work",
    "--replace",
  ]);

  ensureService(runnerDir);
  console.log(
    `Registered ${entry.name}. Verify: https://github.com/${entry.repo}/settings/actions/runners`,
  );
  return { repo: entry.repo, action: "registered", dir: runnerDir };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let entries = [];
  if (args.list) {
    entries = loadList(args.list);
    if (args.only.length) {
      const wanted = new Set(args.only);
      entries = entries.filter((e) => wanted.has(e.repo));
    }
  }
  if (args.repo) {
    const fromList = args.list
      ? loadList(args.list).find((e) => e.repo === args.repo)
      : null;
    entries = [fromList || entryForRepo(args.repo)];
  }

  if (!entries.length) {
    console.log("No runner entries to process.");
    return;
  }

  const results = [];
  for (const entry of entries) {
    results.push(registerOne(entry, args));
  }
  console.log("\n" + JSON.stringify({ ok: true, results }, null, 2));
}

main();
