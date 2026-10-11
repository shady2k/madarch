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

## Requirement: rename — `madarch rename` names a product in place, its id kept
When `madarch rename gadgets` is run — the `--product` folder, the product the
command runs in, or the parent product of a checkout under its `repos/` — it
shall rename the product's folder in place, write that name in the manifest as
one commit of the product's own history, and print the renamed folder products/gadgets, the
product's id and its name, one fact per line. The rename itself shall be the
pinned program's `renameProduct`: the id and every other byte of the manifest
are kept, nothing written holds an absolute path, and every refusal — a name
a product cannot take, a name already taken in the products home (the folder
is in the way), the product already named that, a working tree with
uncommitted changes, a folder that is no git repository of its own — is the
program's, printed whole on standard error with exit 2; a step of the rename
that failed is exit 1 with the same words.

### Scenario: rename-keeps-the-id
- Given: a draft created by `madarch new`
- When: `madarch rename gadgets --product products/gadgets` is run
- Then: the folder products/gadgets holds the product, its manifest names `gadgets`, the id is the one the draft printed, and the command printed that folder and the id

### Scenario: rename-from-a-checkout
- Given: a product whose manifest declares one code repository, bootstrapped
- When: `madarch rename` with no `--product` is run from inside `repos/library`
- Then: the checkout's parent product is renamed, and the checkout now stands under the renamed product's `repos/`

### Scenario: rename-refused-no-product
- Given: a folder above which no product stands
- When: `madarch rename gadgets` is run there
- Then: it exits 2 naming that folder, and no folder is renamed

### Scenario: rename-name-in-the-way
- Given: a products home holding two drafts
- When: one is renamed to the other draft's name
- Then: it exits 2 naming the folder in the way, and no folder was renamed

### Scenario: rename-uncommitted-changes-refused
- Given: a product holding uncommitted changes
- When: `madarch rename` is run on it
- Then: it exits 2 in the program's words, and the folder is not renamed

### Scenario: rename-git-fails-exit-1
- Given: a git on the command's PATH that refuses to commit
- When: `madarch rename` is run on a draft
- Then: it exits 1 with git's own words, and the product stands where it stood

## Requirement: remote — `madarch remote` adds origin and never pushes
When `madarch remote ../products.git` is run, the pinned program's `addRemote` shall add
`origin` at that url to the product's repository — the `--product` folder, the
product the command runs in, or a checkout's parent product — and the command
shall print the folder, the remote's name (`origin`) and the url, one fact per
line, exit 0. It shall never push, and an `origin` already there shall be
refused in the program's words with exit 2, never silently repointed.

### Scenario: remote-added
- Given: a draft with no remote
- When: `madarch remote ../products.git --product products/gadgets` is run
- Then: `origin` names that url in the product's repository, and the command printed the folder, `remote: origin` and the url

### Scenario: remote-already-there
- Given: a product whose `origin` is already added
- When: `madarch remote` is run on it with another url
- Then: it exits 2 naming that the remote already exists, and `origin` still points where it pointed

## Requirement: repo-add — `madarch repo add` enters the repository and clones it
When `madarch repo add library ../library.git` is run (the optional branch,
`--product` as the where resolution names it), the pinned program's
`addCodeRepository` shall enter the repository in the manifest — appended to
`repos`, every other byte of the manifest kept, one commit of the product's
own history — and the command shall then clone it into `repos/library` through
the same step the bootstrap command runs, printing the folder, the entered
`repo` and its `url` (and the `branch` when the manifest declares one), then
one state line per repository the step reported. A name the manifest already
declares, and a product holding uncommitted changes, are refused in the
program's words with exit 2; a name that is no folder name, an empty url and
an unreadable manifest likewise. A checkout already standing at
`repos/library` is never replaced: the checkout is named and left as it is.

### Scenario: repo-add-enters-and-clones
- Given: a draft and a pushed git repository the tests made
- When: `madarch repo add library ../library.git --product products/gadgets` is run
- Then: the manifest declares `library` at that url, the checkout stands at `repos/library` holding the repository's files, and the command printed `repo: library` and a `cloned:` line

### Scenario: repo-add-branch-declared
- Given: a draft and a pushed repository with a `main` branch
- When: `madarch repo add library ../library.git --branch main` is run
- Then: the manifest declares the branch, and the clone is taken from it

### Scenario: repo-add-already-declared
- Given: a product whose manifest already declares `library`
- When: `madarch repo add library ../another.git` is run
- Then: it exits 2 naming that the manifest already declares it, and the manifest is byte for byte what it was

### Scenario: repo-add-uncommitted-refused
- Given: a product holding uncommitted changes
- When: `madarch repo add` is run on it
- Then: it exits 2 naming the uncommitted changes

