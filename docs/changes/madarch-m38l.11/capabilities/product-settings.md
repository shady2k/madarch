# Product settings

Capability: product-settings

## Purpose
How a product made by an earlier madarch reaches the current starter set, why one
bad kind never blocks the index, and the settings page where a product's agent,
model, page language and the two local resets live. The files of a product (its
kinds manifest and templates) are the product's own, so the engine moves them on
only where no person edited them, and says what it left. The decision behind the
manifest and templates is `docs/decisions/0029-knowledge-in-markdown-graph-as-index.md`.

## Requirement: upgrade — A manifest or template only madarch wrote is brought to the current starter set, and one a person edited is never rewritten
When the wiki first reads a product, each file of the starter set (`madarch/kinds.yaml`
and the files under `templates/`) shall be judged by who wrote it. A file is
madarch's alone when it is exactly what the current set holds, when its content is
one this machine recorded madarch writing, or when git tracks it, every commit that
touched it is madarch's own (the draft's creation) and the
working copy is the committed one or differs from it only by what madarch itself
adds (the page language, the question and correction kinds). Such a file shall be
brought to the current starter set without a question, the product's page language
kept; a template that is absent shall be written. Any other file, including one
whose history cannot be shown, shall not be rewritten, and what the current set
holds that the manifest lacks (a group, the roles, the document exclusions, a kind,
the fields of a kind that lacks its group, labels or description) shall be offered
item by item on the Problems page, each with an «Add» action that writes only that
item into the manifest, keeps its comments and its other lines, and writes the
template the item needs. The question and correction kinds added to a manifest that
declares no groups shall carry no `group`.

### Scenario: old-draft-is-brought-up
- Given: a product made by madarch 0.2.0 whose manifest declares no groups and no roles and whose history shows no edit by a person
- When: its wiki is opened
- Then: the manifest is the current starter set with the product's page language, the templates are the current files, and the wiki shows the seven groups, the six roles, the use cases, the contracts and the routes

### Scenario: edited-manifest-is-offered-not-rewritten
- Given: a product whose manifest a person edited and committed under their own message
- When: its wiki is opened and its Problems page is read
- Then: the manifest is byte for byte as it was, the page lists what the set holds that the manifest lacks, and adding one item writes it with the person's comments kept

### Scenario: loop-kinds-without-groups
- Given: a manifest that declares no groups and lacks the question and correction kinds
- When: a fill starts
- Then: the two kinds are added without a `group`, and neither is a finding

## Requirement: index-scope — A finding scoped to one kind or one page leaves only that kind or page out of the index
The index shall publish the pages of every kind that stands and every page that
can be read. A finding about one kind's declaration in the manifest shall leave only
that kind unpublished; a finding about one page's file shall leave only that page
out; each shall be listed on the Problems page with its file and line. Only a
manifest that cannot be read at all, so that no kind is known, shall publish
nothing, naming each finding with its file and line. A failure of the fill or the
writer shall be told once in the reader's language, with the engineer's detail
behind a link and the Problems page one click away, and the progress card shall not
be drawn above pages that are not the product's page or an entity's.

### Scenario: broken-kind-keeps-the-rest
- Given: a product with two readable kinds and a third whose template is missing, and one page of a readable kind with an unreadable front matter
- When: the Markdown is indexed
- Then: the pages of the readable kinds are published except the unreadable page, and the two findings are answered with their file and line

### Scenario: failure-told-once
- Given: a writer run whose pages were written but whose index step failed on several files
- When: the reader opens the fill menu
- Then: one sentence in the reader's language says so, and the file-by-file detail appears only behind the details link

## Requirement: settings — A product's agent, model, page language and local resets are on one settings page
The wiki shall carry a settings page for the product, reached from the bottom of
the sidebar, holding: the agent that writes the pages; the model and the reasoning
level, offered exactly as the chosen agent reports them over ACP in `session/new`
(madarch holds no list of models), saved beside the agent in the machine's state and
set on each of the agent's sessions only when the agent still offers them; the page
language; the writer's bounds; and where the product's files and derived store are
on this machine. A value the agent does not report shall be refused. The page shall
carry a block of dangerous actions with «Rewrite the pages», which removes the
pages the agent wrote and keeps the graph, and «Start from scratch», which removes
those pages and the graph, puts the manifest and every template at the current
starter set (the page language kept) and starts a fresh fill. Each shall say, before
it is confirmed, that it is local to this machine and this copy of the product, name
the files it removes and the edited starter files it replaces, and say that nothing
is committed or sent anywhere. The wiki, the fill, the agent and these actions shall
run no `git push`. The product selector shall offer no start over.

### Scenario: model-from-the-agent
- Given: a product whose chosen agent reports two models and three reasoning levels over ACP
- When: the settings page is opened and a model and a level are chosen
- Then: only those values are offered, the choice is saved beside the agent, a value the agent does not report is refused, and the agent's next session is set to the choice

### Scenario: start-from-scratch
- Given: a product with pages the agent wrote, one page a person wrote, a graph and an edited template
- When: «Start from scratch» is confirmed
- Then: no agent page and no graph are left, the person's page stays, the manifest and the templates are the current set, and a fill starts

### Scenario: rewrite-pages-only
- Given: the same product
- When: «Rewrite the pages» is confirmed
- Then: the agent's pages are removed, the graph and the person's page stay, and a fill with the chosen agent starts
