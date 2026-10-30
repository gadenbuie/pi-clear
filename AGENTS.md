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
- Changelog follows Keep a Changelog. The version in `package.json` and the
  matching `## [X.Y.Z]` changelog section must agree with the tag being
  released; the workflow refuses to stage otherwise.
- Tags are lightweight, named `vX.Y.Z`, and point at the commit carrying the
  version bump — a dedicated `chore: release vX.Y.Z` commit, or the merged
  feature PR when the bump lands with the feature. Never move a published
  tag.
- Publishing records the built commit in the package's `gitHead`, which must
  equal the tag. Verify before calling a release done:

  ```sh
  git rev-list -n1 vX.Y.Z
  npm view @grrrck/pi-clear@X.Y.Z gitHead
  ```

## Releasing

Releases are cut from a GitHub Release, never from a laptop.
`.github/workflows/publish.yml` runs on `release: published` and
authenticates with npm trusted publishing (OIDC), so no `NPM_TOKEN` secret
exists.

The workflow **stages**, it does not publish. `npm stage publish` puts the
version in npm's stage queue with a provenance attestation, and a maintainer
then approves it with 2FA. Only that approval makes the version installable,
and CI holds no permission to publish directly.

1. Land the version bump and changelog entry on `main`.
2. Tag and push:

   ```sh
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

3. Publish a GitHub Release for the tag. A release marked as a pre-release
   stages with the `next` dist-tag. The workflow re-checks the version against
   the tag and the changelog, that the tag is on `main`, then typechecks and
   runs the offline tests before staging.
4. Approve the staged version on npmjs.com (the package's *Staged Packages*
   tab) or with `npm stage approve <stage-id>`. Until then the release exists
   on GitHub but nothing installs from npm.
5. Verify with the `gitHead` check above and
   `npm view @grrrck/pi-clear dist-tags`.

Constraints that are easy to trip over:

- A `release` event runs the workflow **from the tagged commit**, so the
  workflow file must already be on the tag. Workflow edits only take effect
  for later tags.
- The dist-tag is fixed at stage time. To change it, reject the staged version
  and re-run the workflow.
- An already-published version is skipped with a warning. A version still
  waiting in the stage queue makes npm reject the staging step; reject that
  staged version and re-run.
- Releases must come from `main`: the workflow refuses a tag that is not an
  ancestor of `origin/main`.
- The trusted publisher configured on npmjs.com must name `gadenbuie`,
  `pi-clear`, and `publish.yml` exactly — case-sensitive, filename only, no
  environment. Leave "npm publish" and "npm dist-tag" unchecked.
- `npm stage` requires npm >= 11.15 (Node >= 22.14); the workflow pins Node 24
  for that reason.
- To validate a release without staging anything, run the workflow manually
  with `workflow_dispatch`, passing the tag and `dry_run: true`.
