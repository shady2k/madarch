# How to write a product's manifests

A product repository holds four manifest files. They are the product's own
files: `madarch new` writes a starter set, and from then on the product edits
them by hand or with its agent. This guide says where each file lives, what it
is for, and which fields this version reads.

The examples use neutral names. Copy the shape, not the names.

## Where the files live

| File | What it holds |
| --- | --- |
| `workspace.yaml`, at the repository root | the product's identity: its schema version, id and name, and the code repositories it spans |
| `madarch/kinds.yaml` | the kinds of entity the wiki shows, with their groups, properties, edges, plugins and catalog |
| `madarch/workflows.yaml` | the workflows a fill runs |
| `madarch/plugins.lock` | each plugin's exact version and the hash of its closure |

The first file is read by a small reader of a plain subset of YAML. The three
files under `madarch/` are read as YAML. Neither reader guesses: a fault is a
finding that names the file and the line, and a fault in one kind, group or
workflow leaves the others standing.

## How the wiki reads them

The wiki reads the product's own files from the product repository. It does
not hold a kind of its own: `madarch/kinds.yaml` is the only source of kinds,
and a product that holds no such file has no pages.

Pressing Fill in the wiki, or running `madarch fill`, reads the product
repository into the graph: the kinds manifest, the documents, the templates
and the code of the repositories the manifest declares. The wiki then serves
the pages from that graph. An edit to a manifest takes effect at the next
fill, not at the next reload.

A product whose manifest does not read is not a product: `madarch new`,
`madarch list` and `madarch serve` refuse it and name the file and the line.

## workspace.yaml

`workspace.yaml` is how madarch and an agent recognise a product repository.
Its fields are never renamed; a field this version does not know is ignored, so
a manifest written by a later version still opens.

| Field | Required | What it is |
| --- | --- | --- |
| `schemaVersion` | yes | `1`. The version this madarch writes and reads; another number is refused |
| `id` | yes | the identifier given at creation, a non-empty word, kept for the product's life |
| `name` | no | the product's name. Absent or empty: the folder's name |
| `skills` | no | a mapping of skill set to the version pinned, one `<set>: <version>` line per set |
| `repos` | no | the code repositories the product spans |

Each `repos` item is a mapping with `name` and `url`, and may carry `branch`,
`linked` and `moved`:

| Field | Required | What it is |
| --- | --- | --- |
| `name` | yes | the folder under `repos/` the repository is cloned into: one path segment, declared once |
| `url` | yes, unless `linked: true` | the origin to clone from |
| `linked` | no | `true` when the entry points at a checkout that already exists |
| `moved` | no | `true` when the checkout was moved into the product's `repos/` |
| `branch` | no | the branch a clone is taken from |

```yaml
schemaVersion: 1
id: 473611d2-ffdd-408e-b94c-143221f4c343
name: example-product
skills:
  example-skills: 1.2.0
repos:
  - name: library
    url: ../library.git
  - name: frontend
    url: ../frontend.git
    branch: main
```

The manifest is read as a plain subset of YAML: block mappings, block
sequences of mappings, plain and quoted scalars, and comments. An anchor, an
alias, a tag, a flow collection, a second document, a field named twice and a
tab indent are each refused, because a manifest is meant to read the same to a
person and to a tool. A value holding `": "` is a mapping written on one line,
and is refused too.

## madarch/kinds.yaml

This file declares every kind the wiki shows, and where each kind's entities
come from. Its top-level keys are:

| Key | What it holds |
| --- | --- |
| `kinds` | the kind declarations, by name; required |
| `groups` | the navigation groups and their labels |
| `properties` | the properties a page may show, with their labels and value format |
| `documents` | which Markdown files are not documents, which kinds the documents must hold, which blocks carry no meaning |
| `roles` | per reader role, the blocks a page opens and the groups the navigation leads with |
| `problems` | the rules and thresholds of the Problems page |
| `catalog` | the schema of the entity catalog |
| `edges` | the edge kinds the product declares |
| `plugins` | the plugins the product holds |
| `language` | `en` or `ru`, the language the pages are written in; absent means `en` |
| `diagram` | the renderer the diagrams open on: `likec4`, `mermaid`, `archify` or `echarts` |
| `journal` | `debug`: whether the journal keeps every request a plugin makes |

