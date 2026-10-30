# pi-clear agent instructions

pi-clear is a pi extension providing `/clear` (fresh session, keeps model) and
`/hand-off` (hand the conversation to another model). Single-file extension in
`index.ts`; docs in `README.md`.

## Running tests requires confirmation

The smoke tests in `scripts/` run a real pi process against the user's
configured models and auth:

- `scripts/rpc-smoke-test.py` — makes **no model requests** (only local RPC
  state changes), but still launches pi with the user's live configuration.
- `scripts/rpc-handoff-smoke-test.py` — makes a **real LLM request** billed to
  the user's account (the agent generates the hand-off prompt).

Before running either script, tell the user what it does and **ask for
confirmation first**. Do not run them as a side effect of other work, in
loops, or in parallel with each other.

The offline `.mjs` tests in `scripts/` need no confirmation — they run under
`node` against mocked pi APIs and make no model requests:

```sh
for f in scripts/*.test.mjs; do node "$f"; done
```

Typechecking needs no confirmation either, but there is no `tsconfig.json`,
so `tsc --noEmit` alone just prints the help text. Pass the inputs and
compiler options explicitly:

```sh
npx -y -p typescript tsc --noEmit --skipLibCheck \
  --module esnext --moduleResolution bundler --target es2022 index.ts
```

## Conventions

- `index.ts` is the entire extension; keep the header doc comment in sync
  with behavior.
- Changelog follows Keep a Changelog; the version in `package.json` and the
  changelog section should match before tagging.
- Never move a published tag. `npm publish` records the commit in `gitHead`,
  so check the pair agrees before calling a release done:

  ```sh
  git rev-list -n1 vX.Y.Z
  npm view @grrrck/pi-clear@X.Y.Z gitHead
  ```

## Releasing

Publishing happens in CI, not from a laptop: `.github/workflows/publish.yml`
runs when a GitHub Release is published and uses npm trusted publishing
(OIDC), so there is no `NPM_TOKEN` secret to manage.

It **stages** rather than publishes. `npm stage publish` puts the version in
npm's stage queue with provenance attached; a maintainer then approves it with
2FA on npmjs.com (the package's *Staged Packages* tab) or with
`npm stage approve <stage-id>`, and only that approval puts it on the registry.
CI never holds permission to publish directly, so "npm publish" and
"npm dist-tag" stay unchecked on the trusted publisher.

1. Land the version bump and the changelog entry (a separate
   `chore: release vX.Y.Z` commit as for 0.3.1, or in the feature PR itself
   as for 0.4.0 — both are fine).
2. Tag the release commit and push the tag:

   ```sh
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

3. Create the GitHub Release for that tag. Publishing the release triggers
   the workflow, which re-checks the version against the tag and the
   changelog, typechecks, runs the offline tests, and only then stages.
   A release marked as a pre-release stages with the `next` dist-tag.
4. Approve the staged version. Until you do, the release exists on GitHub but
   nothing installs from npm. The dist-tag is fixed once staged — to change
   it, reject the staged version and re-run the workflow.
5. Do not `npm publish` locally — it would skip those checks and the
   provenance attestation.

A `release` event runs the workflow from the tagged commit, so the workflow
file has to exist on the tag being staged, and workflow edits only take
effect for later tags. Re-run it with `workflow_dispatch` (tag + `dry_run`)
to check a release without staging.
