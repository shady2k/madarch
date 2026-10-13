# Publish the discussion message contract

Change: discussion-message-contract
Base: b985d519a3107d92edc3e6fa358d4834277e7021
Tasks: madarch-y781.1.1
Kind: behavior

## Intent

A product repository can keep a discussion message in the owner-approved form, and tools can validate its message metadata and selection markers against one published, versioned contract. This is the early contract-only prefactor; the later y781 work will implement the UI and write path.

## Out of scope

Discussion UI, page shell or margin, server writes, per-action git commit/push/retry, reply or resolve interactions, graph indexing/search, and E2E UI tests. These remain deferred until madarch-0n3p and madarch-gj94 land and the full feature is staged.

## Changes to requirements

- product-repository/discussions (changed): publish the v1 discussion-message schema, validate its Markdown/front matter and source markers, and pin conformance cases for selected, overlapping, lost-anchor and page-level comments.

## Preserved contracts

- product-repository/manifest: unchanged; workspace identity and manifest versioning remain unchanged.
- product-repository/contract: existing registry and generic document-field schemas remain unchanged.

## Coverage

- product-repository/discussions: test, contract:check
- product-repository/manifest: test
- product-repository/contract: test, contract:check

## Rationale

The comments contract belongs beside the existing published product-repository contract, not in the generic document-field reader. The schema is version 1 at `https://github.com/shady2k/madarch/schema/v1/product-discussion-message.schema.json`; the front matter carries `contract: 1`. The existing product-repository contract checker and pinned examples are the smallest established route to validate and publish this form.