A top-level `mapping:` is accepted and is not read by this version.

### A kind's source

Every kind names a `template` (a path inside the product repository) and a
`source`. The source says where the kind's entities come from:

- `markdown`: a folder (`folder:`, many entities) or one file (`file:`, one
  entity), exactly one of the two. The first kind with a `file` is the home
  page.
- `graph`: entities of the graph the fill builds from the code repositories.
  Such a kind names neither `folder` nor `file`.
- `document`: sections of Markdown documents of the product or of a code
  repository. Such a kind names at least one of `identifier`, `headings`,
  `terms` and `semantics`.

```yaml
kinds:
  home:
    template: templates/home.liquid
    source: markdown
    file: docs/README.md
  topic:
    template: templates/topic.liquid
    source: markdown
    folder: docs/topics
  component:
    template: templates/component.liquid
    source: graph
```

### A document kind's vocabulary

| Field | What it is |
| --- | --- |
| `identifier` | the letters an identifier opens with (`UC` takes `UC-2`), a list of them, or `*` for any other prefix |
| `headings` | the headings whose sections are entities, such as `[Use cases]` |
| `terms` | the documents (path patterns, `*` within a folder, `**` across folders) whose leading bold terms are entities |
| `semantics` | the general kind a passage means: `scenario`, `actor`, `rule`, `quality`, `decision`, `procedure`, `term`, `other` |
| `structure` | the sections a section of this kind holds, such as `[Status, Context, Decision, Consequences]` |

```yaml
  use-case:
    template: templates/use-case.liquid
    source: document
    identifier: UC
  term:
    template: templates/term.liquid
    source: document
    terms: ["**/glossary.md"]
  rule:
    template: templates/rule.liquid
    source: document
    headings: [Rules]
    semantics: rule
    structure: [Status, Rule]
```

### Naming and place

| Field | What it is |
| --- | --- |
| `group` | the group of `groups` the kind stands in |
| `labels` | the kind's name per language: `en` and `ru`, each `{ one, many }` |
| `description` | one sentence saying what the kind is, per language |
| `origin` | how the kind's entities came to be: `agent`, `person`, `code` or `history` |
| `title` | the attribute that names a page; `label` when absent |
| `attributes` | the attributes a template may name |
| `details` | the `properties` a page of the kind shows, in order |
| `findings` | `true` for a kind whose entities are findings the Problems page reads |

```yaml
  topic:
    template: templates/topic.liquid
    source: markdown
    folder: docs/topics
    group: knowledge
    origin: person
    labels:
      en: { one: Topic, many: Topics }
      ru: { one: Тема, many: Темы }
    description:
      en: A subject the product's documents are about.
      ru: Тема, о которой написаны документы продукта.
```

A manifest that declares a `catalog` names both languages for every kind:
`labels` and `description` are then required in `en` and `ru`.

### What a page shows

These fields choose a page's blocks and views. Each takes the words listed,
and nothing else:

| Field | Values |
| --- | --- |
| `card` | `true`: a ground on one of the entities shows its card, not its code |
| `history` | `repositories`, `author`, `path`, `membership`, `commit`, `task` |
| `views` | `c4-component`, `state` |
| `er` | `tables`, `links` |
| `sequence` | `route`, `symbol` |
| `system` | `container`, `data-store`, `channel` |
| `definition-block` | `contract`, `operation`, `channel` |
| `listing` | `operations`, `glossary` |
| `nav` | `own-page`, `loop` |
| `member` | `{ relation, direction: out or in, parentKind?, property? }`: the entity is a row of another entity's page |

A kind with no `history` gets no history page; a kind with no `views`, `er`
or `sequence` starts none of those views; a kind with no `system` is no
element of the system view.

### A kind's contract

A graph kind may declare typed fields, its natural key and its producers:

