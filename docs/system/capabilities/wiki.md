# Wiki

Capability: wiki

## Purpose
Generating, from a repository's compiled model, a static site people read in a
browser: one page per domain and per element with its interfaces, its
relations and its diagrams, pages for the interfaces, the zones and the data
categories, the review report beside the model, and the repository's own
Markdown documents, all cross-linked and searchable. One set of pages is built
by either of two engines, Zensical or Starlight; the diagrams are the views
madarch already renders, in LikeC4, Mermaid and archify.

## Requirement: pages — Every part of the model has its page
When a wiki is generated, it shall have a home page naming the system's
domains and its counts of elements by kind, interfaces and relations; a page
per domain listing its elements with their kind and technology; a page per
element that is not a domain, with its kind, technology, zones, the chain of
its ancestors, its description when the model has one, the interfaces it
provides with their contract ids and callers, and its incoming and outgoing
relations with the other end, the relation's name, its interface's contract,
its action and its data categories; a page listing every interface grouped by
the kind of its contract, with provider and callers; a page per zone listing
its elements; and a page per data category listing the relations that carry
it. Every name of another part on a page links to that part's page.

### Scenario: element-page
- Given: the reference system's model
- When: its wiki is generated
- Then: the page of `checkout-api` names its kind `service`, its technology, its zone `internal` and its ancestor `ordering`, and lists its outgoing relation to the domain `payments` named "takes payment", linking to that domain's page

### Scenario: interfaces-by-kind
- Given: the reference system's model
- When: its wiki is generated
- Then: the interfaces page lists 27 HTTP, 12 gRPC and 11 topic contracts and one data contract, each with its provider and callers

## Requirement: diagrams — Each page shows the view it belongs to, in three formats
When a page of a domain or an element is built, it shall show the view of that
part, or of its nearest ancestor that has one, and the landscape where none
has; the home page shows the landscape. The view shall be offered in three
formats the reader switches between: LikeC4, an interactive diagram that opens
an element's details and navigates into the next level's view; Mermaid, the
view's Mermaid page drawn as a diagram with its relation table; and archify, an
interactive page of the view laid out as LikeC4 lays it out, whose elements
link to the pages of the views below them. The format shown first shall be the
one `MADARCH_WIKI_DIAGRAM` names, else LikeC4. If it names another format, then
generation shall stop before writing anything, naming the value and the three
allowed.

### Scenario: drill-down
- Given: the reference system's wiki, built with either engine
- When: a reader opens the Ordering page and, in its LikeC4 diagram, asks for the details of Checkout and then navigates into it
- Then: Checkout's details show, and the diagram shows the view of Checkout with its modules

### Scenario: formats
- Given: the same wiki
- When: a reader switches the Ordering diagram to Mermaid and then to archify
- Then: Mermaid draws the Ordering view as a diagram with its relation table below it, not as source text; archify shows the Ordering view with its elements where LikeC4 places them, and Checkout in it leads to the Checkout view

### Scenario: default-format
- Given: `MADARCH_WIKI_DIAGRAM` is `mermaid`
- When: a wiki is generated and a reader opens any page with a diagram
- Then: the Mermaid format is shown first

## Requirement: engine — One set of pages, two engines
When a wiki is generated, the engine shall be the one the `--engine` option
names, else the one `MADARCH_WIKI_ENGINE` names, else Zensical; the pages'
content shall be the same whichever engine builds them. If the named engine is
neither `zensical` nor `starlight`, then generation shall stop before writing
anything, naming the value and the two allowed.

### Scenario: engine-from-environment
- Given: `MADARCH_WIKI_ENGINE` is `starlight` and no `--engine` is given
- When: a wiki is generated
- Then: the site is built by Starlight

### Scenario: unknown-engine
- Given: `--engine hugo`
- When: a wiki is generated
- Then: it stops with exit code 2, naming `hugo` and the allowed `zensical` and `starlight`, and writes nothing

## Requirement: documents — The repository's own documents are in the wiki
When a wiki is generated for a repository, its `README.md` and every Markdown
file under its `docs/` folder shall be pages of the wiki, under a Documents
section that keeps their folders, with the links between them and to their
images working, and Mermaid blocks in them drawn as diagrams. The review report
beside the model, when there is one, shall be a page of its own. A link from a
document to anything that is not a page of the wiki shall lead to that path in
the repository on its host (its `origin` remote, at the commit the wiki is built
from); where the repository has no such host, the link shall be shown as text.
A link whose target the repository does not hold is still linked this way, and
the build names it in a warning.

### Scenario: documents-section
- Given: a repository with `README.md`, `docs/architecture.md` linking to `docs/decisions/0001-use-grpc.md`, and a model with a review report
- When: its wiki is generated
- Then: the Documents section holds the three documents, the link from the architecture page opens the decision's page, and the review report has its own page

### Scenario: link-outside-the-documents
- Given: a repository whose origin is `https://github.com/acme/shop.git`, built at commit `c0ffee…`, whose `docs/guide.md` links to `../AGENTS.md` and to `missing.md`
- When: its wiki is built
- Then: the build succeeds; the first link leads to `https://github.com/acme/shop/blob/c0ffee…/AGENTS.md`, the second to `https://github.com/acme/shop/blob/c0ffee…/docs/missing.md`, and a warning names `docs/guide.md`, its line and `docs/missing.md` as not in the repository

## Requirement: links — No link leads nowhere
When a wiki is built, every link inside it that stays within the site shall
open a page or an anchor of that site. If one does not, then the build shall
fail, naming the page and the link.

### Scenario: broken-site-link
- Given: a built wiki whose page links to a page or asset of the site that does not exist
- When: the built-site link check runs
- Then: the build fails with exit code 1, naming the page and the link

## Requirement: result — Built, refused or failed, and why
When a wiki is generated, the command shall exit 0 with the path of the built
site; 1 when the engine's build or the link check fails, printing what failed;
and 2 when its input cannot be read: a model that does not compile (with each
error's file and line), an unknown engine, or an engine's toolchain that is not
installed (naming the command that installs it). The same model, documents and
engine shall give the same pages.

### Scenario: model-refused
- Given: a repository whose model names a parent that no element has
- When: its wiki is generated
- Then: the command exits 2, printing the error with its file and line, and builds nothing

### Scenario: same-input-same-pages
- Given: one repository at one commit
- When: its wiki is generated twice with the same engine
- Then: the two sets of generated pages are identical
