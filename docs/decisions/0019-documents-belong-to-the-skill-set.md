# 0019. The skill set forms and checks a product's documents; madarch is the server and its wiki

Status: accepted
Date: 2026-10-09

Refines 0016 and 0017: where they put a document contract, its templates or a
form check in madarch.

## Context and problem
Planning the product documents (vision, hypothesis, source, user story, use
case, product requirement, open question, prototype), madarch and the
shady2k-skills set came to own one contract from two repositories: forms and a
check in madarch, the skills that write the documents in the set, and a copy
of the templates in the set so it works without madarch, kept equal by CI. The
owner found the coupling too tight.

## Considered options
1. One repository for madarch and the skill set.
2. madarch owns the forms, templates and check; the skills call its commands
   and the set no longer works on product documents without madarch.
3. The skill set owns the forms, templates and the form check, as it already
   owns its feature specs, change records and their gate; madarch reads the
   documents in that form and serves them.

## Decision
Option 3, decided by the owner on 2026-10-09: "the skills are there to form
the documents; madarch is there as the wiki", and "in this repository we make
the server with the wiki: MCP, REST API, building diagrams, queries over the
graph, accepting changes and so on".

- **The skill set** holds every product document's form, its template, the
  check of its form and the skills that write it; its setup installs the check
  in a product repository as it installs its other checks. It needs no madarch.
- **madarch** is the server with the wiki: it reads a product repository's
  documents in the set's form, builds the graph in LadybugDB, links the
  documents, draws diagrams, answers queries, serves the wiki, MCP and a REST
  API, and accepts changes; where it accepts a change, it runs the check the
  set installed in that repository and shows that check's findings on the
  page, rather than a check of its own.
- madarch's tests read the examples the set publishes for each kind, so a form
  changed in the set reaches madarch's CI rather than a reader.

## Consequences
- madarch-fe1 becomes reading the product documents, linking them in the graph
  and showing the set's findings; the forms, templates and their check move to
  the set (skills-k8c and its siblings).
- The commit hook in a product repository is the set's gate; madarch installs
  none.
- madarch's own intended model format and its model check stay in madarch:
  they describe the architecture the graph is built from.
- Revisit if madarch must accept documents in a form the set does not define.
