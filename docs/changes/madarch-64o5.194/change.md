# Restore authored records in the wiki

Change: madarch-64o5.194
Base: c8fffa3e335fb45cad8ad1f5da9a72d2ac3b257e
Tasks: madarch-64o5.194
Kind: no-behavior

## Intent

A person can create records from an authored kind's page and edit or delete them from their own pages. Validation identifies the rejected field, and a concurrent edit leaves the recorded value intact until the reader reloads the changed field.

## Out of scope

Reader-facing names for journal authors, historical browsing of deleted records, and updates to templates in installed products.

## Rationale

The starter templates read the kind, fields and revision through GraphQL and call the existing guarded authored command. The command's conditional writes preserve its per-field edit and exact-revision delete rules.

## Changes to requirements

None.

## Preserved contracts

- server/serves-wiki: the wiki reads pages through GraphQL and sends writes through the guarded command.
- server/explains: the field and reason reach the reader, and the engine location stays in the server log.

## Coverage

- server/serves-wiki: test
- server/explains: test

## Where it is seen

Kind: request
Place: an authored kind page and its record pages in the everything starter

1. Create a record, then inspect its selected values through GraphQL.
2. Edit the same field from two open forms. Inspect the conditional write refusal and reload the field before saving.
3. Confirm deletion and inspect the existence retraction and its author in the graph journal.
