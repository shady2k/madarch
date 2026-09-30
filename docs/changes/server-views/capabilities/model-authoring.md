# Model authoring

Capability: model-authoring

## Purpose
Letting a coding agent write and keep the intended model of a repository: a
skill, installed from madarch into any agent that reads Agent Skills, that
reads the repository's documents first, confirms or refutes what they claim in
the code, writes the model with evidence on everything, and leaves beside it a
review report of what it found. The same skill updates the model inside a pull
request from that pull request's changes.

## Requirement: skill — One skill, in the Agent Skills format
madarch shall ship the skill as one Agent Skills folder holding its
instructions, a short reference of the intended model's format with a worked
example, and the command of the model check it runs, so that an agent given
the folder and a checkout of madarch needs nothing else to write a model.

### Scenario: installed-skill
- Given: an agent with the skill's folder installed and a checkout of madarch
- When: it is asked to write the intended model of a repository that has none
- Then: it writes the model and the review report and runs the model check, reading nothing outside the skill's folder, madarch's checkout and the repository

## Requirement: documents-first — Documents are read first and checked in code
When the skill writes a model, it shall read the repository's documents first
(README, architecture documents, decision records, specifications, contract
files) and record each architectural claim they make, then look for each in the
code. A claim from an accepted decision record or a specification is intent: it
enters the model even where the code disagrees, and the disagreement is
reported. A claim from descriptive prose is a hypothesis: it enters the model
only where the code confirms it. What the code shows that no document claims
enters the model where it is architecturally significant, and is reported as
undocumented. Plans the documents announce ("in phase 2") are reported, never
modelled.

### Scenario: stale-architecture-document
- Given: a repository whose architecture document names a module `config` that the code no longer has, its settings now in a folder `settings`
- When: the skill writes the model
- Then: the model has an element for `settings` with evidence in the code and none for `config`, and the report lists the `config` claim as contradicted, with the document's line and the code it was checked against

### Scenario: undocumented-package
- Given: a repository whose documents never mention a folder `notify` that other code imports
- When: the skill writes the model
- Then: `notify` is in the model (on its own or inside a group) and the report lists it as undocumented

## Requirement: evidence-rules — Evidence supports what it is attached to
When the skill writes evidence, each item shall name the text that supports
the thing it is attached to, at the commit read and with its blob: for an
element, its entry point, where it is wired together or its public contract;
for a dependency found in imports, the import line; for an interaction at run
time, where the handler is registered or where the call or send is made, never
an import alone; for an interface, its contract file and where its provider
registers it. A group of modules is evidenced by where its members are wired,
not by a list of folders.

### Scenario: runtime-interaction-evidence
- Given: a frontend that calls the backend's API over a WebSocket, and a backend package the frontend never imports
- When: the skill writes the relation from the frontend to the backend
- Then: its evidence names the frontend's call site and the backend's handler registration, each with commit and blob, and no import line

## Requirement: review — A review report beside the model
When the skill writes or updates a model, it shall write the review report,
`review.md` in the model's folder, with: the commit it describes; a claims
table of each document claim with its document, line, commit and blob, the
code it was checked against, its verdict (confirmed, contradicted, stale,
planned or unconfirmed) and what the model does with it; the undocumented
findings; the assignment table, each row a path and the element it belongs to
or `excluded` with a reason; and the problems, those the model check reports
and those the skill found reading, each naming its method, its source and the
model ids involved. A problem that needs judgement (a risk, a threat) is
written as a question, with its source, not as a defect.

### Scenario: review-written
- Given: a repository with a documented architecture and one package no document mentions
- When: the skill has written the model
- Then: `review.md` holds the commit, the claims table, the undocumented package, an assignment row for every tracked file's folder and the problems with their sources, and the model check reads its assignment table without error

## Requirement: checked — The skill finishes on a clean check and read views
When the skill has written or updated a model, it shall run the model check
with views, correct every error it reports, read the rendered pages as a reader
would, and finish only when the check passes, reporting what the check still
lists as stale or as problems.

### Scenario: error-corrected
- Given: a first draft whose evidence names a line past the end of its file
- When: the skill runs the model check
- Then: it corrects the item and runs the check again, and it finishes only after a run that passes

## Requirement: send — The model is sent to a server when one is named
When the skill finishes on a clean check and a madarch server's address is
given (in the request or in `MADARCH_SERVER`), it shall send the model with
the send command and report the source name and commit the server stored, or
the server's refusal. Without an address it sends nothing and says how to
send later.

### Scenario: send-after-check
- Given: a model the skill has just checked clean, and `MADARCH_SERVER` set to a running server
- When: the skill finishes
- Then: it has run the send command, and its report names the source and commit the server stored

## Requirement: update — The model is updated inside a pull request
When asked to update a model for a pull request, the skill shall read the
branch's changes against its base, the pull request's description and the
existing review report, change only the elements, relations, interfaces and
evidence the changes touch, keep every id and assignment the changes do not
concern, and add to the review report a section of what changed in the model
and why, with the pull request's range. The update lands in the same pull
request as the code.

### Scenario: package-added-in-a-branch
- Given: a model and review report at the base, and a branch that adds a folder `export` imported by the core
- When: the skill updates the model for the branch
- Then: `export` is in the model with evidence at the branch's commit and blob, every other id is unchanged, the assignment table covers `export`, and the report's new section names the range and the added element

### Scenario: nothing-architectural
- Given: a branch that changes only the body of one function in a module already modelled
- When: the skill updates the model for the branch
- Then: the model's elements and relations are unchanged, stale items whose files changed are re-read and re-pinned, and the report's new section says the branch changed nothing architectural

## Quality requirements
- Performance: not applicable (an agent's session; its time is recorded per
  run).
- Reliability and recovery: the skill writes only in the model's folder of the
  repository; a failed run leaves the previous model and report as they were
  in git.
- Security and data protection: no secret values are written; environment
  bindings name variables only, as the format requires.
- Data: not applicable.
- Usability: every claim, finding and problem in the report names where it
  came from, so a person can check it without asking the agent.
- Compatibility and operation: any agent that reads Agent Skills and can run
  git and Bun.

## Context
Capability server (the send command). Decisions 0002 (the intended model in git), 0005 (intended, extracted and
observed layers), 0014 (format principles). The comparison of documents with
code follows reflexion models: G. C. Murphy, D. Notkin, K. Sullivan, "Software
Reflexion Models" (FSE 1995), whose convergences, divergences and absences are
the confirmed, undocumented and contradicted claims here.

## Coverage limits
The model is what one agent read in one session: groups of modules are its
judgement, checked by a person reading the views and the report, not by any
check. The provenance of each fact (document or code, confirmed when) is kept
in the report, not in the model; the model's own fact layer is later work.
