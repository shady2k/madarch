# Training repository generator

Run `node examples/training-repository/generate.mjs <destination>` from the Madarch checkout. The destination must be outside the checkout. The generator creates a deterministic, scripted Git repository with orders, payments, promotions and checkout services, contracts, operating files, and a six-month history.

`answer-key.json` stays beside the generator and is never copied into the generated repository. It contains atomic wiki assertions, named snapshots and planted history counts. Each assertion points to evidence at a snapshot and states what the wiki should show, its viewpoint, whether it is needed now, and how to judge it.

The generator regression is run with `madarch-sky-test <worktree> examples/training-repository/generator.test.ts`; it checks determinism, key locations, history counts and excluded files.
