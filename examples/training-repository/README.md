# Training repository generator

Run `node examples/training-repository/generate.mjs <destination>` from the Madarch checkout. The destination must be outside this repository; the generator replaces that destination and creates a deterministic Git repository with fixed authors, dates, and task keys.

`answer-key.json` stays with this generator and is never copied to generated output. It records the entities, rules, state transitions, interactions, contradictions, undocumented behavior, terms, links, and expected open-question types. The sign-in URL is an account settings page and is not evidence of private project content.

Run the focused regression with `bun test examples/training-repository/generator.test.ts`. This is an on-demand quality fixture, not a CI job.
