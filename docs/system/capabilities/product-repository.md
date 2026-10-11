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
repositories — is the skill set's product-repository program (decision 0019).
madarch bundles one pinned release of that program, so `madarch new` stays a
front door for a person without an agent, and reads any folder with a valid
manifest — a set-made folder, a draft madarch made, a folder written by hand
— through the same pinned reader.

## Requirement: draft — `madarch new` creates a draft product repository through the pinned program
When `madarch new` is run, it shall create, under the products home, a folder
named `idea-YYYY-MM-DD` from the day's local date — `idea-YYYY-MM-DD-2`, and
`-3` and so on when that day's names are taken — make it a git repository
whose first commit holds the skeleton, and print the product's folder and its
id. The creation itself shall be performed by the skill set's
product-repository program, at the release pinned in madarch's checkout;
madarch shall hold no creation code of its own beyond its own decisions: the
products home, and the day a test names. The skeleton is what the pinned
program writes: `AGENTS.md` (the constitution, naming the product
repository's folders and what each is for), `CLAUDE.md` holding `@AGENTS.md`,
`workspace.yaml` (the manifest), a `.gitignore` ignoring `repos/`, the folders
`docs/`, `model/`, `skills/` and `prototypes/`, each kept by the file git
needs to keep an empty folder, and `repos/` existing and untracked. The
products home shall be `~/madarch/products` unless `MADARCH_HOME` or `--home`
names another; this is madarch's decision, given to the program, which reads
no home from anywhere else. The layout shall be the one the schema version
fixes — `docs/` for the wiki's documents, `model/` for the intended model,
`skills/` for the team's own skills, `prototypes/` for the prototypes,
`repos/` for the code repositories, untracked — and never read from the
manifest. `repos/` is the only folder untracked; `skills/` holds the team's
own skills and never a copy of the skill set (the set's pinned version is the
manifest's optional field). `AGENTS.md` shall carry the program's marker
comments around the part the program maintains — the pair the program's own
example names, opened by a comment holding `product:maintained` and closed
by the same word after a slash — so that a later version may update that
part alone and leave every other section, the skill set's included, as it
was. Nothing
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

### Scenario: same-folder-two-ways
- Given: a draft created through the pinned program
- When: the same draft is created by running the set's program beside the pinned release, on the same day in the same products home
- Then: everything but the id and the folder's name is the same bytes

## Requirement: manifest — A product is read from its manifest and keeps its id
The manifest `workspace.yaml` is how madarch and an agent recognise a product
repository. When a product folder is read, its manifest shall be read by the
pinned program's reader, for the schema version it was written in, the
product's `id` — an opaque identifier given at creation and kept for the
product's life, whatever its folder is later called — and its `name`, which
is the folder's name for a draft; the manifest may also carry the pinned
version of the skill set and the code repositories the product spans. These
fields are never renamed; a manifest grows by fields added beside them, so a
field this madarch does not know is ignored and a manifest written by a later
madarch still opens. The reader shall refuse what the set's manifest cases
refuse, in the set's words and lines: a folder holding no manifest, a
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

### Scenario: set-manifest-cases
- Given: the manifest cases the skill set publishes with the program (a draft, a name the folder gives, fields a later version adds, and every refusal)
- When: madarch's reader reads each case
- Then: every case agrees with the set's own reader — the identity, or the refusal's line and message

### Scenario: set-made-folder-reads
- Given: the set's example product folder (a full manifest naming a skill set and two code repositories)
- When: madarch's reader reads it
- Then: the id, name and schema version are the example's, and the pinned set and the declared repositories are read as the manifest declares them

### Scenario: constitution-is-written-once
- Given: a draft created by `madarch new`
- When: its `AGENTS.md` is read
- Then: it names `docs/`, `model/`, `skills/`, `prototypes/` and `repos/` and what each is for, says that `skills/` holds the team's own skills, carries the program's maintained-part markers, and is byte for byte the constitution the pinned program's own example names

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
named on standard error with the reader's own words, and the products that
did read shall still be listed with exit 0. A products home that is absent
or empty shall be an empty list, exit 0; a products home that cannot be
listed — a file of that name in the way, a home that cannot be read — shall
be refused with exit 2, naming the path. `madarch list` serves nothing,
creates nothing and opens no browser; an option it does not take is refused
as unknown, naming what it accepts.

### Scenario: list-names-the-kinds
- Given: a products home holding a draft madarch made, the set's made folder and a hand-written one
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

## Requirement: describe-step — madarch carries the describing step for a product to lay in
madarch shall carry the describing step in its checkout, beside the pinned
program, in one folder — `skills/describe-repository/` — holding the
describing skill's `SKILL.md` and the section text `AGENTS-section.md` an
engineer or their agent lays below the pinned program's maintained markers
of a product's `AGENTS.md`. The section shall say that a code repository
entered with `madarch repo add` is described before work begins; that the
description follows the product's own skill `skills/describe-repository/`;
and that the description writes the repository's intended model, with its
evidence, into the repository's own `madarch/` folder, the architecture
page under the product's `docs/repositories/name/`, the capabilities found
in the code as requirements and use cases marked derived from code, and
the decisions found in the code or its ADRs, each linked to the model
elements it shapes. It shall say that a repository holding uncommitted
changes is described only after they are committed, and that every page is
written under `docs/` so the wiki shows it as it is saved. The engineer's
guide shall name the copy: the folder copied into the product's `skills/`,
the section appended to the product's `AGENTS.md` below the maintained
markers. The pinned program's draft stays byte for byte what the program
writes — decision 0019: the constitution is the program's, so a section is
laid below its markers by whoever runs the product, never written into the
pinned skeleton; a draft `madarch new` alone makes carries neither the
skill folder nor the section until the copy is made.

### Scenario: checkout-carries-the-step
- Given: a madarch checkout at the change's revision
- When: its `skills/describe-repository/` folder is listed and the two files are read
- Then: it holds `SKILL.md` and `AGENTS-section.md`; the skill names the four artifacts, the model check command, the committed-checkout rule and the derived-from-code provenance shape; the section names the skill, the four artifacts, the committed-checkout rule and the wiki's live display

### Scenario: a-fresh-draft-carries-nothing-until-copied
- Given: a draft created by `madarch new` alone
- When: its `AGENTS.md` and its `skills/` folder are read
- Then: `AGENTS.md` is byte for byte the pinned program's constitution, and `skills/` holds only the program's `.gitkeep` — no describe-repository folder, no section

### Scenario: the-copy-lays-the-step
- Given: a fresh draft and a madarch checkout
- When: the checkout's `skills/describe-repository/` folder is copied into the draft's `skills/` and its `AGENTS-section.md` is appended to the draft's `AGENTS.md`
- Then: the draft's `AGENTS.md` holds the pinned constitution followed by the section, the section stands after the maintained markers, and the draft's `skills/` holds the skill beside the kept `.gitkeep`

## Requirement: describe-skill — The product's own skill describes a repository into the wiki's artifacts
A new product's `skills/` folder shall hold the product's own
describe-repository skill, one Agent Skills folder whose instructions run,
for one repository of the product's manifest: first the repository's
intended model, written through madarch's model-writing machinery — the
set's `write-intended-model` procedure and the model check run from a
madarch checkout — into the repository's own `madarch/` folder with a
review report beside it, every element, interface and relation carrying
evidence naming the file, the line or range, and the commit and blob it was
read from, the check finishing only on a run that exits 0; then the
architecture page `docs/repositories/name/architecture.md` in the
product's `docs/`, prose that names the model's views and links the model's
folder and the review report by relative paths; then the capabilities found
in the code as user stories, use cases and product requirements in the
set's forms, continuing the product's own id numbering, each marked derived
from code in its title and by `Source: code` and `Evidence:` lines in its
`Sources` section naming the file and lines every statement was read from; and then one MADR decision record per
decision found in the repository's code or its own ADRs, under
`docs/repositories/name/decisions/`, each record naming the model ids it
shapes. The skill shall refuse a checkout with uncommitted changes before
reading it, naming the folder and the command that showed the changes; it
shall update an existing model instead of rewriting it, keeping every id
the changes do not concern; and it shall finish by running the product's
document check on what it wrote and reporting the repository, the model
check's verdict, the pages with their paths and the ids it took, leaving
committing to the person.

### Scenario: described-repository-shows-its-artifacts
- Given: a fixture product whose manifest declares one small repository and whose checkout is clean
- When: the describe-repository skill is run on that repository
- Then: the repository's `madarch/` folder holds a model and a review report the model check passes, the product's `docs/repositories/name/` holds the architecture page, at least one requirement and one use case marked derived from code with `Source: code` and `Evidence:` lines of file-and-line citations in their `Sources` sections, and one decision record naming a model id, and every page the skill wrote is a page of the wiki

### Scenario: uncommitted-checkout-refused
- Given: a fixture product whose declared repository holds an uncommitted change
- When: the describe-repository skill is asked to describe it
- Then: nothing is written, and the refusal names the repository folder and the command that showed the changes

### Scenario: evidence-is-traceable
- Given: a requirement the skill derived from code
- When: its `Evidence:` line is read and each citation opened
- Then: every citation names a file of the repository and a line range, and the statement it supports reads at that place in the repository's committed text
