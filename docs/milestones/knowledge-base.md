# knowledge-base — the product wiki of one repository, from vision to code

Adopted 2026-10-08 (owner, after the brainstorming recorded as decision 0016).
Precedes: `live-graph`, ended early.

madarch becomes the product's knowledge base (decision 0016). This milestone
proves it on one repository in the local mode, with no server: a reader opens
the wiki and goes from the product's vision to the line of code behind one step
of one use case, and sees what is still missing. The real repository is madarch
itself, which already keeps a vision, charters, capability specs with
requirements, decisions and a glossary; topics and personal data come from the
invented reference system in `examples/`, since madarch has neither.

## Outcomes and acceptance

1. **Check a repository's product corpus with one versioned contract file**
(madarch-o3b). The document contract (vision, requirements, decisions,
glossary, the intended model with its scenarios and data entities, sources
such as transcripts of conversations with product owners and the business, a
path mapping for documents kept elsewhere) has its source in madarch and is built
into one dependency-free file with a version; the model check is part of it.
A requirement, a use case or a decision cites the source it came from by a
quote and a place in it (a time or a line range); a source is kept in the
repository or outside it, where the corpus keeps the quote and a reference. The
model skill lives in shady2k-skills and calls the installed file.
   *Check:* the built file, copied into a clean checkout of madarch, accepts
its corpus and prints its version; a broken corpus fixture is refused naming
the file, the line and what is wrong; a fixture whose documents live at other
paths passes through its mapping; a citation whose quote is not at the place
it names in a source kept in the repository is refused naming both, and one to
a source kept outside is reported as not verified; `skills/write-intended-model` is gone from
madarch and madarch's model is checked by the contract file installed from the
skill set.
2. **Describe use cases and data entities in the model, traced to
requirements** (madarch-hnq). Scenarios are a use case's steps, each over a
relation of the model, linked to requirement ids; data entities carry a
classification (personal data, commercial secret, communications secrecy and
the like), and transfers name the entities they carry.
   *Check:* madarch's model describes its main use cases and the reference
system's model its data entities; removing a relation a step stands on makes
the check name the broken scenario and step; an unclassified entity or an
unknown requirement id is reported with its file and line.
3. **Read the whole product in its wiki, from vision to code, with backlinks
and open questions** (madarch-1ui). A product section linked to the
architecture with backlinks; where each requirement, use case and decision
came from, with its quote, and on each source what grew from it; use-case
pages with sequence diagrams and status computed from evidence; a data catalogue; deployments per environment; open
questions with completeness per role.
   *Check:* madarch's wiki builds; every requirement page shows its scenarios
and elements, every element page its use cases, requirements and decisions; a
use-case page shows its sequence diagram and status; a requirement citing a
fixture transcript shows the quote and links to the place in it, whose page
lists the requirement; the reference system's
data catalogue shows each entity's creators, stores, consumers, topics and
zones; the open questions list the corpus's gaps, an explicit "not applicable"
closes one and an empty answer does not; no link leads nowhere.
4. **Index a repository's code into files, imports and symbols as madarch's
own extraction plugin** (madarch-mv2). Built on tree-sitter, emitting facts
with file and line at a commit (decision 0004).
   *Check:* on madarch's own code, scenario steps and model evidence resolve to
symbols with file and line; a renamed or removed function a step names is
reported by the check, not left as a dead link; indexing the same commit twice
yields the same facts.

## Exclusions

- The server mode and several repositories: a product release over several
sources and its portal (madarch-bwt), the graph kept current from CI
(madarch-tah), the update path's memory (madarch-8iw).
- MCP for agents (madarch-yhy).
- The call graph, SCIP, interactions from configuration (madarch-850) and data
flow inside code.
- Rules over classifications and zones; views per architecture state.
- Work in the shady2k-skills repository (its setup installing the contract
file, the model skill's new home, onboarding, a documents-only mode): tracked
there. Outcome 1's check reads its result once at acceptance.
- Sources outside the repositories, such as Confluence.
- Authentication and single sign-on (madarch-toc).

## Scope decisions

- live-graph ended 2026-10-08 with its outcome 1 accepted (madarch-l19); its
outcomes 2 and 3 moved to `registry`, to be replanned against decision 0016.
- Carried over: madarch-l2f (checks and messages independent of the unrelated
repository the server-views run pinned; the new outcomes' tests build their own
fixtures) and madarch-1xq (temporary folders left by test suites, on a shared
machine). Deferred: madarch-06n and madarch-str (tooling chores carried twice
and not needed since).
- Added 2026-10-08 by the owner ("Да, в текущую"): sources such as
transcripts of conversations, cited by requirements, use cases and decisions,
so the wiki grows before there is any code (outcomes 1 and 3). Where sources
are kept and how they are redacted is asked at setup, in the skill set; a
product of several repositories keeps its product-wide corpus, transcripts
included, in its own product repository (the corpus custody of madarch-bwt,
`registry`). Rough cost: one to two more feature runs.
- Finding budget 5, the config key `findingBudget`: live-graph took in one new
finding, the MVP five.
- Rough size, an estimate: eight to ten feature runs, 20 to 30 hours of agent
work, about two weeks of calendar, from the pace so far (a run occupies two to
three hours of agent work and about a day of clock). Outcome 3 is the widest
and will likely be split into two features at planning.

## Next horizon

The `registry` milestone, as feature titles:

- Publish a product release over several sources, joined at the contract
boundary, with its portal (madarch-bwt).
- Keep the wiki current without hands: a pull-request check, a publish after
merge (madarch-tah).
- Serve the graph to agents over MCP, locally and from the server
(madarch-yhy).
- Find the call graph and interactions in source code (madarch-850).

## Ended

Ended early 2026-10-09 by decision 0017 (owner). Accepted: outcome 2
(madarch-hnq). Closed as moot: outcome 1 (madarch-o3b), whose per-repository
contract file 0017 drops. Deferred: outcomes 3 (madarch-1ui) and 4
(madarch-mv2). Its successor is `idea-to-wiki`.