| Field | What it is |
| --- | --- |
| `fields` | `{ name, type, nullable?, producers?, reference?, binding? }` items. `type` is `text`, `integer`, `bigint`, `boolean`, `timestamp` or `json`; `name` is a lower-case identifier |
| `key` | the field names of the kind's natural key; each must be a declared field |
| `capability` | the capability that fills the kind |
| `depends-on` | the kinds whose discovery must finish before this kind's turn |

A field names one producer: either `producers` (a list of producer names) or
`binding`, which is `"<plugin>@<major>.<field>"` or `{ agent: <what the field
is and how to extract it> }`. A field names one, never both.

```yaml
  module:
    template: templates/module.liquid
    source: graph
    capability: git
    depends-on: [repository]
    fields:
      - { name: name, type: text, producers: [git] }
      - { name: size, type: integer, nullable: true, producers: [git] }
    key: [name]
```

### The catalog row

A manifest that declares `catalog` reads every kind against it, and each kind
then declares its own row:

| Field | What it is |
| --- | --- |
| `id` | the canonical concept id; one concept has one kind |
| `definition` | one sentence saying what the kind is |
| `sources` | the addresses (`http` or `https`) of the standards or documents the kind was taken from |
| `acquisition` | `extractor <id>`, or one of the catalog's `origin-marks` |
| `status` | one of the catalog's `statuses` |
| `relation-constraints` | `{ out: [relation], in: [relation] }`, both lists, of the catalog's relations |
| `template-policy` | one of the catalog's `template-policies`: `page`, `member` or `none` |

```yaml
catalog:
  subgroup-kind-bound: 12
  attributes: [version]
  origin-marks: [document, conversation]
  extractor-mark: extractor
  statuses: [implemented, not-implemented]
  template-policies: [page, member, none]
  relations: { contains: }
kinds:
  module:
    id: architecture.component
    group: structure
    definition: A deployable part of the system.
    sources: [https://example.org/standard]
    acquisition: [extractor code]
    status: implemented
    relation-constraints: { out: [contains], in: [contains] }
    template-policy: page
```

A `group` of a catalog kind names a subgroup: a group whose `parent` names its
area. A subgroup holds no more kinds than `subgroup-kind-bound` allows. A kind
whose policy is `none` is catalogue data only: it declares no `template`, no
`source` and no page fields, and the wiki shows no page for it. A kind whose
policy is `member` declares `member`.

### Groups, properties, documents, roles, problems, edges, plugins

```yaml
groups:
  knowledge: { en: Knowledge, ru: Знания, short: { en: Knowledge, ru: Знания } }
  structure: { en: Structure, ru: Структура, short: { en: Structure, ru: Структура }, parent: knowledge }
properties:
  language: { en: Language, ru: Язык, format: text }
documents:
  exclude: [AGENTS.md, "**/CHANGELOG.md"]
  expect: [rule, use-case]
  ignore: [code, html]
roles:
  reader: { lead: [knowledge], open: [body, relations] }
```

- A group is `{ en, ru }`, and may name `short` (one or two words for the
  sidebar, at most 18 code points), `parent` (the area above it, one level
  deep) and `open: true` (the navigation opens it by itself). A manifest with a
  catalog names a `short` label for every group.
- A property is `{ en, ru, format? }`. `format` is `text`, `list`, `commands`,
  `ports`, `boolean`, `number`, `date`, `path`, `code`, `build` or `scripts`.
  A property whose value is an object may declare its `fields`, each
  `{ en, ru, format? }`.
- `documents.exclude` lists path patterns the wiki does not list as documents.
  `documents.expect` lists document kinds the documents must hold; a kind no
  section is read as is a finding. `documents.ignore` lists block kinds a
  document may hold without a page (`code`, `html`, ...).
- A role is `{ open, lead }`: `open` lists the blocks of a template that stand
  open, `lead` the groups the navigation lists first. A role's name is one word
  without whitespace; `everything` is every role at once and is not declared. A
  manifest with a catalog requires every area to be led by a role or by one of
  its subgroups.

```yaml
problems:
  thresholds:
    largeFileLines: 600
    hotspotLines: 200
    hotspotCommits: 10
    hotspotScore: 10000
  rules:
    todo-marker:
      predicate: debt
      kind: debt-marker
      sonar: code-smell
      severity: minor
      section: code
      action: task
      label: { en: A debt marker in the code, ru: Маркер долга в коде }
      params: { marker: TODO }
      enabled: true
```

