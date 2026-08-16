/**
 * Shared naming for QA hosts / compose projects on glados.
 *
 * Hostname scheme: pr-<PR>-<app>.joed.dev
 * (first-level label under apex for Universal SSL + single DNS wildcard)
 */

export function qaHostname(pr, app, qaHostDomain = "joed.dev") {
  return `pr-${pr}-${app}.${qaHostDomain}`;
}

export function qaUrl(pr, app, qaHostDomain = "joed.dev") {
  return `https://${qaHostname(pr, app, qaHostDomain)}`;
}

export function qaProjectName(pr, app) {
  return `qa-pr-${pr}-${app}`;
}

export function qaContainerName(pr, app) {
  return `qa-pr-${pr}-${app}`;
}

export function qaRouterName(pr, app) {
  return `qa-pr-${pr}-${app}`;
}

export function cmsCollectionPrefix(pr) {
  return `qa-pr-${pr}-`;
}
