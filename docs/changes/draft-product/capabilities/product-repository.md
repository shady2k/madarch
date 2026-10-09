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
named `idea-YYYY-MM-DD`, of the day's date, from the day's date — `idea-DATE-2`,
`idea-DATE-3` and so on when that day's names are taken — make it a git
repository whose first commit holds the skeleton, and print the product's
folder and its id. The skeleton shall hold `AGENTS.md` (the constitution,
naming the product repository's folders and what each is for), `CLAUDE.md`
holding `@AGENTS.md`, `workspace.yaml` (the manifest), a `.gitignore` ignoring
`repos/`, and the folders `docs/`, `model/`, `skills/` and `prototypes/`, each
kept by the file git needs to keep an empty folder; `repos/` shall exist and
not be tracked. The products home shall be `~/madarch/products` unless
`MADARCH_HOME` or `--home` names another. If an argument or the products home
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
When a product folder is read, its manifest `workspace.yaml` shall be read for
the schema version it was written in, the product's `id` — an opaque
identifier given at creation and kept for the product's life, whatever its
folder is later called — and its `name`, which is the folder's name for a
draft. A folder holding no manifest, a manifest naming no `id` or no schema
version this madarch knows, and a `workspace.yaml` that cannot be read shall
each be refused, naming the file and the field or reason.

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
