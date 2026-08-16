/**
 * Load a deploy catalog JSON from a consumer repo.
 *
 * Schema:
 * {
 *   "imagePrefix": "nutrifit",          // ghcr.io/<owner>/<prefix>-<app>
 *   "qaHostDomain": "joed.dev",         // optional
 *   "apps": [
 *     {
 *       "app": "web",
 *       "port": 80,
 *       "kind": "static",               // static | spa | express | api | infra
 *       "dockerfile": "deploy/docker/Dockerfile",
 *       "compose": "deploy/compose/web.yml",
 *       "serviceDir": "nutrifit",       // /opt/services/apps/<serviceDir>
 *       "image": true,                  // false = compose-only (mongo, etc.)
 *       "imageName": "nutrifit",        // optional override of prefix-app
 *       "host": "nutrifit.joed.dev",    // optional (docs)
 *       "packagePath": "packages/web",  // optional WL-style APP_DIR
 *       "cms": false,
 *       "extraVolumes": [],
 *       "watchPaths": ["web/", "deploy/"],
 *       "buildArgs": { "PORT": "80" },  // optional docker build-args
 *       "qa": true                      // include in QA previews (default true if image)
 *     }
 *   ]
 * }
 */
import fs from "node:fs";
import path from "node:path";

export function loadCatalog(catalogPath, cwd = process.cwd()) {
  const resolved = path.resolve(cwd, catalogPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Catalog not found: ${resolved}`);
  }
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!raw.imagePrefix || typeof raw.imagePrefix !== "string") {
    throw new Error("catalog.imagePrefix is required");
  }
  if (!Array.isArray(raw.apps) || raw.apps.length === 0) {
    throw new Error("catalog.apps must be a non-empty array");
  }

  const qaHostDomain = raw.qaHostDomain || "joed.dev";
  const apps = raw.apps.map((a) => normalizeApp(a, raw.imagePrefix));
  const byName = Object.fromEntries(apps.map((a) => [a.app, a]));

  return {
    imagePrefix: raw.imagePrefix,
    qaHostDomain,
    apps,
    byName,
    publishApps: apps,
    qaApps: apps.filter((a) => a.qa !== false && a.image !== false),
    buildApps: apps.filter((a) => a.image !== false),
  };
}

function normalizeApp(a, imagePrefix) {
  if (!a.app) throw new Error("each catalog app requires app");
  const image = a.image !== false;
  return {
    app: a.app,
    port: a.port ?? 80,
    kind: a.kind || (image ? "static" : "infra"),
    dockerfile: a.dockerfile || null,
    compose: a.compose || `deploy/compose/${a.app}.yml`,
    serviceDir: a.serviceDir || a.app,
    image,
    imageName: a.imageName || null,
    host: a.host || null,
    packagePath: a.packagePath || null,
    cms: Boolean(a.cms),
    extraVolumes: a.extraVolumes || [],
    watchPaths: a.watchPaths || defaultWatchPaths(a),
    buildArgs: a.buildArgs || {},
    qa: a.qa !== false && image,
    imageTagEnv: a.imageTagEnv || null,
    networks: a.networks || ["proxy"],
  };
}

function defaultWatchPaths(a) {
  const paths = [];
  if (a.compose) paths.push(a.compose);
  if (a.dockerfile) paths.push(a.dockerfile);
  if (a.packagePath) {
    paths.push(a.packagePath.endsWith("/") ? a.packagePath : `${a.packagePath}/`);
  }
  return paths;
}

export function resolveImageName(catalog, owner, appName) {
  const entry = catalog.byName[appName];
  if (!entry) throw new Error(`Unknown app: ${appName}`);
  const ownerLc = String(owner).toLowerCase();
  if (entry.imageName) {
    return `ghcr.io/${ownerLc}/${entry.imageName}`;
  }
  return `ghcr.io/${ownerLc}/${catalog.imagePrefix}-${entry.app}`;
}
