# Product repository

Capability: product-repository

## Purpose
One product's knowledge kept as Markdown and YAML in a git repository of its
own, apart from the product's code: its documents, its intended model, its
skills, its prototypes and the manifest naming the code repositories it spans
(decision 0017). Before the product has a name it exists as a draft: a folder
with a temporary name, a stable id and a complete but empty skeleton, which
the person and their agent fill in.

## Requirement: draft — `madarch new` creates a draft product repository
When `madarch new` is run, it shall create, under the products home, a folder
named `idea-YYYY-MM-DD` from the day's date — `idea-YYYY-MM-DD-2`, and `-3`
and so on when that day's names are taken — make it a git
repository whose first commit holds the skeleton, and print the product's
folder and its id. The skeleton shall hold `AGENTS.md` (the constitution,
naming the product repository's folders and what each is for), `CLAUDE.md`
holding `@AGENTS.md`, `workspace.yaml` (the manifest), a `.gitignore` ignoring
`repos/`, and the folders `docs/`, `model/`, `skills/` and `prototypes/`, each
kept by the file git needs to keep an empty folder; `repos/` shall exist and
not be tracked. The products home shall be `~/madarch/products` unless
`MADARCH_HOME` or `--home` names another. The layout shall be the one the schema version fixes — `docs/` for
the wiki's documents, `model/` for the intended model, `skills/` for the
team's own skills, `prototypes/` for the prototypes, `repos/` for the code
repositories, untracked — and never read from the manifest, so every madarch
and every agent knows where things are from the schema version alone. `repos/`
is the only folder madarch leaves untracked; `skills/` holds the team's own
skills and never a copy of the skill set (the set's pinned version is the
manifest's optional field). `AGENTS.md` shall hold madarch's marker comments
around the part madarch maintains, so that madarch, which writes the file once
here and never rewrites it afterwards, may later update that part alone and
leave every other section — the skill set's included — as it was. Nothing
madarch writes into the product shall hold an absolute path to the product's
folder, and the links between its documents shall be relative paths, so the
folder can be renamed without breaking them. If an argument or the products
home cannot be used, it shall exit 2, and if creating the repository or
committing the skeleton fails it shall exit 1, each naming what failed and
leaving no folder behind.

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
repository. When a product folder is read, its manifest shall be read for the
schema version it was written in, the product's `id` — an opaque identifier
given at creation and kept for the product's life, whatever its folder is
later called — and its `name`, which is the folder's name for a draft; the
manifest may also carry the pinned version of the skill set. These fields are
never renamed; a manifest grows by fields added beside them, so a field this
madarch does not know is ignored and a manifest written by a later madarch
still opens. A folder holding no manifest, a manifest naming no `id` or no
schema version this madarch knows, and a `workspace.yaml` that cannot be read
shall each be refused, naming the file and the field or reason.

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

### Scenario: constitution-is-written-once
- Given: a draft created by `madarch new`
- When: its `AGENTS.md` is read
- Then: it names `docs/`, `model/`, `skills/`, `prototypes/` and `repos/` and what each is for, says that `skills/` holds the team's own skills, and carries madarch's marker comments around the part madarch maintains

### Scenario: no-absolute-path
- Given: a draft created by `madarch new` in a scratch products home
- When: every file the command wrote is searched for that home's absolute path
- Then: none holds it