## Requirement: bootstrap — `madarch bootstrap` clones what the manifest declares
When `madarch bootstrap` is run, the pinned program's `bootstrapProduct`
shall clone the repositories the manifest declares each into `repos/` under its own name — one
report each — and the command shall print one state line per reported
repository: `cloned: repos/library` for a checkout made now, `present: repos/library` for a
checkout that stood there and was left as it is (naming uncommitted changes
when the checkout holds them), and the failure's words on standard error for
one that failed. A product that declares no repositories prints nothing and
exits 0; one declared repository that could not be cloned exits 1, the rest
still reported. A checkout that stands but is no clone of the declared url,
or where a clone could not be made, is the program's case, never replaced.

### Scenario: bootstrap-clones-and-works-inside-the-product
- Given: a product whose manifest declares one code repository and a working folder inside the product
- When: `madarch bootstrap` is run there with no `--product`
- Then: the checkout stands at `repos/library` holding the repository's files, and the command printed a `cloned:` line

### Scenario: bootstrap-present-is-left
- Given: a product whose declared repository already stands at `repos/library`
- When: `madarch bootstrap --product products/gadgets` is run
- Then: it exits 0, the checkout is byte for byte what it was, and the command printed `present:` for it

### Scenario: bootstrap-nothing-declared
- Given: a draft whose manifest declares no repositories
- When: `madarch bootstrap --product products/gadgets` is run
- Then: it exits 0 and prints nothing

### Scenario: bootstrap-blocked-is-a-failure
- Given: a product whose manifest declares one repository and `repos/library` occupied by a file
- When: `madarch bootstrap --product products/gadgets` is run
- Then: it exits 1 naming the repository, and the file still stands

## Requirement: clone — `madarch clone` brings a pushed product home
When `madarch clone ../origin.git --home empty-home` is run with `--home` naming the products
home the other creators resolve, absent meaning `~/madarch/products` moved by
`MADARCH_HOME`), madarch shall git clone the url into a folder of the
products home named after the url (the `.git` suffix off), read the product's
manifest with the pinned reader, bootstrap what it declares, and print the
folder, the product's `id` and `name`, and the command that opens its wiki
(`wiki: madarch serve --product the-product-folder`), one fact per line. This is how a
second engineer joins. A destination the home already holds is refused with
exit 2 before the clone starts (the folder is in the way); a url that begins
with `-`, an empty url and a home that is a file are refused with exit 2; a
cloned folder whose manifest cannot be read is refused with the reader's
words and its working copy removed, leaving nothing behind; and a clone git
itself refused — the machine's words on standard error — is a failed step,
exit 1, leaving nothing behind.

### Scenario: clone-joins
- Given: a product pushed to a bare repository, its manifest declaring one code repository
- When: `madarch clone ../origin.git --home empty-home` is run in a second products home
- Then: the product stands under the other home, the declared repository is cloned under its `repos/`, and the command printed the folder, the id and `wiki: madarch serve --product`

### Scenario: clone-name-in-the-way
- Given: a products home already holding a folder of the name the url carries
- When: `madarch clone ../origin.git --home the-home` is run
- Then: it exits 2 naming the folder in the way, and no clone was started

### Scenario: clone-no-product-refused-and-removed
- Given: a pushed git repository that is no product repository
- When: `madarch clone ../origin.git --home the-home` is run
- Then: it exits 2 naming `workspace.yaml` in the reader's words, and the home holds no folder of that name

### Scenario: clone-git-fails-exit-1
- Given: a git on the command's PATH that refuses to clone
- When: `madarch clone ../origin.git --home empty-home` is run
- Then: it exits 1 with git's own words, and the home holds no folder of that name

## Requirement: where — a lifecycle command finds the product from where it is run
When a lifecycle command (`rename`, `remote`, `repo add`, `bootstrap`) is run
without `--product`, the product folder it works on shall be the pinned
program's where from the working folder: the product the folder stands in, or
— walked up — the parent product of a checkout standing under a product's
`repos/`. The walk shall end where a git repository of its own begins: a
manifest standing inside another repository's working tree is not a product,
and a checkout standing outside a product's `repos/` is not one either. A
working folder above which no product stands is refused with exit 2 naming
that folder and the `--product` the command would take; a manifest the walk
meets that cannot be read is refused with the reader's file and line.

### Scenario: where-from-the-product-itself
- Given: a draft
- When: `madarch bootstrap` is run in the draft's folder with no `--product`
- Then: the draft's own product is the one the command works on

### Scenario: where-from-a-checkout
- Given: a product whose manifest declares one code repository, bootstrapped
- When: `madarch remote ../another.git` is run from inside `repos/library`
- Then: the parent product is the one the command works on, and its repository holds `origin`

### Scenario: where-refuses-when-nothing-above
- Given: a folder above which no product stands
- When: a lifecycle command is run there
- Then: it exits 2 naming that folder and the `--product` the command would take
