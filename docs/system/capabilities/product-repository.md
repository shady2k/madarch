# Product repository

Capability: product-repository

## Purpose
One product's knowledge kept as Markdown and YAML in a git repository of its
own, apart from the product's code: its documents, its intended model, its
skills, its prototypes and the manifest naming the code repositories it spans
(decision 0017). Before the product has a name it exists as a draft: a folder
with a temporary name, a stable id and a complete but empty skeleton, which
the person and their agent fill in.

The product repository's lifecycle — its layout, its manifest's schema,
creating a draft, renaming it into a product and bootstrapping its code
repositories — is madarch's own code, the contract's own reading and
writing (decision 0021, revising the clause of 0019 that gave the lifecycle
to the skill set and pinned its release). `madarch new` stays a front door
for a person without an agent, and reads any folder with a valid manifest —
a set-made folder, a draft madarch made, a folder written by hand — with
the same reader whoever made the folder.

## Requirement: draft — `madarch new` creates a draft product repository with madarch's own creation code
When `madarch new` is run, it shall create, under the products home, a folder
named `idea-YYYY-MM-DD` from the day's local date — `idea-YYYY-MM-DD-2`, and
`-3` and so on when that day's names are taken — make it a git repository
whose first commit holds the skeleton, and print the product's folder and its
id. The creation itself shall be madarch's own code
(`src/product/draft.ts`; decision 0021), no program beside it: madarch
writes the skeleton itself — `AGENTS.md` (the constitution, naming the
product repository's folders and what each is for), `CLAUDE.md` holding
`@AGENTS.md`, `workspace.yaml` (the manifest), a `.gitignore` ignoring
`repos/`, the folders `docs/`, `model/`, `skills/` and `prototypes/`, each
kept by the file git needs to keep an empty folder, and `repos/` existing
and untracked. The products home shall be `~/madarch/products` unless
`MADARCH_HOME` or `--home` names another. The layout shall be the one the schema version
fixes — `docs/` for the wiki's documents, `model/` for the intended model,
`skills/` for the team's own skills, `prototypes/` for the prototypes,
`repos/` for the code repositories, untracked — and never read from the
manifest. `repos/` is the only folder untracked; `skills/` holds the team's
own skills and never a copy of the skill set (the set's pinned version is the
manifest's optional field). `AGENTS.md` shall carry the maintained-part
marker comments — opened by a comment holding `product:maintained` and
closed by the same word after a slash — so that a later version may update
that part alone and leave every other section below it, the engineer's own
included, as it was. Nothing
written into the product shall hold an absolute path to the product's folder,
and the links between its documents shall be relative paths, so the folder
can be renamed without breaking them. If an argument or the products home
cannot be used, it shall exit 2, and if creating the repository or committing
the skeleton fails it shall exit 1, each naming what failed and leaving no
folder behind.

### Scenario: new-draft
- Given: `MADARCH_HOME` names a scratch folder and the day is 2026-10-09
- When: `madarch new` is run
- Then: `products/idea-2026-10-09` exists as a git repository with one commit holding `AGENTS.md`, `CLAUDE.md`, `workspace.yaml`, `.gitignore`, `docs/`, `model/`, `skills/` and `prototypes/`, `repos/` exists untracked, and the command printed that folder and the product's id

### Scenario: second-draft-that-day
- Given: `products/idea-2026-10-09` exists
- When: `madarch new` is run again the same day
- Then: `products/idea-2026-10-09-2` is created, with its own id and its own first commit

### Scenario: home-not-usable
- Given: the path `MADARCH_HOME` names is a file
- When: `madarch new` is run
- Then: it exits 2 naming that path, and no product folder is created anywhere

### Scenario: framing-commit-fails
- Given: a products home that is created and a git that refuses to commit
- When: `madarch new` is run
- Then: it exits 1 naming what git said, and the folder it made is gone

## Requirement: manifest — A product is read from its manifest and keeps its id
The manifest `workspace.yaml` is how madarch and an agent recognise a product
repository. When a product folder is read, its manifest shall be read by
madarch's own reader (`src/product/manifest.ts`, the contract's own reading,
decision 0021), for the schema version it was written in, the
product's `id` — an opaque identifier given at creation and kept for the
product's life, whatever its folder is later called — and its `name`, which
is the folder's name for a draft; the manifest may also carry the pinned
version of the skill set and the code repositories the product spans. These
fields are never renamed; a manifest grows by fields added beside them, so a
field this madarch does not know is ignored and a manifest written by a later
madarch still opens. The reader shall refuse what the contract's manifest
cases (the examples' `manifest-cases.json`) refuse, in those cases' words and
lines, words madarch's own: a folder holding no manifest, a
manifest that cannot be read, a manifest that is not the plain subset of YAML
the schema version is written in (no anchors, aliases, tags, flow
collections, second documents, duplicate fields or tab indents), a manifest
naming no `id` or a schema version this madarch does not know, and a
`skills` or `repos` field that cannot be used — each refusal naming the file
and the line where the reader knows it.

### Scenario: draft-manifest
- Given: a draft created by `madarch new`
- When: its manifest is read
- Then: the id is the one the command printed, the name is the folder's name, and the schema version is the one madarch writes

### Scenario: manifest-without-id
- Given: a product folder whose `workspace.yaml` names no `id`
- When: it is read
- Then: it is refused, naming `workspace.yaml` and `id`

### Scenario: no-manifest
- Given: a folder holding no `workspace.yaml`
- When: it is read as a product
- Then: it is refused, naming the file it looked for and the folder

### Scenario: manifest-grows
- Given: a product whose manifest names `schemaVersion`, `id`, `name` and a field this madarch does not know
- When: the product is read
- Then: it opens, and its id and name are read as usual

### Scenario: manifest-cases
- Given: the manifest cases the contract publishes in `examples/contract/manifest-cases.json` (a draft, a name the folder gives, fields a later version adds, and every refusal, each with its printed words)
- When: `bun run contract:check` runs the cases through madarch's reader, and the reader reads each case
- Then: every case agrees — the identity, or the refusal's file, line and words the case records

### Scenario: set-made-folder-reads
- Given: the contract's example product folder with a set pinned (`examples/contract/set-made-product/`, a full manifest naming a skill set and two code repositories)
- When: madarch's reader reads it
- Then: the id, name and schema version are the example's, and the pinned set and the declared repositories are read as the manifest declares them

### Scenario: constitution-is-written-once
- Given: a draft created by `madarch new`
- When: its `AGENTS.md` is read
- Then: it names `docs/`, `model/`, `skills/`, `prototypes/` and `repos/` and what each is for, says that `skills/` holds the team's own skills, carries the maintained-part markers, and is byte for byte the constitution the contract's example product `examples/contract/set-made-product/AGENTS.md` carries

### Scenario: no-absolute-path
- Given: a draft created by `madarch new` in a scratch products home
- When: every file the command wrote is searched for that home's absolute path
- Then: none holds it

## Requirement: list — `madarch list` names the products the products home holds
When `madarch list` is run, it shall name the products of the products home
— resolved the way `madarch new` resolves it, `~/madarch/products` unless
`MADARCH_HOME` or `--home` names another — as one product at a time, in code
point order of their folders: each product's folder, its id and its name, one
fact per line. A subfolder whose manifest reads, whoever made that folder,
shall be listed; a subfolder that holds no manifest is not a product and is
not listed; a subfolder whose manifest stands but cannot be read shall be
named on standard error with the reader's words, and the products that
did read shall still be listed with exit 0. A products home that is absent
or empty shall be an empty list, exit 0; a products home that cannot be
listed — a file of that name in the way, a home that cannot be read — shall
be refused with exit 2, naming the path. `madarch list` serves nothing,
creates nothing and opens no browser; an option it does not take is refused
as unknown, naming what it accepts.

### Scenario: list-names-the-kinds
- Given: a products home holding a draft madarch made, a copy of the contract's set-made example (`examples/contract/set-made-product/`) and a hand-written one
- When: `madarch list` is run
- Then: all three are named, one fact per line, in code point order of their folders, and the command serves nothing

### Scenario: list-names-a-broken-manifest
- Given: a products home holding one product and one folder whose manifest cannot be read
- When: `madarch list` is run
- Then: the product is listed, the broken manifest is named on standard error with the reader's words, and the exit is 0

### Scenario: list-of-an-empty-home
- Given: a products home that is absent or holds no product
- When: `madarch list` is run
- Then: it exits 0 and prints nothing

### Scenario: list-home-not-usable
- Given: the path `--home` names is a file
- When: `madarch list` is run
- Then: it exits 2 naming that path

## Requirement: describe-step — madarch carries the describing step through the installed skill set
The describing step of a product — giving the product's agent both the
instructions to describe a connected repository and the place the results
land — shall be carried by the skill set's installed release, the install
contract being shady2k-skills 0.106.0 or later, and madarch's own documents
shall name the skills only in that contract line. The engineer's guide shall
name the set's release as what gives the product the describing step, the
set's installation into the product (`setup-shady2k-skills`, run by the
product's agent) laying the section below the maintained markers of the
product's `AGENTS.md` — the layout madarch's own creation writes — and
nothing of it naming a `skills/` folder of the madarch checkout as the step's
home. A checkout of madarch alone shall hold no skill folder: `skills/`
(leaving out `docs/`, `model/`, `prototypes/` and the lifecycle modules) is
absent from the repository's tree. The step's results land where the
capability already reads them: a repository's intended model with its review
report in the repository's own model folder, and the architecture page with
the derived requirements, use cases and decision records under the product's
`docs/repositories/name/`. A draft `madarch new` alone makes stays byte for
byte what madarch's own creation writes (decision 0021: the constitution is
madarch's, the section is laid below its markers by whoever runs the
product, never written into the skeleton); such a draft carries no section
until the installed set lays one.

### Scenario: the-checkout-ships-no-skills
- Given: a checkout of this repository at the change's revision
- When: its tree is listed for a `skills/` folder beside `docs/`, `model/`, `prototypes/` and the lifecycle modules
- Then: none exists — the repository holds no `skills/` folder, and no code path or test reads one

### Scenario: a-fresh-draft-carries-nothing-until-laid
- Given: a draft created by `madarch new` alone
- When: its `AGENTS.md` and its `skills/` folder are read
- Then: `AGENTS.md` is byte for byte the constitution madarch's creation writes (the example's bytes), and `skills/` holds only the kept `.gitkeep`

