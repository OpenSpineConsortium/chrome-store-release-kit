# Chrome Web Store release kit

A release for any Chrome extension repository, as one reusable GitHub
Actions workflow: every push to the default branch tests the extension,
builds the store zip as version `<manifest>.<commit count>`, keeps it as
the GitHub release `extension-v<that version>` with the zip attached, and
sends that same zip to the Chrome Web Store when the repository variable
`CWS_ON_PUSH` says `upload` or `publish`. A tag `extension-v<version>`
releases that exact version and always uploads it; "Run workflow" does
it by hand.

[`release-kit/README.md`](release-kit/README.md) is the whole manual:
what a push does, the one workflow file a repository pastes
([`release-kit/caller.yml`](release-kit/caller.yml)), the five `CWS_`
secrets and the variable, how an extension with a build step (WXT, Vite)
hands over its own zip, every input, the scripts by hand, and what the
kit does not do on purpose. A new repository needs that file, the
secrets, and one setting made once here (Settings, Actions, General,
Access) so that the organization's repositories may call this one.

The kit floats: every caller takes it from this repository at `main`, so
a fix here reaches every extension's next release with no change there,
and who can write to `main` here is the trust boundary of every caller.

Tests: `node --test "release-kit/tests/*.test.js"` (Node 22.2 or newer).
`.github/workflows/ci.yml` runs them and then the kit's two actions
against the fixture extension under `tests/fixture/extension/`, with no
secret, on every pull request.

It began as the release machinery of OpenSpineConsortium/claude-swap-cloud's
extension and moved here on 2026-10-11.