A rule names a `predicate` the engine implements (such as `debt`,
`large-file`, `change-hotspot`, `findings` or `wiki`), the `kind` of finding it
makes (one rule per kind), its `sonar` kind (`vulnerability`, `bug`,
`code-smell`, `security-hotspot`), its `severity` (`blocker`, `critical`,
`major`, `minor`, `info`), its `section` (`code`, `documents`, `wiki`), its
`action` (`task` or `none`) and its `label` in `en` and `ru`. `params` and
`enabled` are optional. The four thresholds are `largeFileLines`,
`hotspotLines`, `hotspotCommits` and `hotspotScore`; each is a positive whole
number.

```yaml
edges:
  - name: contains
    from: [directory]
    to: [directory, file]
    capability: git
  - name: renamed-from
    from: [file]
    to: [file]
    repeats: true
    discriminator: commit
    fields:
      - { name: commit, type: text, producers: [git] }
plugins:
  - id: example-plugin
    version: 1
    path: plugins/example-plugin
    inputs: [file]
    outputs: [table]
    closure: [plugins/example-plugin/contract.json]
```

An edge is `{ name, from, to, repeats?, discriminator?, fields?, capability? }`.
`from` and `to` name kinds. An edge that repeats names the field that tells its
repeats apart; one that does not repeat has none. A plugin is `{ id, version,
path, inputs, outputs, closure }`: `version` is the major version the manifest
binds, `path` the plugin's folder, `inputs` and `outputs` the kinds it reads and
writes, `closure` the files it runs. The folder holds the plugin's
`contract.json`, and `madarch/plugins.lock` records its exact version.

## madarch/workflows.yaml

A workflow is a named set of the engine's stage ids. The stages' own inputs
give their order, so the file declares no edges. Its only top-level key is
`workflows`, and each workflow is `{ status, stages }`.

| Field | What it is |
| --- | --- |
| `status` | `implemented` (the engine runs it) or `planned` (the engine has no stage for it yet) |
| `stages` | the stage ids the workflow runs. An `implemented` workflow names at least one; a `planned` one may name none |

```yaml
workflows:
  first-fill:
    status: implemented
    stages: [repository-tree, repository-history]
  update-by-commit:
    status: planned
    stages: []
```

A workflow's name starts with a letter and carries letters, digits, `.`, `_`
or `-`. Each stage id is one the engine's registry holds, is named once, and a
stage whose required input no stage of the workflow produces is a finding. A
cycle of the workflow's stages is refused.

A fill runs the stages of the workflow named `first-fill`, and refuses a file
that holds no such workflow or whose `first-fill` is not `implemented`. A
product that holds no workflows file runs the engine's starter set.

## madarch/plugins.lock

The lock records, for each plugin the product runs, the exact version and the
hash of the closure the fill executes, so a fill runs the same bytes on any
machine. Its only top-level key is `plugins`, a list of
`{ id, version, closure, path }`.

| Field | What it is |
| --- | --- |
| `id` | the plugin's id: lower-case letters, digits and dashes |
| `version` | the exact version, `1.0.0` |
| `closure` | the sha256 of the closure: 64 lower-case hex digits |
| `path` | the plugin's folder in the product repository, relative and with no `..` |

```yaml
plugins:
  - id: example-plugin
    version: 1.0.0
    closure: c74390eb1deb7b7a82dad8f6a4c84a1c45396dbd0e5570adb86324422d0d8701
    path: plugins/example-plugin
```

The lock is checked against the manifest: a plugin the manifest declares must
stand in the lock, at the same `path` and with a version whose major number the
manifest binds. A plugin's own `contract.json` must declare the locked version.
A lock that cannot be read is a finding naming its file and line; it is never
treated as no lock.

## When a manifest has a problem

Every finding names the file and the line, and says what to write instead. A
kind, group, edge, workflow or rule with a problem is left out, and the others
still stand, so one bad line never blanks the wiki and never passes unseen.
