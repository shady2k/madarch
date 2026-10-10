# The reading requirement

## Problem

Coming back to a note is often harder than writing it. The reader
arrives out of context: a different day, a different task. If the page
asks for effort - small type, broken links, layout that shifts - the
note loses the thread and the thought is lost with it. We want the
return to be quiet and immediate.

## Scenario

- **Given** a note written at least two weeks ago
- **When** the reader opens it in the reading view
- **Then** the page is readable in place, every link resolves, and
  nothing moves while they are reading it

We treat this as a requirement, not a preference: a note that fails the
scenario is broken, whatever else it does well.

## What "reads well" means

Concretely, three things, checked every time the reading view changes:

- Text at a comfortable size and line length, no scrolling gymnastics
- No layout shift while the page settles
- Links that point somewhere real, checked before a note is `settled`

The typography findings behind the first point are in
[Research: typography](../research/typography.md). The choice to build the
reading view ourselves is recorded in
[Owning the reader](../decisions/0001-own-the-reader.md).

## Open questions

1. Should the reading view remember the last position in a note, or is
   a quiet top-of-page return good enough?
2. How do we check link health without making every note a chore to
   close?
