# 0016. madarch becomes the product's knowledge base; authoring moves to the skill set

Status: accepted
Date: 2026-10-08

## Context and problem
The vision serves architects, engineers, security engineers and agents with an
architecture graph. Walking the user journey "I have a repository, how do I get
its wiki", the owner set a wider goal: one wiki in which any reader understands
the whole product, from its business vision down to the lines of code, with
facts behind every claim. Today the wiki shows the model's elements, interfaces,
zones, data categories and the repository's Markdown documents as they are; it
has no use cases, no requirement-to-code links, no flows, no data entities and
no backlinks from documents.

## Considered options
1. Keep madarch an architecture graph; product documents stay plain pages.
2. madarch defines its own document format and its own authoring skill, kept in
   step with the owner's skill set by hand.
3. One versioned document contract owned by madarch; all authoring lives in
   the owner's skill set (shady2k-skills); madarch is the backend.

## Decision
Option 3, decided by the owner in conversation on 2026-10-08.

- **Scope.** The wiki covers the product for every role (owner, product owner,
  analyst, product engineer, designer, architect, security, privacy and
  compliance, DevSecOps, DevOps, on-call, QA, newcomer, external integrator,
  AI agent): vision, roadmap, status, requirements, use cases, user stories,
  architecture, deployment (environment variables, stands), external
  integrations, data entities with their classification (personal data,
  commercial secret, communications secrecy) as a data catalogue, and code
  with file and line evidence. Everything is cross-linked, with backlinks. It
  starts from an empty folder, an existing repository or a legacy one; one
  repository, a monorepo or many.
- **Use cases are scenarios over the model.** A scenario's steps follow the
  model's relations, so its sequence diagram, the data flow, the backlinks on
  each participant and its status (planned, partly built, built, regressed, by
  evidence) are computed, not written.
- **Authoring in the skill set, determinism in madarch.** The skills that ask,
  judge and write (the model, use cases, data entities, onboarding a
  repository, mapping its existing documents) belong to shady2k-skills.
  madarch owns the contract and its check, compilation, history, the graph, the
  wiki and portal, the server, the command line and MCP.
- **One versioned contract, installed by setup.** Its source lives in madarch,
  is built into one dependency-free file with a `--version`, and the skill
  set's setup installs it verbatim in a repository, as it installs its own
  checks. Documents follow the contract from the first day, whether or not
  madarch is ever connected. A repository may keep its documents where they are
  through a path mapping; their format is the contract's. The server accepts a
  range of contract versions and refuses others naming the range.
- **Two modes.** Local: one repository, an embedded graph, a local MCP for
  agents, the wiki built in place, no server. Server: a product of many
  repositories joined by contract, history and the portal.
- **Its own code index.** madarch indexes code itself instead of only
  consuming other indexers, through its own extraction plugins (decision 0004)
  built on tree-sitter and SCIP rather than its own parsers. Layers: files and
  imports, symbols, the call graph, interactions (topics, hosts, ports from
  configuration and deployment), data flow inside code (a prototype first).
- **Open questions in the wiki.** A section lists what is missing before the
  picture is complete: computed by the contract check, raised by the agent's
  review, or asked of people and not yet answered. Each names what is missing,
  who can answer, what stays incomplete and where the answer goes; it closes
  when the answer is in a document and the check passes. "Not applicable" is
  an answer; empty is not. Completeness is shown per role.

## Consequences
- The vision changes: its audience, its non-users and exclusions ("code-level
  analysis of its own" is reversed), its journeys and its direction. The
  milestones are reworked through `to-milestone`; live-graph's outcome 2
  (madarch-bwt, the "thin portal") is replanned against this direction before
  it starts.
- The skill `skills/write-intended-model` moves to shady2k-skills; the model
  check stays in madarch and becomes part of the contract file.
- A contract release in madarch means a skill-set release carrying the new
  file; the skill set's CI runs the contract's conformance examples.
- Open: whether connecting a product and connecting a repository are one setup
  or two; how onboarding reaches sources such as Confluence in closed networks;
  a documents-only setup mode in the skill set for repositories that do not
  adopt its tracker workflow.
- Revisit if keeping the documents current costs more with each repository,
  the vision's counter-metric.