### Scenario: the-guide-names-the-set-release
- Given: the guide `docs/guides/start-a-product.md` at its describing step
- When: its skills step is read
- Then: it names the set's release the install contract carries (shady2k-skills 0.106.0 or later) as what gives the product the describing step, and no line of it names a `skills/` folder of the madarch checkout

### Scenario: the-registryless-product-describes-as-before
- Given: a fixture product whose manifest declares one small repository and whose agent has the set's release installed
- When: the repository is described the way the installed step describes it
- Then: the repository's model folder holds a model and a review report, the product's `docs/repositories/name/` holds the architecture page with the derived artifacts beside it, and every page the run wrote is a page of the wiki — the same places the capability reads, whoever installed the step

## Requirement: describe-skill — A product's described repository carries the artifacts the wiki reads
A repository connected to the product (declared in the manifest with `madarch
repo add` or any other way the entry was gained) shall be described into the
places the wiki reads, the description run by the product's agent through
the skill set's installed release: first the repository's intended model,
written into the repository's own model folder — `madarch/` beside the code,
the folder the model check and the wiki's diagram tab read — with a review
report beside it, every element, interface and relation carrying evidence
naming the file, the line or range, and the commit and blob it was read
from; then the architecture page `docs/repositories/name/architecture.md` in
the product's `docs/`, prose that names the model's views and links the
model's folder and the review report by relative paths; then the
capabilities found in the code as requirements and use cases marked derived
from code, in the set's product forms, each statement naming the file and
the lines it was read from; and then the decisions found in the repository's
code or its own ADRs as decision records, each linked to the model elements
it shapes. A repository holding uncommitted changes is described only after
they are committed: the evidence the model pins is committed text. The wiki
shows what the step wrote as it is saved; the described repository's
architecture page joins the design stage's material beside the kind folders
the registry names, and the product serves the same wiki with or without any
skill installed at all.

### Scenario: described-repository-shows-its-artifacts
- Given: a fixture product whose manifest declares one small repository and whose checkout is clean
- When: that repository is described the way the installed step describes it (a fixture laying the model, its review report, the architecture page, a derived requirement and use case, and a decision record where the capability reads them)
- Then: the repository's model folder holds a model and a review report the model check passes, the product's `docs/repositories/name/` holds the architecture page, at least one requirement and one use case marked derived from code with `Source: code` and `Evidence:` lines of file-and-line citations in their `Sources` sections, and one decision record naming a model id, and every page the run wrote is a page of the wiki

### Scenario: uncommitted-checkout-refused
- Given: a fixture product whose declared repository holds an uncommitted change
- When: a description is attempted against it
- Then: nothing is written, and the refusal names the repository folder and the command that showed the changes

### Scenario: evidence-is-traceable
- Given: a requirement the description derived from code
- When: its `Evidence:` line is read and each citation opened
- Then: every citation names a file of the repository and a line range, and the statement it supports reads at that place in the repository's committed text
