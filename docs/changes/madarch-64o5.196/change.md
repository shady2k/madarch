# Authored tasks with optional fields leave Problems readable

Change: madarch-64o5.196
Base: c8fffa3e335fb45cad8ad1f5da9a72d2ac3b257e
Tasks: madarch-64o5.196
Kind: no-behavior

## Intent

Creating a task without a description is valid in the starter catalogue. The Problems listing and count should remain readable when that task is present.

## Rationale

The semantic role protocol defines which fields its readers require. The graph projection omits absent optional values, preserves explicit nulls when the role accepts them, and omits optional values that have no declared semantic mapping. This lets a task name a third-party tracker and lets a document resolve a stub commit by its hash while the required role fields and problem-to-task links keep their existing checks.

## Out of scope

The product manifest governs authored writes. The role protocol governs graph reads, and this change applies it to field projection.

## Preserved contracts

- product-wiki/pages: the Problems page lists the product's findings and keeps the task link for a finding whose task was created from Problems.

## Coverage

- product-wiki/pages: test

## Where it is seen

Kind: request
Place: `GET /api/problems` and `GET /api/problems?count=1` after writing an authored task

1. Create a task without a description. Both reads return HTTP 200 with the same findings and counts as before the task was written.
2. Create a task with a description and clear it. Both reads return HTTP 200.
3. Create a task with a third-party tracker. Both reads return HTTP 200 with the same findings and counts.
