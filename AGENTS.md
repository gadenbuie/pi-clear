# pi-clear agent instructions

`index.ts` is the entire extension; `README.md` documents it. Keep the
`index.ts` header doc comment in sync with behavior.

## Tests

Ask the user before running either `scripts/*.py` smoke test: both launch pi
with their live configuration, and `rpc-handoff-smoke-test.py` makes a **real,
billed model request**. Never run them in a loop, in parallel, or as a side
effect of other work.

These need no confirmation:

```sh
for f in scripts/*.test.mjs; do node "$f"; done

# No tsconfig.json exists, so pass inputs and options explicitly.
npx -y -p typescript tsc --noEmit --skipLibCheck \
  --module esnext --moduleResolution bundler --target es2022 index.ts
```

## Releasing

Cut releases from a GitHub Release. Never `npm publish` from a laptop.

1. Bump `package.json` and add the `## [X.Y.Z]` changelog section on `main`.
2. Show the user that changelog section — it becomes the release notes — and
   wait for them to approve the wording. Expect edits.
3. With their explicit approval, tag and push:
   `git tag vX.Y.Z && git push origin vX.Y.Z`
4. With their explicit approval, publish a GitHub Release for that tag; CI
   validates and stages it.
5. Approve the staged version: npmjs.com → the package → *Staged Packages*, or
   `npm stage approve <stage-id>`. Nothing installs from npm until you do.
6. Verify the published commit is the tag:

   ```sh
   git rev-list -n1 vX.Y.Z
   npm view @grrrck/pi-clear@X.Y.Z gitHead
   ```

Rules:

- Commit and push workflow changes before tagging. A release runs the workflow
  from the tagged commit, so edits only apply to later tags.
- Keep the workflow at `.github/workflows/publish.yml`; npm's trusted publisher
  matches that filename.
- Mark the GitHub Release as a pre-release to stage to `next` instead of
  `latest`.
- To check a release without staging it:
  `gh workflow run publish.yml -f tag=vX.Y.Z -f dry_run=true`
- Never move or delete a tag once it is pushed; ask the user first.
