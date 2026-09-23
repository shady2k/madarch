# 0005. Intended, extracted and observed facts are separate layers

Status: accepted
Date: 2026-09-24

## Context and problem
What people intend and what tools find disagree, and both matter: a found
dependency can exist and violate the intended architecture at the same time.

## Decision
Every assertion records how it was obtained (declared, extracted, inferred,
observed) separately from whether it is accepted (proposed, accepted,
rejected). Extracted facts never modify the intended model; an AI agent's
inferences are proposals until a person accepts them, and acceptance adds a
record without rewriting the origin. Missing evidence is "not enough data", never
proof of absence, unless the plugin reports complete coverage for that scope.
Checks treat unknown zones or categories as "not enough data", never as a pass.

## Consequences
- Drift reports are honest: "found but not intended", "intended but not found",
  "not enough data".
- Queries must say which layers they read.
- Revisit if the layers prove too many for users to reason about.
