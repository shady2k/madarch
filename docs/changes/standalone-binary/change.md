# One madarch binary: the release build, its distribution and its upgrade contract

Change: standalone-binary
Base: 8ccc6ab2
Tasks: madarch-lfhu.1
Kind: behavior

## Intent
The charter's outcome 5 (docs/milestones/standalone.md): madarch is
distributed as one compiled binary per platform that starts a product with no
bun or node installed and no node_modules. After this change the release
build (a tag push) compiles the command with `bun build --compile`, embeds
the wiki app's built files into the binary, and publishes the binaries with
their SHA256 sums, npm packages the binary wraps, a Homebrew formula and one
install script to the GitHub release. `madarch version` answers the release
version; `madarch upgrade` fetches the newest release, verifies its artifact
against the release's checksum file, and replaces the running binary after
receiving a yes — refusing every other answer and refusing in a source
checkout, where there is nothing to replace.

Stories:
- As an engineer without bun or node on their machine, I install madarch once
  (npm, Homebrew or the install script) and create, list and serve products
  with the same command the checkout gives.
- As the owner of an installed madarch, I upgrade it to the newest release
  with one command, told what version will replace what, and nothing is done
  without my yes.

## Out of scope
Windows binaries (the release builds linux and macOS, amd64 and arm64 only),
npm registry publishing (the packed tarballs ride the release; publishing
needs the owner's npm token), the encrypted npm account, authentication, and
`madarch server` (decision 0010's image and its Helm chart, madarch-uaq8).

## Rationale
The vetting probes (the run's notes file compiled-binary-probes.md) found the
three take-apart seams the way the command runs compiled: the pinned
product-repository program's own command-line guard fires inside a compiled
bun binary (Bun hands a binary's entry position to every bundled module
alike, so the pinned file's own check matches and refuses the user's
arguments before madarch sees them); the wiki app's dist was reachable only
through the checkout folder `src/product-wiki/app.ts` names; and the
native-module loading of `@ladybugdb/core` proved simply one environment
variable difference on a NixOS dev machine, not a defect of the compiled
binary. The fix keeps each where it lies: the entry shifts `argv[1]` before
the graph loads (a source checkout never matched the guard anyway, so its
runs keep their argv); the release build embeds the wiki app's dist as an
asset the compiled binary reads through `Bun.main`'s directory; and the
distribution's contract (uploads, sums, formula, tarballs) is checked in the
release workflow the same way every other check is.

## Changes to requirements
- release-binary: a new capability (docs/changes/standalone-binary/capabilities/release-binary.md)
  — the version the binary answers, and the upgrade against the release
  contract with its printed question, its --yes answer flag and its beside-the-target staging; the serving behaviour already held by
  product-wiki's requirements stands unchanged in the binary.

## Preserved contracts
- product-repository/draft: test
- product-repository/manifest: test
- product-repository/list: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test

## Coverage
- release-binary/version: static, test, review
- release-binary/upgrade: static, test, review
- release-binary/installers: test, review
- product-repository/draft: test
- product-repository/manifest: test
- product-repository/list: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test

