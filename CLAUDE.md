# Chrome Web Store release kit

This repository is the release kit for every Chrome extension of the
organization: a reusable GitHub Actions workflow that builds an
extension's store zip on every push to its default branch, keeps it as a
GitHub release and sends it to the Chrome Web Store when a repository
variable says so. It holds no extension. `release-kit/README.md` is the
manual and the specification; read it first.

## Layout

- `release-kit/`: the kit. `action.yml` (the package action) with
  `lib.mjs`, `package.mjs` (the packager for an extension with no build
  step) and `stamp.mjs` (the build number into the zip's manifest, the
  four release files); `store/action.yml` with `store/publish.mjs` (the
  upload and the submit through the Chrome Web Store API, from `CWS_`
  environment variables); `caller.yml`, the workflow a repository pastes;
  `README.md`, the manual; `tests/`, one suite per script plus
  `kit.test.js`, which holds the workflow, the caller and the README to
  each other.
- `.github/workflows/release-kit.yml`: the reusable workflow a caller
  names. Four of its lines name this repository (two `uses:`, two `if:`);
  the tests read the name from `caller.yml` and hold them to it.
- `.github/workflows/ci.yml`: the tests, then both actions against
  `tests/fixture/extension/`, a do-nothing extension, with no secret.

## Rules

- The kit floats at `main`: every caller runs what `main` holds, so a
  change here is tried by this repository's own CI first (a pull request
  runs the checkout's copy) and reaches every extension's next release
  once merged. Who can write to `main` here is the trust boundary of
  every caller; a caller passes the kit its five store secrets by name
  and nothing else of its own.
- Nothing in `release-kit/` names any extension; `kit.test.js` refuses
  the names it knows. A caller's particulars (its folder, its build
  command, its zip) travel as inputs.
- No dependency: Node and its standard library, plus one pinned esbuild
  run through npx (or the binary `RELEASE_KIT_ESBUILD` names). Minifying
  only; never obfuscation or encryption, which the store forbids.
- Plain prose comments that say why; short functions; names that read
  as English. No emoji. Plain ASCII with LF endings in every file.
- No retry at the store, no shortening of what the store says: an upload
  the store refuses ends the run with the store's own words.

## Testing

```
node --test "release-kit/tests/*.test.js"
node release-kit/package.mjs --dir tests/fixture/extension --out dist --plain
```
