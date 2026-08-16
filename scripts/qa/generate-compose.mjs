#!/usr/bin/env node
/**
 * Generate ephemeral QA compose YAML for one catalog app + PR.
 *
 * Supports kinds: static | spa | express | api (all Traefik Host(pr-N-app.domain))
 * SPA+cms mounts prod assets/SA read-only and sets CMS_COLLECTION_PREFIX.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, resolveImageName } from "../lib/catalog.mjs";
import {
  cmsCollectionPrefix,
  qaContainerName,
  qaHostname,
  qaRouterName,
} from "../lib/naming.mjs";

function parseArgs(argv) {
  const args = {
    catalog: "deploy/apps.json",
    pr: null,
    app: null,
    owner: "r2pen2",
    out: null,
    tag: null,
    cwd: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--catalog" && argv[i + 1]) args.catalog = argv[++i];
    else if (a === "--pr" && argv[i + 1]) args.pr = String(argv[++i]);
    else if (a === "--app" && argv[i + 1]) args.app = argv[++i];
    else if (a === "--owner" && argv[i + 1]) args.owner = argv[++i];
    else if (a === "--out" && argv[i + 1]) args.out = argv[++i];
    else if (a === "--tag" && argv[i + 1]) args.tag = argv[++i];
    else if (a === "--cwd" && argv[i + 1]) args.cwd = argv[++i];
  }
  if (!args.pr || !args.app) throw new Error("--pr and --app are required");
  args.tag = args.tag || `pr-${args.pr}`;
  return args;
}

function yamlQuote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function generateCompose({ catalog, pr, app, owner, tag }) {
  const entry = catalog.byName[app];
  if (!entry) throw new Error(`Unknown app: ${app}`);
  if (entry.image === false) {
    throw new Error(`App ${app} has no image; cannot generate QA compose`);
  }

  const container = qaContainerName(pr, app);
  const router = qaRouterName(pr, app);
  const host = qaHostname(pr, app, catalog.qaHostDomain);
  const image = `${resolveImageName(catalog, owner, app)}:${tag}`;
  const envFile = `/opt/services/data/app-env/qa/${app}.env`;
  const assetsRoot = `/opt/services/data/app-assets/qa/pr-${pr}/${app}`;
  const prodAssets = `/opt/services/data/app-assets/${app}`;
  const prodSa = `/opt/services/data/app-env/${app}-serviceAccountKey.json`;
  const port = String(entry.port);
  const pkg = entry.packagePath || `packages/${app}`;

  const volumes = [];
  if (entry.kind === "spa") {
    if (entry.cms) {
      volumes.push(
        `      - ${prodAssets}/static:/repo/${pkg}/static:ro`,
        `      - ${prodAssets}/images:/repo/${pkg}/images:ro`,
        `      - ${prodSa}:/repo/${pkg}/config/serviceAccountKey.json:ro`,
      );
    } else {
      volumes.push(
        `      - ${assetsRoot}/static:/repo/${pkg}/static`,
        `      - ${assetsRoot}/images:/repo/${pkg}/images`,
        `      - ${assetsRoot}/serviceAccountKey.json:/repo/${pkg}/config/serviceAccountKey.json:ro`,
      );
    }
    if (entry.extraVolumes?.includes("cal")) {
      volumes.push(
        `      - ${assetsRoot}/cal.json:/repo/${pkg}/config/cal.json:ro`,
      );
    }
  } else if (entry.kind === "express") {
    volumes.push(`      - ${assetsRoot}:/opt/services/data/app-assets/${app}`);
  }

  const environment = [`      PORT: ${yamlQuote(port)}`];
  if (entry.kind === "express") {
    environment.push(
      `      SITE_MAIL_LOG_DIR: /opt/services/data/app-assets/${app}`,
      `      SITE_MAIL_DISABLE_SEND: ${yamlQuote("1")}`,
    );
  }
  if (entry.cms) {
    environment.push(
      `      CMS_COLLECTION_PREFIX: ${yamlQuote(cmsCollectionPrefix(pr))}`,
    );
  }

  const volumeBlock =
    volumes.length > 0 ? `    volumes:\n${volumes.join("\n")}\n` : "";

  const networks = (entry.networks || ["proxy"]).filter((n) => n === "proxy" || n);
  // QA always needs proxy for Traefik
  const netSet = new Set(["proxy", ...networks]);

  return `services:
  ${app}:
    image: ${image}
    container_name: ${container}
    restart: "no"
    env_file:
      - ${envFile}
    environment:
${environment.join("\n")}
${volumeBlock}    networks:
${[...netSet].map((n) => `      - ${n}`).join("\n")}
    labels:
      com.centurylinklabs.watchtower.enable: "false"
      traefik.enable: "true"
      traefik.http.routers.${router}.rule: Host(\`${host}\`)
      traefik.http.routers.${router}.entrypoints: web
      traefik.http.services.${router}.loadbalancer.server.port: ${yamlQuote(port)}
      traefik.docker.network: proxy

networks:
  proxy:
    external: true
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog(args.catalog, args.cwd);
  const yaml = generateCompose({
    catalog,
    pr: args.pr,
    app: args.app,
    owner: args.owner,
    tag: args.tag,
  });
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, yaml);
    console.log(args.out);
  } else {
    process.stdout.write(yaml);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
