# 0002. The intended model is YAML in git

Status: accepted
Date: 2026-09-24

## Context and problem
What people intend (domains, services, interfaces, zones, data categories,
rules) must be reviewed, versioned and branched with the code it describes.

## Considered options
1. YAML files in git, compiled by the server.
2. JSON files in git.
3. A custom DSL.
4. Edit the model in the server's database through a UI or API.

## Decision
Option 1, permanently: YAML for editing by people and agents, restricted (no
anchors, merge keys or custom tags; duplicate keys are errors), multi-line
objects so diffs stay readable. The server reads it from git and never owns it.
A JSON Schema, generated from the same source as the code's types, validates it.

## Consequences
- Every change to intent goes through a pull request.
- YAML's ambiguities need a strict parser and the schema.
- The server's database is a working state, rebuildable from git and re-extraction.
- Revisit if hand edits become rare and a JSON-only format proves cheaper.
