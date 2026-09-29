# Generate a wiki with diagrams from a repository's model

Change: wiki
Base: cf33f8fd80713e81d41d1e05c67629276868acae
Tasks: madarch-ti6.3, madarch-7br.1.1, madarch-7br.1.2, madarch-7br.1.3, madarch-7br.1.4, madarch-7br.1.5, madarch-7br.2.1, madarch-7br.2.2
Kind: behavior

## Intent
Today a repository's architecture is read either as Markdown files in the
repository, opened through GitHub, GitLab or another viewer, or as diagram
pages with no text around them. After this change madarch generates, from the
repository's compiled model, a site people read in a browser: a page per
domain and per element saying what it is, what it provides, who calls it and
what data flows, with the diagram it belongs to, which the reader can see as
LikeC4, Mermaid or archify, open, drill into and search; pages for the interfaces, the zones and the data
categories; the review report the skill wrote; and the repository's own
README and documents beside them. The site is built by Zensical or by
Starlight, chosen by an environment variable, from the same pages.

Stories:
- As an engineer joining a team, I open the wiki's page of the service I will
  work on and see its parts, its callers, the contracts it provides and the
  data it carries, with a diagram I can open and drill into.
- As an architect, I read the repository's architecture document and the
  review report in the same site as the model's pages, and follow a link from
  one to the other.
- As the person running madarch, I choose Zensical or Starlight with one
  environment variable and get the same pages.

## Out of scope
Hosting or publishing the wiki, and the server building it on request (the
server of outcome 4 reuses this later); choosing one engine for good; our own
diagram renderer or layout engine (archify takes LikeC4's layout), and SVG
export; editing pages in the wiki;
versions of the wiki per commit or per environment and architecture state;
several repositories in one wiki; Markdown files outside `README.md` and
`docs/`; translating pages.

## Rationale
Asked by the owner on 2026-09-29: Markdown documents in a repository are hard
to read, so madarch should generate documentation with diagrams, not only
diagrams. Two throwaway sites of the reference system (madarch-ti6.3), one per
engine, were compared; the owner kept both behind an environment variable
("Давай сливать, движок выбираем через env").

## Changes to requirements
- wiki (new capability): pages for the home, every domain and element, the
  interfaces, zones and data categories, cross-linked; each page's view in
  three formats the reader switches between, LikeC4 with details and
  drill-down, Mermaid and archify, the first shown from
  `MADARCH_WIKI_DIAGRAM`, else LikeC4; the engine from `--engine`, then `MADARCH_WIKI_ENGINE`, then Zensical; the
  repository's README, its `docs/` documents and the review report as pages;
  no broken link; exit codes 0, 1 and 2, and the same pages from the same
  input.

## Preserved contracts
None.

## Coverage
- wiki/pages: test
- wiki/diagrams: test, wiki-sites
- wiki/engine: test, wiki-sites
- wiki/documents: test
- wiki/links: test, wiki-sites
- wiki/result: test

## Blocking questions
None.

## Design and decisions
Decided with the owner on 2026-09-29: both engines stay, chosen by
`MADARCH_WIKI_ENGINE` (default Zensical) or `--engine`; one set of pages built
from the model, with its own tests; a command in madarch builds the site from
a repository and an output folder, and the server of outcome 4 reuses it. Each
diagram is offered as LikeC4, Mermaid and archify, the first shown chosen by
`MADARCH_WIKI_DIAGRAM` (default LikeC4) ("Давай", to the proposal of tabs).
Archify needs its elements placed by its author: the positions and sizes come
from the view LikeC4 has laid out, so no layout engine of madarch's own is
needed; drill-down in archify is a link to the page of the view below.

Recommended by the agent from the prototypes (the owner may change any):
- The interactive diagram is LikeC4's web component on both engines. In the
  Starlight prototype LikeC4's React components were read-only: no element
  details, drill-down only through search. The web component gave details and
  drill-down in Zensical and is plain HTML, which Starlight pages take too.
- Mermaid is drawn by one pinned Mermaid runtime shipped with the site, on
  both engines, from the pages madarch already renders; no CDN at reading
  time. Zensical's documented Mermaid fence did not render in the prototype.
- Each engine's toolchain is pinned and kept apart from madarch's own
  dependencies: Zensical run through `uvx` at a pinned version, Starlight from
  a template project inside madarch with its own lockfile, installed on first
  use. A missing `uv` or `bun` is an unreadable input (exit 2) that names what
  to install.
- The pages are one data structure computed from the compiled model, the view
  set and the documents; each engine only writes that structure in its own
  format. The tests exercise the structure; the `wiki-sites` check exercises
  both engines end to end.
- Archify's renderer is kept inside madarch at a pinned version (MIT), and
  each archify page is embedded in its tab; its nesting is simpler than
  LikeC4's (a frame around a group of elements), which is accepted.
- The repository's own documents are copied as they are, with a title where
  they have none; their links are checked like every other.

Acceptance (the check named in Coverage):
- `wiki-sites`: the reference system's wiki and nocx's wiki (from the model
  of the accepted skill run on nocx at `3f0e46e`, in its local checkout) are
  built with each engine; in a browser, on the Ordering page and on one nocx
  element page, the LikeC4 diagram opens an element's details and navigates
  into the next view, the Mermaid tab draws its diagram, and the archify tab
  shows the view as LikeC4 lays it out and leads into the view below; the link check
  passes; the numbers (pages, build seconds, site size) are recorded per
  engine.
- Estimated at 6 to 9 hours of agent work in three stages: the pages and the
  Zensical engine with the command, LikeC4 and Mermaid tabs; the Starlight
  engine, the documents and both sites end to end; archify from LikeC4's
  layout. A guess from the prototypes, which took about an hour each; archify
  is last so that a poor result on dense views leaves the rest standing.

## Acceptance evidence
Recorded on the change's tasks as `check:` comments and in the stages'
acceptance records, with the `wiki-sites` numbers per engine.

## DONE WHEN
The reference system's and nocx's wikis build on both engines from the model
alone; on their pages the diagram is offered as LikeC4, which opens element
details and drills down, as Mermaid, which renders, and as archify, laid out
as LikeC4 lays it out; the built sites have no broken links. Where it is seen: the wiki command in a checkout of madarch,
run on the reference system and on a checkout of nocx with its model; the
built site opened in a browser from a static server.
