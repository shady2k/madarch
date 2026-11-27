# Restore the clean start of an everything product

Change: madarch-64o5.185
Base: c97952c854b88332398c0d65d0de3f227059e249
Tasks: madarch-64o5.185
Kind: no-behavior

## Intent

A fresh product opens with working fill plans and no evidence problems on its starter records. Wiki API refusals keep
engine locations in the server log and show the reader actionable messages.

## Out of scope

Evidence backed by commit records and GraphQL error formatting have their own tracked work.

## Rationale

The planner, the evidence problem rule and the HTTP refusal boundary can each restore the existing startup behavior
using the declarations that already describe producers and evidence. The release walk exercises all three together.

## Changes to requirements

None.

## Preserved contracts

- server/serves-wiki: the starter catalogue and the wiki open together after publication.
- server/explains: refusals remain actionable and server logs retain the diagnostic detail.

## Coverage

- server/serves-wiki: test clean-install-walk
- server/explains: test

## Where it is seen

Kind: request
Place: the wiki home, its problems endpoint and its fill-plan endpoint on a fresh everything product

1. Open the wiki after publication and check that it reports zero open problems.
2. Plan a full fill and a plugin-only fill from the navigation kinds.
