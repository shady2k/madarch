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
When `madarch new` is run with a positional name, it shall validate that name
as one portable folder name and create that exact folder under the products
home. When no name is given, it shall keep the dated `idea-YYYY-MM-DD` name
from the day's local date — `idea-YYYY-MM-DD-2`, and `-3` and so on when
that day's names are taken. In either form it shall make a git repository
whose first commit holds the skeleton, and print the product's folder and its
id. A named folder already in use or an unusable name shall be refused with
exit 2, without replacing or changing anything. The creation itself shall be madarch's own code
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

### Scenario: named-draft
- Given: `MADARCH_HOME` names a scratch folder and `sample-product` is not present
- When: `madarch new sample-product` is run
- Then: `products/sample-product` is created as a git repository with its own id and first commit, and both its folder and id are printed

### Scenario: named-draft-refuses-an-existing-folder
- Given: `products/sample-product` already exists
- When: `madarch new sample-product` is run
- Then: it exits 2 naming the existing folder and leaves its contents unchanged

### Scenario: named-draft-refuses-a-nonportable-name
- Given: the requested name `bad/name` contains a path separator
- When: `madarch new bad/name` is run
- Then: it exits 2 naming `bad/name` before creating a folder

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

## Requirement: contract — the product repository's mechanism is a published, versioned schema, read by the version the registry carries
The read side of the product repository's format — the generic fields a
document may carry (`id`, `kind`, `status`, `links`), the kinds registry's
own shape and the stages as an ordered list with no fixed kinds — is
madarch's published, versioned JSON schema, at
`schema/product-registry.schema.json`, generated from one TypeBox source
beside the model schemas' sources, so the published file cannot drift from
the code. The registry file carries the contract version it is written
against, `contract: 1`, written as its first line and read wherever it
stands (the owner's refinement of
decision 0021, 2026-10-12); the published schema carries the same version
in its `$id`
(`https://github.com/shady2k/madarch/schema/v1/product-registry.schema.json`),
and the version in the file and the version in the `$id` are the same
number. A kinds registry is one file under the product's `docs/`
(`docs/kinds.yaml`); a product may hold none, in which case every page
keeps the plain page behaviour it had and nothing of a kind is computed.

At contract version 1 the registry names, per kind: its name, its id
prefix, the folder the kind's documents live in (`docs/…`), the stage it
belongs to, a next-step hint; the statuses its documents may carry, in the
order the reader walks them (a kind that names no status constrains
none); and the link fields it declares, each as data (nothing read by
name): the field's name as the document writes it, the kinds the field's
targets may name, by the kinds' names, the words the target's page shows
the backlink under, whether the field holds one target or many (`many`
stands where it is left out), and whether a document of the kind without
the link is a finding (`false` stands where it is left out).

The manifest also reserves what contract v1 does not implement (the 0021
amendment as the owner refined it): each kind may name the storage form it is
kept in — `document` (the only form this engine version implements), `task`,
`model-element`, `component`, and `fact`, an entity imported from a system,
carrying its evidence as the field names the fact's document carries (source
system, ref or commit, record id), its truth held by the system it came from,
read-only in the wiki, in one graph with the authored entities and their
links; the evidence shape rides the `fact` form, and a kind carrying it
without naming the form is refused. The manifest may carry the reserved
`goals` section, an optional list of maturity levels, each naming its rules
over the graph and the perspective it is granted for. A storage form this
engine version does not implement, an imported fact's evidence and the goals
section are kept as data and named by the engine's honest reservations — words saying what this engine version does not
do (it serves documents only, does not read imported graphs, does not
compute maturity levels) — never silently dropped, never a
silent unknown section; their words ride the reading's own answer
(`read.reservations`, the words at the field lines) and are covered by the
contract's own cases. Product-scoped global ids,
the lifecycle's milestones and the roles section are the amendment's
reservations in prose; their shape arrives with the milestone that
implements them.

The reading (`parseContractText` in `src/product/contract.ts`) refuses in
values, never thrown: strict YAML, then the schema, then the fields' own
checks — the contract version gate (a registry that is no mapping at all
is the schema's refusal; a mapping that carries no `contract`, a
`contract` that is not a whole number, or a whole number madarch does not
read, is refused naming what stands), the prefix's shape, the folder under
`docs/` (no leg climbing out), the stage naming a stage of the list, the
hint carrying words, a prefix named once, a stage id named once, a status
named once within its kind, a link field named once within its kind, a
link field never carrying one of the generic fields madarch reads itself
(`id`, `kind`, `status`, `links`), and every target naming a kind the
registry declares — every refusal naming the file, the line the field
stands on, the field's path from the registry's top (empty for a file
that does not parse as YAML at all), and the words a reader prints. The generic document fields are read from every Markdown
under the layout (`parseDocumentFields`), with their own published schema
(`schema/product-document.schema.json`): `id`, `kind`, `status` and
`links` read from the document's lines before its first heading after
line 1 (the identity line itself is not a field), a field
case-insensitively spelled (`Kind:` read as `kind`), an unknown field
ignored the way a manifest grows by fields, `links` a comma-separated
list of ids, and every field but `links` given once (repeated `Links:`
lines add to one list). The check command
(`bun run contract:check`, beside `bun run views:check`) walks the
conformance examples — three example product folders, one without a
registry, one with it and one the skill set made, read as the layout, the documents' fields and
the registry naming no refusal — and the registry and document-field
refusal cases, each carrying the printed words — and exits 0 when every
case reads the way its words say and 1 naming the file, the line and the
words of every mismatch; CI runs it.

