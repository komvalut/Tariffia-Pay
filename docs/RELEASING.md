# Releasing Tariffia Pay

This document describes **release readiness** for the `@tariffia/pay` SDK and the
repository. It is deliberately manual and transparent: nothing here publishes,
deploys, or creates a production release tag automatically.

> Status: Tariffia Pay is pre-1.0. Do not describe a build as a production 1.0
> release until real-PostgreSQL validation and a deployment have been completed
> (see [`../PRODUCTION.md`](../PRODUCTION.md)).

## What a release is (and is not)

- **Is:** a versioned, packable SDK tarball, a tagged commit, and an updated
  changelog.
- **Is not:** a deployment, a database migration, a server configuration change,
  or any movement of funds. Those are separate, operator-driven steps.

## Prerequisites

- A clean working tree on the intended commit (`git status`).
- The full validation suite green: `npm test`, `npm run typecheck`,
  `npm run build`, `npm audit`, `git diff --check`.
- Node.js 20+ and network access only if you actually intend to publish.

## 1. Decide the version

Versions live in two places and should stay in sync:

- `package.json` → `version` (the application/repository version)
- `sdk/package.json` → `version` (the published SDK version)

Use Semantic Versioning. Before 1.0, breaking changes still bump the minor
version. Update `CHANGELOG.md` with a new entry for the version.

## 2. Build and inspect the SDK package

The SDK builds automatically when packing or publishing (`prepack`/`prepare`),
so a clean checkout produces a complete tarball. Always inspect before publishing:

```sh
cd sdk
npm pack --dry-run
```

A correct dry-run must include the built SDK entry points and must NOT include
secrets, environment files, tests, or unrelated files:

- Included: `dist/server.js`, `dist/server.d.ts`, `dist/browser.js`,
  `dist/browser.d.ts` (and `.js.map` optionally), `README.md`, `examples/`,
  `package.json`.
- Excluded: `.env*`, `tests/`, `node_modules/`, `*.dump`, backup files, and any
  file containing credentials.

The repository test `tests/sdk-packaging.test.ts` enforces this and fails if the
package is missing `dist` or leaks forbidden files.

## 3. Publish (only when you intend to)

Publishing is intentionally not automated. When you are ready:

```sh
cd sdk
npm publish          # requires npm credentials; publishes the built tarball
```

Do not run `npm publish` from automation, and never publish with placeholder or
real secrets in the working tree. `publishConfig.access` is `public`.

## 4. Tag the release (only when you intend to)

```sh
git tag -a v0.1.0 -m "Tariffia Pay v0.1.0"
git push origin v0.1.0
```

Tagging and pushing are explicit, deliberate actions. Do not create or push a
production tag as part of routine development.

## 5. After release

- Verify the published package installs and its entry points resolve.
- Record the release in `CHANGELOG.md` / release notes.
- Keep the deployment steps separate: back up, migrate, deploy, verify health
  (see [`../PRODUCTION.md`](../PRODUCTION.md)). The application does not deploy
  itself, and this repository never moves funds.

## Checklist

- [ ] Working tree clean; version bumped in `package.json` and `sdk/package.json`
- [ ] `CHANGELOG.md` updated
- [ ] `npm test`, `npm run typecheck`, `npm run build`, `npm audit`,
      `git diff --check` all green
- [ ] `cd sdk && npm pack --dry-run` shows the expected files and no secrets
- [ ] (Optional) real-PostgreSQL lane run on a normal host:
      `TEST_DATABASE_URL=... npm run test:postgres`
- [ ] Publish and tag only as deliberate, separate steps
