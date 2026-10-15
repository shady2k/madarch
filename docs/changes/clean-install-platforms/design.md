# Design: clean installs on supported platforms

## Context and drivers
The outcome is an installable CLI for people on clean machines. Task `madarch-lfhu.2` requires a binary that opens LadybugDB during `new`, Windows x64 support, three clean platform walks, and no publication without the owner's later yes. Addendum 4 prioritizes avoiding system OpenSSL where feasible and permits a documented exact system requirement plus an installer refusal if it is not feasible. Linux native package `@ladybugdb/core-linux-x64` 0.20.4 is built with ELF `NEEDED` entries `libssl.so.3` and `libcrypto.so.3`; local `ldd` reports both missing. Draft creation also requires a usable `git` executable and configured author identity because it commits the skeleton (`src/product/draft.ts`). The npm package `@ladybugdb/core` 0.20.4 declares platform packages including `@ladybugdb/core-win32-x64`. Existing release builds only Linux/macOS, build smoke currently runs `version`/`list`, and current npm wrapper selects Linux/macOS only. Formula generation creates an artifact but release has no tap push. The install script is POSIX shell only.

## Options
1. Bundle OpenSSL shared libraries with Linux binaries and arrange native-loader lookup. This can keep clean Linux independent of `libssl3`, but changes the single-binary artifact into a coordinated binary-plus-libraries layout and adds platform-specific native loading, checksum, upgrade and install behavior.
2. Rebuild LadybugDB with static OpenSSL. This could preserve a single binary, but the upstream npm package supplies prebuilt native addons and no evidence shows its build supports a reproducible static OpenSSL build. It adds a source/toolchain dependency and increases release risk.
3. Name OpenSSL 3 as a Linux runtime prerequisite, refuse early with an actionable message in every installer/launcher, and test it in the release binary smoke. Homebrew Linux must provide the OpenSSL 3 library path through an environment wrapper. This preserves the artifact architecture and states the native dependency honestly, but does not meet the stronger no-libssl3 Linux install walk.

## Decision
Choose option 3 for this task. Local binary inspection proves the dependency, and no established static-link build path is present. Require OpenSSL 3 runtime libraries for Linux, detect both `libssl.so.3` and `libcrypto.so.3` before graph-backed commands in npx, shell-script and Homebrew Linux launch paths, document the requirement, and make build smoke actually execute `new` and open the graph store. The PowerShell walk requires Git and a configured Git author, as does every `new` walk; setup is explicit and never changes global identity. Add Windows x64 build/package/wrapper and PowerShell install paths on native Windows runners; use the `madarch-windows-x64.exe` asset consistently for builds and upgrades, and replace the running executable through a detached Windows helper after the process exits. Refuse Windows arm64 explicitly. For unpublished walks, pack the wrapper and platform package locally, install those exact tarballs into a clean runner-local npm prefix, then execute the installed command with `npx madarch new <name>`; run the formula locally against the built artifact without changing or publishing the tap. The release workflow's tap push must be a named, required step using only the secret name `HOMEBREW_TAP_TOKEN`; no secret value is read or exposed, and no publish step is run in this task.

## Consequences and assumptions
- Linux without OpenSSL 3 is refused rather than silently failing on LadybugDB load. A future measured static-build or bundled-library option can replace this decision.
- Linux CI runtime smoke must run on a runner with OpenSSL 3; the requested no-libssl3 clean walk cannot succeed under this decision and will be reported as a limit, not represented by a smaller substitute.
- Windows is built on Windows with its native LadybugDB package; cross-compiling a Linux-hosted native module is not assumed. Windows self-upgrade remains supported using a detached replacement helper; its failure leaves the installed binary untouched.
- The release-only external side effect remains gated on a tag. Branch verification workflows do not publish or push to the tap.

## Review before implementation
The first independent review found four gaps: Git identity assumptions, Homebrew Linux OpenSSL loading, Windows artifact/self-replacement, and a non-publishing npx verification route. These are addressed above by explicit Git setup, Linux formula launch environment, a shared `.exe` artifact name and detached replacement helper, and local tarball installation in a clean runner prefix. Second review by gpt-6.1-sol approved the design before implementation; no blocking gaps remained.

## Addendum: hosted clean-install run 38577400831

### New evidence and problem
The hosted run failed on Linux because the compiled executable still searched for `node_modules/@ladybugdb/core/lbugjs.node`, which is absent on a clean runner. Windows failed inside `process.dlopen`; its log did not identify a specific missing DLL. The Homebrew leg tried to install the generated formula outside a tap. The OpenSSL 3 negative-case leg behaved as designed and is not changed.

A compiled Linux/Bun 1.4.2 probe embedded the real Ladybug addon, extracted it to disk, intercepted the exact package path before dynamic import, preserved flags `257`, initialized an in-memory Ladybug database, and printed Ladybug version `0.20.4`.

### Revised options and decision
1. Add a sidecar `.node` file. Rejected because it expands installation, upgrade, checksum, and cleanup surfaces and gives up the one-file binary.
2. Keep relying on checkout `node_modules`. Rejected because the hosted Linux and Windows clean runners have none.
3. Embed the exact platform addon as a Bun asset, extract it only before graph code is dynamically imported, and redirect only normalized paths ending in `/node_modules/@ladybugdb/core/lbugjs.node`. Chosen. Unrelated `process.dlopen` paths and argument counts pass through unchanged; the Ladybug loader flags are forwarded. The addon is cached under a user cache root at `madarch/native/<sha256>/lbugjs.node`. Each owned directory is checked against symlinks, POSIX directories/files use `0700`/`0600`, cache contents are SHA-256 checked on reuse, and writes use a unique file followed by atomic rename. Windows uses the per-user `LOCALAPPDATA` tree and inherited profile ACL. The loaded `.node` file is never deleted: Windows may lock it. Content-addressed entries stay until a user clears the cache after all madarch processes stop, avoiding deletion races between processes.

The CLI loads the wiki server dynamically after cache preparation. `help`, `version`, `list`, and other non-graph commands must not extract the addon. Linux's OpenSSL 3 guard remains unchanged.

The Homebrew walk now creates a uniquely named disposable local tap, puts the generated formula in it with a `file://` URL and the exact artifact checksum, installs and exercises it, then uninstalls and removes the tap. It publishes nothing. macOS and Windows artifact builds are separated from their clean-runner install tests; those jobs download only the binary and assert checkout `node_modules` is absent. Linux already uses a separate clean runner. Unix npm package generation explicitly restores mode `0755` after copying a downloaded binary, since artifact transfer does not guarantee executable mode.

### Updated review
The independent fallback review was updated with the Linux probe and found no remaining design blocker subject to strict path matching, cache integrity/permissions, atomic concurrent extraction, and target-native smoke tests. A separate-provider review could not run because the configured provider had no API key. Linux evidence does not prove macOS or Windows loader behavior; their native hosted build smokes and clean install walks remain required acceptance evidence.

### Consequences
The executable grows by the addon size. First graph use writes one cache copy; later graph use verifies and reuses it. The cache can grow when LadybugDB changes its native addon; manual removal is safe after madarch processes have stopped. The OpenSSL 3 requirement and refusal remain unchanged.
