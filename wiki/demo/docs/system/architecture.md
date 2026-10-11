# Fieldnote architecture

The current shape of the notes home, arranged as arc42; only the sections
this small product needs.

## Goals and quality requirements
Reading calm above all: nothing moves while a page settles (FR-001), and
a dead link never loses the reader (FR-002).

## Constraints
Notes are Markdown in git; the wiki is served locally from the working
tree; the documents follow the set's forms.

## Context and scope
```mermaid
flowchart LR
  reader([A person who keeps notes]) -->|reads| home[Fieldnote notes home]
  home -->|serves| wiki[The local wiki]
```

## Building blocks
- The notes repository: the documents, the prototypes, the records.
- The local wiki: the pages, the documents view, the check's findings.
