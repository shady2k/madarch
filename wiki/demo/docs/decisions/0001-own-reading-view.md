# 0001. The reading view is ours, on the shared tokens

Status: accepted
Date: 2026-10-11

## Context and problem
The wiki shows a note; who owns the way it reads — an outside component
or this product — decides every later reading change.

## Considered options
- Build on an outside reader component: fast start, reading behaviour
  owned elsewhere.
- Write our own reader over a plain Markdown parser, styled by the
  product's shared tokens: more code here, every reading rule ours.

## Decision
Our own reader over a plain Markdown parser, on the shared tokens: the
fluid-width reading column the research asked for, the accepted type
scale, and every later reading rule changed here.

## Consequences
Reading defects are ours to find; the fixture product carries the pages
that show the reading, and a rule changes only with the page read
rendered (PRA-001).
