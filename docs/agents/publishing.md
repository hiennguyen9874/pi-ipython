# Publishing

Use this runbook to release `pi-ipython` or diagnose a failed release. The [workflow](../../.github/workflows/npm.yml) defines the gates; the [README](../../README.md#automated-npm-releases) holds the one-time GitHub environment and npm Trusted Publishing settings.

## Release

1. **Prepare.** Choose a stable version not already on npm or tagged on `origin`. Bump `package.json` and `package-lock.json` together (`npm version patch --no-git-tag-version` for a patch). In `CHANGELOG.md`, move the release notes from `[Unreleased]` into a non-empty `## [X.Y.Z]` section, leaving `[Unreleased]` for future changes. The two manifests and the notes must be on the same release commit.
2. **Tag.** Merge the release commit into the default branch. Push `vX.Y.Z` on the merged commit after checking that the version and changelog section are present there. The tag push triggers the public publish; pushing the branch alone does not.
3. **Verify.** Find the tag run with `gh run list --workflow npm.yml --branch vX.Y.Z`. Check that both `publish` and `release` succeeded. Confirm `npm view pi-ipython@X.Y.Z version --prefer-online` returns `X.Y.Z` and `gh release view vX.Y.Z --json url` returns the release URL. If npm accepted the publish but the registry has not caught up, report that verification is pending.

## Recover

- **Build failed:** inspect `gh run view RUN_ID --log-failed`. If the tagged commit needs a fix, prepare a fresh version and tag; keep pushed release tags immutable.
- **npm authentication failed:** compare the Trusted Publishing settings with the README, including the `npm` environment, workflow filename, and permission for direct `npm publish`. Use OIDC, not an `NPM_TOKEN`.
- **npm already accepted the version:** wait for registry propagation or verify the exact version before retrying anything. Published versions cannot be overwritten. If only the GitHub Release failed, rerun failed jobs (`gh run rerun RUN_ID --failed`) rather than rerunning the whole workflow.