The wiki that serves the product opens the registry the same way. A
registry at a version madarch reads, reading whole, serves as a registry:
at contract v1 the pages' kinds, statuses and groups are the set's own
computed reading until the registry lane moves them onto the
declarations. A registry of a version madarch does not read, or one that
refuses its own reading, is never a failure: the served wiki names what
stands (the version it found and the version it supports, or the
reading's refusals, each with file and line) as a banner over the pages,
and the pages are served plain — no kind, no status, no fields, no links
— for as long as the registry does not read again. The registry's bytes
are digested with the pages', so an edit to it (a kind added, a version
changed, a malformed moment in between) is a change the server-sent
stream reports and the next answer carries, with no restart.

### Scenario: registry-reads
- Given: a product whose `docs/kinds.yaml` opens with `contract: 1`, names the stages `idea` through `operate` in order and the kinds `source` (prefix `S`, `docs/sources`), `hypothesis` (prefix `H`), `product requirement` (prefix `FR`, `docs/requirements`) and `decision` (prefix `D`)
- When: the registry is read
- Then: it reads at version 1 with 7 stages and 4 kinds, each kind's stage one of the list, and the published schema carries the version in its `$id` and matches the TypeBox source byte for byte

### Scenario: registry-declares-links-and-statuses
- Given: a registry whose `user story` kind names the statuses `draft`, `ready` and the link fields `Serves` → `UC` (backlink `Served by`, many, required) and `Grew from` → `S`, `H` (backlink `Grew into`)
- When: the registry is read
- Then: the statuses and the links are read as the pieces of data they are, a target naming a kind declared after the carrying kind reads, and the example product's registry carries the owner's example declarations

### Scenario: registry-refusals
- Given: the refusal cases the contract's examples carry (the version missing, not a whole number or not one madarch reads; a prefix, a folder, a stage, a hint, a status or a link field out of shape; a target naming no declared kind)
- When: the check command runs
- Then: each case is refused naming its file and line with the words the case records, and the check, finding every case read the way its words say, exits 0 (it exits 1 only on a misread case)

### Scenario: no-registry
- Given: a product whose `docs/` holds no registry file
- When: the product is read
- Then: no refusal is raised and no field of no kind is computed

### Scenario: document-fields-read
- Given: a document whose header carries `Id: FR-001`, `Status: open`, `Kind: product requirement` and `Links: S-001, H-001`
- When: its fields are read
- Then: all four are read with those values, an unknown field beside them is ignored, and the published document-fields schema matches the TypeBox source byte for byte

### Scenario: document-fields-refusals
- Given: the document-field cases the contract's examples carry (a field written twice, a kind that is not a word, a links value with no entry)
- When: the check command runs
- Then: each is refused naming its file and line with the words the case records

### Scenario: unknown-version-served
- Given: a served product whose `docs/kinds.yaml` carries `contract: 99`
- When: the wiki is asked for its pages
- Then: the answer names the version — "the registry declares contract 99; this madarch reads contract 1" — with the file and line, the wiki shows it as a banner, and the pages serve plain (no kind, no document block), never a refusal of the start

### Scenario: broken-registry-served
- Given: a served product whose `docs/kinds.yaml` carries a reading refusal (a prefix that is not a prefix, an unparseable file)
- When: the wiki is asked for its pages
- Then: the answer names every refusal with file, line and words, the wiki serves the pages plain under the banner, and an edit that makes the registry read again restores the served kinds with no restart

### Scenario: reserved-storage-forms-kept-and-named
- Given: a registry whose `configuration item` kind declares `storage: fact` with its evidence field names, and a `goals` section naming one level per perspective
- When: the registry is read
- Then: it reads at version 1 with the fact kind and its evidence kept as data, and the engine's reservations name the fact's form, the evidence and the goals section at their lines — never a refusal, never a drop

### Scenario: evidence-without-the-fact-form
- Given: a registry whose kind carries an `evidence` shape without declaring `storage: fact`
- When: the registry is read
- Then: it is refused at the evidence field's line, naming the fact storage form the evidence rides

### Scenario: registry-edit-is-a-live-change
- Given: a served product whose registry reads and whose reader holds the pages answer
- When: the registry file is edited (any byte)
- Then: the pages revision moves, the way a page's edit moves it, so the wiki's stream reports the change and the next ask carries it

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
