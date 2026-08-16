# Shared glados / Traefik / QA deploy tooling for joed.dev app repos.

Call these composite actions (or reusable workflows) from any app repo. Keep
Dockerfiles + compose templates in the app repo; put a `deploy/apps.json`
catalog next to them.

## Quick start (single app)

```yaml
# .github/workflows/publish.yml
name: Publish
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      apps:
        default: all

jobs:
  publish:
    uses: r2pen2/deploy-infra-actions/.github/workflows/reusable-publish.yml@main
    with:
      catalog: deploy/apps.json
      apps: ${{ inputs.apps || '' }}
    secrets: inherit
```

```yaml
# .github/workflows/qa-preview.yml
name: QA preview
on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  qa:
    uses: r2pen2/deploy-infra-actions/.github/workflows/reusable-qa-preview.yml@main
    secrets: inherit
```

```yaml
# .github/workflows/qa-preview-cleanup.yml
name: QA cleanup
on:
  pull_request:
    types: [closed]

jobs:
  cleanup:
    uses: r2pen2/deploy-infra-actions/.github/workflows/reusable-qa-cleanup.yml@main
    secrets: inherit
```

## Catalog (`deploy/apps.json`)

```json
{
  "imagePrefix": "nutrifit",
  "qaHostDomain": "joed.dev",
  "apps": [
    {
      "app": "web",
      "port": 80,
      "kind": "static",
      "dockerfile": "deploy/docker/Dockerfile",
      "compose": "deploy/compose/web.yml",
      "serviceDir": "nutrifit",
      "image": true,
      "host": "nutrifit.joed.dev",
      "watchPaths": ["web/", "deploy/docker/", "deploy/compose/web.yml"],
      "imageTagEnv": "NUTRIFIT_IMAGE_TAG"
    }
  ]
}
```

Images publish as `ghcr.io/<owner>/<imagePrefix>-<app>:{latest,sha}` (or `:pr-<n>` for QA).

QA URLs: `https://pr-<n>-<app>.joed.dev`

## Composite actions

| Action | Purpose |
|--------|---------|
| `actions/detect-changed` | Diff → apps_csv |
| `actions/build-push` | docker buildx / docker build → GHCR |
| `actions/deploy-prod` | glados: copy compose + `up -d` |
| `actions/qa-deploy` | glados: ephemeral Traefik Host stacks |
| `actions/qa-cleanup` | glados: tear down PR stacks |

Example (monorepo with custom build still OK):

```yaml
- uses: r2pen2/deploy-infra-actions/actions/deploy-prod@main
  with:
    catalog: deploy/apps.json
    apps: ${{ needs.detect.outputs.apps_csv }}
    sha: ${{ github.sha }}
```

## Runner requirements

Self-hosted runner labels: `self-hosted`, `glados`  
(register **per consumer repo** — GitHub runners are repo-scoped).

Runtime paths on glados:

- `/opt/services/apps/<serviceDir>/compose.yml`
- `/opt/services/data/app-env/`
- `/opt/services/data/app-assets/qa/`

## Migrated consumers

- `WL-Universe` — multi-SPA + mail DNS (catalog + thin workflows)
- `citrus` — api/web/native/mongo
- `nutrifit` — static/nginx example using reusable workflows only
