# The first-fill wizard offers the ACP probe's agents, says who is signed in, and installs a missing adapter into madarch's own folder on a yes

Change: madarch-tzte.22.5
Base: a2edc7de06349608349911f88f23ea34c10bf798
Tasks: madarch-tzte.22.5
Kind: no-behavior

## Intent

The owner's decision of 2026-10-19 (recorded on madarch-tzte.6, points 1–4) and
madarch-tzte.22.5's DONE WHEN: the first-fill wizard lists the agents the ACP
probe finds and whether each is signed in, offers an API-key option beside them,
and — for an agent whose ACP adapter is missing — offers one install with the
package, the pinned version and the size shown, into madarch's own folder, never
globally and never as root. madarch never asks for or stores the person's agent
credentials, and the wizard says plainly that a fill spends the plan's limits or
credit. The pieces stand on the ACP probe and client (madarch-tzte.22.1) and the
adapters walk (madarch-tzte.22.4).

What lands, in seven places:

- **`src/fill/acp-probe.ts`** carries the machine-independent half of the
  decision. Every catalogue entry now names what an install really costs with
  its dependencies (`installedBytes`, measured by the 22.4 walk), where the
  agent keeps its own sign-in (`login`), the environment variable its API key
  comes from (`apiKeyEnv`), and whether the fill can drive it (`fillAgent`). The
  install is madarch's own prefix install — `npm install --prefix` into the
  agent's own folder under the madarch home, pinned as `package@version` —
  never a global one. The probe searches that folder before PATH, for both of an
  agent's program names before either is looked for on PATH, says which of the
  two places a program came from (`foundIn`), reports each agent's sign-in state
  by checking only that its credential file is there, and names both places in
  its report.
- **`src/fill/acp-install.ts`** (new) runs the install on a person's yes: npm as
  a program, a prefix inside madarch's home, the pinned version read back from
  the package on disk and compared, the adapter's program found in
  `node_modules/.bin`, a bound on the install and a process group that ends with
  it. It refuses — before anything runs — to install as root, without npm, and
  for an agent that carries ACP in its own program, naming what to run by hand.
  A failed or refused install leaves no adapter behind: a folder that did not
  hold the pinned package before the attempt is removed, so the probe can never
  report an adapter madarch just said it could not install. npm's own output is
  shown with the registry credentials a person's `.npmrc` can put in it masked,
  and the server's log line carries only what madarch knows — the package, the
  version, the agent.
