# standalone — the madarch contract: the standalone engine and CLI (decision 0021)

Adopted 2026-10-12 (the owner's yes, in conversation via the assistant: "Да,
доработка shady2k-skills включается в веху" — outcome 7 rides along).
Preceded by idea-to-wiki (closed the same day).

The reader of the boundary is decision 0021
(docs/decisions/0021-product-repository-contract.md): madarch is the
standalone engine and CLI; the product repository format is its published,
versioned contract; the kinds are the skill set's data (the registry written
at setup); the lifecycle commands are madarch's own code; the one binary
ships in the one offline image (0010). Kubernetes CRDs, Backstage catalog
kinds and LSP are the reading.

## Outcomes and acceptance

1. **The contract stands and is checked.** One versioned schema of the product
repository format: the layout (`workspace.yaml`, `docs/`, `repos/`, the model
folder), the generic document fields (`id`, `kind`, `status`, `links`), the
kinds registry file's own fields (name, id prefix, folder, stage, a next-step
hint) and the stages as an ordered list with no fixed kinds — with
conformance examples: a conforming product without a registry, a conforming
one with it, and every refusal case with its printed words.
   *Check:* the contract's check command exits 0 on the examples, 1 or 2 on
each refusal case naming file and line (its own exit status recorded); CI
runs it (`bun run contract:check` or its landed name).
2. **madarch makes products itself.** `madarch new`, `rename`, `repo add`,
`bootstrap`, `remote` and `clone` read the contract's own files;
`vendor/shady2k-skills/*/` is gone; the lifecycle tests read the contract's
examples.
   *Check:* the acceptance walk's both roads — the agent-driven product (the
skill set installed beside) and a bare `madarch new` product — land, serve
and wiki the same; `grep -r` names no vendored program; 0019's lifecycle
clause carries the footnote "revised by 0021".
3. **The wiki knows the mechanism.** Kinds, eyebrows, groups, stage mapping
and the next-step hints come from the product's registry; no word is left in
`src/product-wiki/`, `src/wiki/`, `src/server/` or `wiki/app/src/` that names
a skill-set kind or prefix (the grep that decides it runs in the landing
walk). Without a registry the pages read, links stay, the stages show
themselves and the hints are generic.
   *Check:* side by side on today's demo product (Fieldnote, set-up) and a
registryless product: the groups, hints and eyebrow kinds equal today's when
the registry (written at setup) stands, and degrade to the generic behaviour
without one.
4. **The skills' home is the skill set.** The skills 0021 (d) moved — the
repository-describing skill and the model-writing skill — live in
shady2k-skills; a skillless product still serves its described repository
wiki.
   *Note (2026-10-13, set side confirmed):* the install contract is
   shady2k-skills 0.106.0 or later (package 0.106.0 at set main
   `37c010e`; set CI run `38362016757` succeeded), which carries the
   skills 0021 (d) moved; the engine's checkout ships none, and this line
   and the guide's install-contract line are the only places the
   repository pins the set release.
   *Acceptance (2026-10-13, engine side):* outcome 4 landed on madarch
   `main` at `0be9fdba`; main CI run `38391358475` and Product documents
   run `38391358622` succeeded. Stryker killed 66/88 mutants; the 22
   survivors are tracked by `madarch-v4vc`. Eleven older example references
   remain filed under `madarch-8nfh` and `madarch-hsz5`; the current finding
   budget use is 3 of 5.
   *Check:* the set names the moved skills and carries them green under the
set's own rules (it does not reach the set's main without the owner's own
yes); madarch's repository names them only in the install contract.
5. **One binary, distributed.** `bun build --compile`: one `madarch` binary
per platform that starts with no bun/node present; installs by npm, brew and
script; releases on GitHub with checksums; `madarch upgrade`.
   *Check:* a fresh machine walk where a bare `./madarch new` serves a
product (no bun installed); each installer proves one product served; the
release's own workflow green.
7. (the number stands after outcome 6's move to the "Left out" section). **The
skill set writes its kinds registry into a product at setup**, with
a stage and a next-step hint for every kind it owns, and its CI tests that
registry against madarch's contract schema and examples.
   *Check:* a product set up by the skills shows today's groups, eyebrows
and hints in the wiki through the registry alone; the set's CI runs the
written example against the schema and the examples on every run.

**Left out** (moved from the outcomes on 2026-10-12, by the owner's
decision of ~23:30 MSK): the Docker image (`madarch server` verified
offline, a Helm chart, the docker/k8s guide) is deferred to the server
milestone (the team and the central server, together with the data storage
boundary's PostgreSQL, decision 0023). The tracked work (madarch-uaq8) is
deferred with the branch kept (feature/standalone-image): the whole
implementation stands there and the arm64 image already builds; nothing is
discarded.

**The milestone's walk** (the owner, with Claude Code and the shady2k skills
or with the bare madarch binary): the contract's check command accepted; one
product madarch makes alone; the skills' product served through the registry
alone; the binary installed and the image offline.

**Finding budget 7** (raised from 5 by the owner on 2026-10-13, "Бери все,
бюджет поднимай", after walking the served demo wiki and judging it unusable:
the overview that says nothing of the product, mixed languages, links that do
not navigate, dead chrome — madarch-xq0v, madarch-k47i, madarch-0n3p,
madarch-gj94). Nothing planned is displaced.

**Taken in on 2026-10-13** (the owner's same words, and "Давай сделаем по
нашему продукту … создайте эти манифесты, чтобы это было понятно"):
madarch's own product wiki (madarch-wsce) — madarch served as a product from
its own documents, so a reader learns what madarch is, for whom, its vision and
where it stands. It is the milestone's walk on a real product, not only the
demo.

## Exclusions

- Agent access (MCP/API surface beyond what the server already answers),
editing by hand in the wiki, work launched from the wiki — the standing
held-out lines of idea-to-wiki stay out (madarch-yhy, madarch-mv2).
- Authentication, the central server, federation, roles (madarch-toc; 0012
stands).
- The document-form work inside products (madarch-fe1's domain, 0019): the
kinds are data, their vocabulary remains the set's.
- Anything the contract cannot express without the skill set (0021's revisit
clause).

## Scope decisions

- The tracker's rows: six epics wake under the milestone (madarch-mr8i a,
madarch-x73l b, madarch-d7v3 c, madarch-lfhu e, madarch-uaq8 f) and the
outcome 7 row madarch-d3yt, filed on 2026-10-12, each with its observable
criteria; outcome 7's work and outcome 4's live in the skill set's
repository with its own tracker. The real order: the contract (1) first; b,
c and 7 depend on it; d and 7 run in the set; e runs in parallel from the
start; f depends on e. The tracker's block edges go leaf-to-leaf when
take-task breaks the epics (the rule), so the order lives here and on each
row.
- Risks, named: the kinds removal from madarch's code (3) and the vendored
program's leaving (2) move behaviour whose independent reference is
today's demo product — both keep the demo as the fixed reference in their
walks.
- First wave started 2026-10-12: the contract (a), the skills move (d with
7), the binary (e), reviewed as they land (gpt-6-luna), no --no-verify,
standing permission to land into main.

## Next horizon

Agents through MCP and an API, editing by hand in the wiki, work launched
from the wiki, the central server with its roles and sign-in, then the
code-index feedback (madarch-mv2) and the data catalogue (madarch-1ui) ride
their own charters.
