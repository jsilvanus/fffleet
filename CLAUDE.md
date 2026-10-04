# fffleet

Generic ffmpeg job runner: `packages/fffleet` (client, contract v1, local JobManager; zero deps), `packages/fffleet-worker` (daemon), `packages/fffleet-orchestrator` (scheduler). Node >= 20, ESM, `node:test`, no runtime dependencies. EUPL-1.2.

- Keep it generic: no references to any particular product that uses it.
- The contract lives in `packages/fffleet/src/contract.js` and README "The job contract (v1)"; change both together. Breaking changes need a new contract version.
- Types: `packages/fffleet/index.d.ts` and `server.d.ts` are hand-written; update them with API changes.
- Tests: `npm test` (unit + e2e, needs ffmpeg). E2E tests start the real bin scripts (`test/helpers/index.js`).
- Releases: add a changeset (`npm run changeset`) for user-visible changes. The three packages are a fixed group (one version). Merging the "Version Packages" PR publishes to npm and pushes ghcr images (`.github/workflows/release.yml`).