- **`src/product/home.ts`** (new) is the one reading of the three homes
  (`MADARCH_HOME` / `~/madarch`, the products home under it, the person's home),
  which `draft.ts` now re-exports, so the wizard's agents folder and `madarch
  new`'s products folder can never disagree.
- **`src/product/fill-wizard.ts`** keeps how the fill pays beside the agent and
  the model: `subscription` or `api-key`, one word, never a key.
- **`src/server/wiki-app.ts`** and **`src/server/http.ts`**: `GET
  /api/fill/wizard` carries the probe's report (`acp`, with the two places it
  searched), a new `POST /api/fill/agent-install` runs one adapter's install on
  a yes — serialised with the server's other state operations — and answers with
  the probe's finding again, and `POST /api/fill/start` takes and judges `auth`:
  an API-key fill of an agent whose variable is not set is refused by the
  variable's name, and a start that names no `auth` leaves the machine's stored
  choice as it was. The wizard's probe is bounded to ten seconds per agent, so
  the agent step answers in seconds even when an adapter hangs.
- **`wiki/app/src/fill-wizard.tsx`**, **`wiki/app/src/fill-wizard-model.ts`**
  (new) and both locales: the agent step lists the probe's agents — all of them,
  even on a machine with none of their commands — with the adapter's state and
  the person's sign-in, offers the install with the package, the pinned version
  and the installed size, prints the by-hand command beside it, and takes a "not
  now" that installs nothing and keeps that command, and offers the API-key
  choice with the variable it reads and the word that madarch never asks for it.
  An agent whose client reads no key madarch knows returns the choice to its own
  sign-in rather than leaving one the start refuses.
- **Tests**: a machine of the test's own everywhere — fake homes, fake adapters,
  and for the install a fake registry serving a fake adapter package with a fake
  npm in front of the machine's own. No test reaches the network, runs a real
  install or starts a real agent.

## Rationale

Kind `no-behavior`: the change implements accepted decisions — 0026's "Agents
and tools" and "Consequences", and the owner's decision of 2026-10-19 — without
moving a requirement the product holds. No current requirement speaks of the
first-fill wizard or of installing an adapter: the fill's own text is proposed
by change `fill-pipeline-monday` (its "fill" requirement) and is not current, and
the wizard it names is not written as a requirement anywhere yet. That text
therefore lands with the stage that closes decision 0026, exactly as
madarch-tzte.20.1 to 23.4 recorded theirs; the coverage below names the
requirements this change does hold to, not a wizard requirement invented here.

Four measurements and one reading decided the shape:

- **The size a person is shown is the install's, not the package's.** The
  registry's own figure for `@agentclientprotocol/claude-agent-acp` 0.93.0 is
  1 956 577 B (1.9 MiB) and for `@agentclientprotocol/codex-acp` 2.2.2 is
  1 748 544 B (1.7 MiB). What the install costs on disk was measured by the 22.4
  walk with `du -sb`: 313 672 155 B (299 MiB) and 461 758 222 B (440 MiB),
  because each adapter pulls the agent's own SDK (`@anthropic-ai/claude-agent-sdk`
  0.3.300; `@openai/codex` ^0.160.1) — about 160× and 264× the figure the
  registry shows. Both are kept in the catalogue with the command that measured
  them, the wizard shows the installed figure, and `pi-acp` — never measured —
  says so rather than borrowing a number.
- **Sign-in is read from the agent's own store, by presence only.** ACP's
  `initialize` says which sign-in methods an agent offers (Codex advertises
  `api-key` and `chat-gpt`), never whether one was used, and madarch must not
  ask the person for credentials. The catalogue therefore names the file each
  agent's own client keeps its sign-in in (`~/.claude/.credentials.json`,
  `~/.codex/auth.json`, read from the machines the agents run on), and the probe
  says `signed-in`, `not-signed-in` or `unknown` — never a guess — with the path
  it looked at. omp keeps no sign-in madarch knows and pi's is not known at all,
  so both are `unknown`.
- **An API key is a name, never a value.** The person may choose to spend a key
  instead of a subscription. madarch does not ask for the key, read it or store
  it: the choice is one word in the machine's settings file, and the key is
  whatever the agent's own client reads from its environment
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). The wizard names that variable, the
  start route refuses an API-key fill of an agent whose variable is not set, and
  the refusal names the variable. omp has no such variable madarch knows, so its
  API-key choice is refused by name rather than half-done.
- **The install is npm's, into madarch's own folder.** The adapter packages are
  npm packages, and the owner's decision is that the person fetches them from
  npm on that registry's terms rather than having them bundled; the 22.4 walk
  installed exactly these two packages with npm. madarch runs npm as a program
  (it imports no package manager), into the agent's own folder under the madarch home, so the
  version moves with madarch and never under a person's other tools, and no
  global prefix and no root are involved. The pinned version is read back from
  the package on disk and compared, because an install that unpacked another
  version is not the install that was promised.
- **A row is a choice while the agent's own command is installed.** The fill
  that starts today drives the agent's own CLI (`src/product/fill-agents.ts`),
  while the ACP adapter is what the rebuild's units will drive. Requiring a
  connected adapter before offering the agent would refuse a fill that works on a
  machine today, so the row is selectable when the command is there, and the
  adapter's state — and its install — stand beside it.

## Out of scope

- **Driving the fill's own units over ACP from the wizard's start.** The start
  still reaches the landed pipeline; wiring the orchestrator and its ACP units to
  the wizard is a later task of stage madarch-tzte.22.
- **Any handling of a key beyond its name.** No key is asked for, read, written,
  logged or passed to a child process by madarch; an API-key fill relies on the
  agent's own client reading its own environment, and no test sets a real key.
- **Sign-in stores on other systems.** The Linux paths the agents use are the
  ones checked; a person signed in through a keychain elsewhere reads as
  `not-signed-in`, and the wizard's Test button — which runs one short agent
  call — is the check that settles it.
- **Installing an agent that carries ACP itself.** omp and pi are installed from
  their own projects; madarch names that and refuses to invent a package.
- **The wiki's pages and diagrams.** No page, no view and no renderer changes;
  the wizard is the app's own view and no product document is written.

## Preserved contracts

- product-wiki/app: the wizard stays the app's own view at the same address; every message it shows is in the two locales the app speaks, and the payload's existing fields (`agents`, `chosen`, `model`, `runExists`) keep their shapes, so a page that read them before reads them the same.
- server/serves-wiki: the product routes, their refusals and their log line are unchanged; one POST route is added, and the wizard's GET only adds fields. Two exported members move with it and the record says so rather than leaving them to be found: `WikiPart` loses `fillStart` — a handler nothing routed and that no test or script called, whose `startFill` parameter `createWikiPart` already ignored — and `createWikiPart`'s last parameter becomes its options (`{ env }`), which the server's two call sites pass. A server that implements `WikiPart` itself, or calls `createWikiPart` with a fifth `startFill` argument, is the one that sees it.
- server/protocol: the unit tool route, the model routes and their order are untouched; the added route answers JSON whose refusal names the agent it does not know, the agent it cannot install, or the failure with the folder, the package and the version.
- product-repository/contract: no product kind, form or name enters the engine; the catalogue names agents and packages, and the agents folder lives beside the products home, never inside a product repository.
- release-binary/installers: the binary still builds and runs without importing a package manager; the ACP client and the installer are loaded only by the probe and by an install, and npm is run as a program on PATH, never linked.
- product-wiki/internationalization: both catalogues carry every new word; the agent states, the sign-in states, the install offer and the key's variable are the app's own strings, not English sent from the server.

## Coverage

- product-wiki/app: test
- server/serves-wiki: test
- server/protocol: test
- product-repository/contract: test
- release-binary/installers: test
- product-wiki/internationalization: test

## Blocking questions

None.

## Design and decisions

Taken from decisions 0026, 0027 and 0005 and the owner's decision of
2026-10-19; nothing here re-decides them.

- **madarch's own folder for agents is one folder per agent under the madarch home.**
  `MADARCH_HOME` names the madarch home (`~/madarch` by default) and the products
  home is `products` under it, so the agents live beside the products rather than
  inside any product. One module reads the three homes (`src/product/home.ts`)
  so a wizard, a command and a test never disagree about them.
- **The probe searches madarch's folder before PATH, and says which it used.** A
  machine can hold an adapter on PATH and another one under madarch; the one
  madarch pinned is the one madarch starts, and `foundIn` lets a reader see
  which program answered. The child is spawned with that folder first on its own
  PATH, so an adapter that starts helpers finds them.
- **The install is refused before it runs, not half-done.** Root, a machine
  without npm and an agent with no package are refusals that name the by-hand
  command; a folder that cannot be made, an installer that fails or times out,
  another version on disk and a package with no program are failures that name
  the folder, the package, the version and the end of what npm said. A refusal or
  a failure leaves no agent that the probe would report as installed.
- **The install's answer is the probe's, not the installer's.** The route
  re-probes after a successful install and answers with the finding, so the
  wizard shows what madarch now finds rather than what npm claimed. The route is
  serialised with the server's other state operations, so two tabs cannot run
  two installs into one folder at once.
- **A failure installs nothing new, and a credential is never shown.** A folder
  madarch made for the attempt is removed when the attempt fails, so the probe's
  next answer is the truth; a folder that already held the package is kept and
  named in the failure. npm's output is kept for the person with the registry
  credentials a `.npmrc` can put into it masked — `_authToken`/`_auth`/
  `_password` in `.npmrc` and in JSON form, a password in a URL, a `token` or
  `access_token` in a query string, a bearer token, an `npm_` token — and the
  server's log line names only the package, the version and the agent.
- **A stopped install ends before its tree is removed.** A run past its bound is
  signalled as a process group (SIGTERM, then SIGKILL after two seconds), and
  the failure is written only once that group has ended and its output closed:
  the tree is never removed under a process that is still writing, and the last
  thing npm said reaches the message.
- **One environment answers one wizard request.** The server's `env` decides the
  agent command list, the stored choice's home, the probe's search path and the
  key variable's presence; the fill a start begins still runs in the process's
  own environment, which is the same thing unless a server was given another one
  — as tests do.
- **An install has its own lock.** Two tabs cannot run two installs into one
  folder at once, and npm runs outside the model state's lock, so a person can
  still pause or stop a fill while an adapter installs.
- **The wizard says which places it searched.** Both the report and the wizard's
  payload carry the PATH and madarch's agents folder; a row that found nothing
  names both, and a row that found an adapter says which of the two it came
  from.
- **"No" is a control, not a silence.** The install offer stands with a "not
  now" beside it; taking it installs nothing and leaves the by-hand command on
  the row. Nothing is installed without a click either way, and the by-hand
  command is shown beside the offer, not only after a refusal.
- **The API-key choice is judged where it is used.** The start route refuses an
  API-key fill whose variable is absent, by the variable's name, and an agent
  with no key madarch knows is refused as such; the choice is saved only after
  that judgement, so a refused start changes nothing on the machine.
- **pi is reported by the probe and never offered by the wizard.** The catalogue
  carries pi and its package because `madarch fill --probe-acp` must report what
  the machine holds, while the fill cannot drive pi yet: the wizard's rows are
  the entries that name a fill agent, so pi is no row and no install offer of
  madarch's — the probe's report still names it, with the by-hand command.
- **The wizard's own module reads the payload, not the view.** `agentRows`,
  `installOffered`, the two state keys and `apiKeyVariable` live in
  `fill-wizard-model.ts` and are tested without a browser; the view only renders
  what they say.
- **Open points and known limitations**, named here rather than left to be found:
  - **A sign-in store's absence is not proof of a sign-out.** The probe checks a
    file's presence and never its content, so a machine whose agent signed in
    through a keychain — macOS, say — reads `not-signed-in`; the wizard's Test
    button is the check that settles it, and it costs one short agent call.
  - **pi's install has no measured size.** The catalogue carries the registry's
    `dist.unpackedSize` for `pi-acp` and no installed figure, so the wizard says
    the size is not measured rather than showing the misleading small one.
  - **An install needs npm on the machine.** The release binary invokes npm as a
    program; a machine without Node.js and npm is refused with the by-hand
    command, and madarch neither bundles npm nor installs it.
  - **A failed install removes only the folder it made.** A folder that already
    held the package — any version of it — is a person's adapter and is left
    untouched, and the failure says which version still stands there; that
    person's next probe still reports the adapter it had. Only a folder this
    attempt made from nothing is removed, so the probe never reports an adapter
    madarch just said it could not install.
  - **The install runs in madarch's own environment.** npm inherits this
    process's environment with the server's `env` over it, so the person's
    `HOME`, their `.npmrc` and madarch's own registry settings are what npm
    reads; madarch hands it no registry of its own and no credential.
  - **The wizard's report stands for two seconds.** Two loads within that window
    are one answer and one probe, so the page's own reload after a start costs
    no agent process; an install answers with its own fresh report.
  - **The wizard's probe is bounded at ten seconds per agent.** An adapter that
    does not answer `initialize` in that time is a row that says it did not
    connect; `madarch fill --probe-acp` keeps the client's own thirty seconds.
  - **Madarch's folder for an agent is named after the agent the fill drives**
    (`agents/claude`, `agents/codex`, `agents/omp`) and after the catalogue's own
    id for an agent the fill cannot drive yet (`agents/pi`).
  - **The chosen agent's CLI is still what the started fill runs.** The adapter's
    state is reported and installed, but nothing today refuses a start whose
    agent has no adapter: the landed pipeline drives the CLI. Wiring the ACP
    units to the start is named in "Out of scope".
  - **No `mutation` receipt.** The owner's rule runs Stryker once per assembled
    stage, off the path; acceptance escalates per `mutationFallback: escalate`.

## Acceptance evidence

The checks, each command's own exit status, at hand-over. Tests and builds run
in SkyPilot, not on this machine (the owner's rule of 2026-10-18); the
type-check and the document gate run locally.

- `bun run check` (`tsc --noEmit`): exit 0 at every edit round and at hand-over.
- The feature document gate (`node .shady2k/documents.mjs check --phase feature
  --change madarch-tzte.22.5 --candidate worktree --target origin/main`): exit 0,
  clean, after every edit round and at hand-over (the commit message hook runs it
  too).
- `madarch-sky-test <worktree> test/fill-acp-install.test.ts
  test/fill-acp-probe.test.ts test/server-wiki.test.ts test/fill-wizard.test.ts
  test/fill-agents.test.ts test/product-cli.test.ts test/product-draft.test.ts` —
  **229 pass, 0 fail, exit 0** (`run-20261019-202304`), the state both review
  rounds' answers are in. Before round 2's answers the same six of those files
  were **192 pass, 0 fail, exit 0** (`run-20261019-195857`), and before round 1's
  answers four of them were **89 pass, 0 fail, exit 0** (`run-20261019-194633`).
- The direct importers of the moved homes (`src/product/draft.ts` and the new
  `src/product/home.ts`): `madarch-sky-test <worktree> test/product-draft.test.ts
  test/product-cli.test.ts test/product-lifecycle.test.ts
  test/product-daemon.test.ts test/product-demo.test.ts test/server-http.test.ts
  test/contract-serve.test.ts` — **223 pass, 0 fail (1 skipped), exit 0**
  (`run-20261019-193501`).
- The wiki app's own checks and build, `cd wiki/app && bun install
  --frozen-lockfile && bun run check && bun test && bun run build`: **219 pass, 0
  fail, check and build exit 0** (`run-20261019-201953`).
- The real-server reader E2E on `--avx2` (Chromium against the built app,
  `MADARCH_WIKI_E2E=1`): **4 pass, 0 fail, exit 0** (`run-20261019-202302`), with
  the agent step read as a reader sees it in a 1150 px window: the three rows
  stacked (each agent's state 32 px and its sign-in 26 px under its name), no
  word under 12 px, nothing scrolling sideways, the step 696 px wide and 1203 px
  tall. The screenshot is `/tmp/wizard-agent.png` on the pod; the worker's model
  reads no image, so the numbers above are the acceptance and the PNG is kept
  for a reader who wants the picture.
- The independent review, a fresh read-only `prime-agent --provider
  shady2k-gateway --model deepseek-v4.1-flash-auto` session over `git diff
  origin/main...HEAD`, told to run nothing on this machine:
  - Round 1 (`/tmp/review-225.log`): verdict `fix-before-ship`; four defects — a
    failed install left a tree the probe then reported as connected; the wizard
    dropped the probe's rows when no agent command was on PATH; the route tests
    ran the real probe against the machine's PATH; npm's own output could carry a
    registry credential into the answer and the log line — plus seventeen
    findings. All four are answered with the test that catches each (the folder a
    failed install made is removed and a re-probe says not-installed; the rows
    render under the none-note, with an app test; `ServerOptions.env` reaches the
    wizard's probe and the install, and the server tests pass an env of their
    own; `redactInstallerOutput` masks the credentials and the log line names
    only the package, the version and the agent, with a test that puts a token in
    npm's output).
  - Round 2 (`/tmp/review-225b.log`), a second fresh session told to verify each
    answer: verdict `fix-before-ship`; it found defect 3 answered only half-way
    (the wizard's command list and stored choice still read the process's
    environment, and the install test still appended the machine's PATH to the
    fake npm's), defect 1 answered with a rule that would delete a person's
    adapter of another version, the timeout path removing a tree a still-running
    installer could write to, and nine smaller things. All are answered in this
    revision with the test that catches each: one environment per wizard answer
    (the command list, the stored choice's home, the probe and the install) with
    a test whose fake machine has one command and its own home; the install test
    runs with the fake npm's folder alone and asserts one connected row; a
    failed install keeps a folder that already held the package and says which
    version stands; a stopped install waits for its process group and keeps its
    last words; the install has its own lock; the wizard's report stands two
    seconds; `Object.hasOwn`; a wider credential mask, the JSON and query forms
    included; the redacted installer output returned on success too; the key
    variable follows the agent rather than its command; the stored API-key
    choice returns to the subscription for an agent with no key; the fixtures'
    `agents/claude`; the record's two corrected sentences and the exported
    surface named in "Preserved contracts".

## DONE WHEN

- The first-fill wizard lists the installed agents found by the ACP probe, whether each is logged in, and an API-key option; the person picks one.
- An agent whose ACP adapter is missing is offered one install with its package, pinned version and size shown; on yes madarch installs it into its own folder, never globally and never as root, and the probe then finds it. On no, nothing is installed and the wizard says how to install it by hand.
- madarch never asks for or stores the person's agent credentials; the wizard states that a fill spends the plan's limits or credit.
- Tested with a fake registry and a fake adapter package (no network, no real agent); the real install is the 22.4 walk.
