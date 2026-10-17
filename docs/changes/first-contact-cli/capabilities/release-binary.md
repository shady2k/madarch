# Release binary

Capability: release-binary

## Purpose
The madarch command as one compiled binary per platform (decision 0021's one
binary, the charter's outcome 5): `madarch new`, `serve`, `list` and every
other command of the checkout work with no bun, no node and no node_modules
on the machine, the wiki app's built files riding inside the binary. The
release distributes the binaries with their SHA256 sums, crafts the npm
packages that wrap them and the Homebrew formula of the sums, and carries one
install script; `madarch upgrade` takes an installed binary to the newest
release.

## Requirement: version — The binary answers the release version it was built at
When `madarch version` is run in a release binary, it shall answer one fact,
`version:` and the release version the binary was built at, and exit 0. In a
source checkout — where `madarch upgrade` is also refused (below) — the
version shall be `dev`. The release build lays the version into the binary
with the wiki app's built files (scripts/build-binary.ts), and refuses to
build without it: a release binary that carried no version would be a binary
of nobody's release.

### Scenario: binary-answers-its-release
- Given: the release binary of local test 0.1.0
- When: `madarch version` is run
- Then: it prints `version: 0.1.0` and exits 0
### Scenario: checkout-says-dev
- Given: a source checkout of the release
- When: `madarch version` is run
- Then: it prints `version: dev` and exits 0

## Requirement: upgrade — The binary takes itself to the newest release after a yes
When `madarch upgrade` is run in a release binary, it shall ask the
repository's releases for the newest release, print a confirmation naming both
versions — the binary's own and the release's — the artifact of the running
platform and the replace target, on standard error before the read, and read
one line from standard input as the answer:
the answer `y` or `yes` proceeds (the binary of the running platform is
downloaded, its checksum is compared against the release's checksum file, the
comparion holds, and the running executable's path is replaced with the
downloaded binary whose mode keeps it runnable), and every other answer,
including a closed input, refuses the upgrade with the binary untouched. A
checksum that does not match names it, refuses the replace, and leaves the
binary alone. A release the binary is already at shall print that nothing
needs doing, exit 0. A release without the artifact of the running platform
shall be refused naming the artifact the release would carry; a release the
API cannot read shall be refused with the API's address and the status; a
network that cannot be reached shall be refused naming the cause. In a source
checkout `madarch upgrade` shall refuse naming that source before the
network. On a platform with no release artifact the command shall refuse
naming it.

### Scenario: yes-replaces
- Given: a binary at 1.0.0 and a release v1.1.0 whose artifact matches the release's checksum
- When: `madarch upgrade` is run and the answer `y` is given
- Then: the executable's path holds the release bytes in a runnable mode, the run prints `upgraded to v1.1.0`, and the current binary stays itself until the next launch
### Scenario: no-answer-refuses
- Given: a binary at 1.0.0 and a release v1.1.0
- When: `madarch upgrade` is run and the answer is `n` (or empty)
- Then: it refuses naming the target version and the binary still holds its own bytes
### Scenario: already-current
- Given: a binary at version 1.2.3 whose release v1.2.3 is the newest
- When: `madarch upgrade` is run
- Then: it prints `already at 1.2.3: nothing to upgrade` and exits 0
### Scenario: checksum-mismatch
- Given: a release whose artifact does not match its checksum line
- When: `madarch upgrade` is run and the answer `y` is given
- Then: it refuses the replace naming the expected and the actual digest, and the binary still holds its own bytes
### Scenario: release-without-the-artifact
- Given: a release whose assets carry no binary of the running platform
- When: `madarch upgrade` is run
- Then: it refuses naming the artifact it looked for
### Scenario: source-checkout-refuses
- Given: a source checkout
- When: `madarch upgrade` is run
- Then: it refuses naming the source checkout before the network, exit 2
### Scenario: the-question-is-named-before-the-answer
- Given: a binary at 1.0.0 and a release v1.1.0 whose answer matters
- When: `madarch upgrade` is run and the read of the answer begins
- Then: the confirmation naming both versions and the target stands before the read reads a byte
### Scenario: yes-flag-asks-nothing
- Given: a binary at 1.0.0 and a release v1.1.0
- When: `madarch upgrade --yes` is run
- Then: no question is asked and the upgrade proceeds exactly as a typed y does

## Requirement: installers — One binary, installed without a build
The release carries binaries for Linux and macOS x64/arm64 and Windows x64,
the checksum file of them all, the npm packages (one platform package under
the `@madarch` scope with the binary, the `madarch` package whose bin starts
the running platform's binary and forwards its exit), a Homebrew formula reading
the sums, a POSIX install script and a PowerShell install script. Windows
arm64 binaries are not provided. The build smoke and installed walks execute
`madarch new`, open the graph store, and serve the product. The compiled binary
runs without Bun, Node.js, or a system OpenSSL installation. `madarch new` requires Git and its author
identity to be configured. Nothing installed reads a skill set, per decision
0021: the wiki app, the command's parsing and its facts ride inside the
binary or the thin wrapper.

The POSIX and PowerShell install scripts shall finish by printing the same two start commands: create a product with `madarch new`, or enter a code repository and run `madarch init` to start a product around it. This guidance does not change the installed binary or its version output.

### Scenario: installed-version
- Given: the binary installed by the install script (or the npm package, or the Homebrew tap)
- When: `madarch version` is run
- Then: it names the release version installed and exits 0
### Scenario: installed-product-runs
- Given: the binary installed by npm, Homebrew, the POSIX install script or the PowerShell install script
- When: `madarch new` is run naming a scratch products home and the port of the walk's own
- Then: the product folder and id are printed (the same facts), then the wiki is served from the address it prints, no bun or node anywhere on the walk's way
### Scenario: platforms-covered
- Given: the release's checksum file
- When: its lines are read
- Then: they name exactly `madarch-linux-x64`, `madarch-linux-arm64`, `madarch-darwin-x64`, `madarch-darwin-arm64`, and `madarch-windows-x64.exe`, each with a 64-digit SHA256 sum

### Scenario: compiled-binary-has-no-runtime-prerequisites
- Given: a clean supported machine with Git configured
- When: the compiled binary runs `new` and `serve`
- Then: it opens the graph store and serves the product without Bun, Node.js, or system OpenSSL

### Scenario: windows-platform-selection
- Given: Windows x64 or Windows arm64
- When: `npx madarch new` is run
- Then: x64 selects `@madarch/win32-x64` and the Windows executable; arm64 is refused by name, with no unsupported package lookup

### Scenario: branch-release-workflow-does-not-publish
- Given: a branch workflow run building and testing release assets
- When: the workflow's release-step behavior is checked
- Then: it performs no GitHub release, npm publication or tap push; a tag release requires `HOMEBREW_TAP_TOKEN` by a named step before the tap push
