Extract claims from the supplied repository materials. Return only JSON matching this shape, with no markdown, no commentary and no fields beyond these:

{"claims":[{"kind":"<registry kind name>","text":"<one atomic claim>","layer":"fact|intent-evidence|assumed-meaning","confidence":0.85,"sourceIds":["<source id>"]}]}

Example answer:

{"claims":[{"kind":"Overview","text":"The service serves a versioned wiki.","layer":"fact","confidence":0.9,"sourceIds":["src-1a2b3c4d","src-5e6f7081"]}]}

"sourceIds" is always an array of source ids copied exactly from the supplied source records, never a single string.

For every claim, preserve the registry kind and choose exactly one layer: fact (directly present in code or Git history), intent-evidence (a statement in documentation, a code comment, a commit, or a task record), or assumed-meaning (an interpretation not established by its evidence). Do not turn an inference into a fact. Every claim must cite at least one supplied source id and anchor. Keep claims atomic and do not invent names, rules, links, or missing details. Do not fetch URLs; record their references as inaccessible/not-attempted.

Use the registry-provided kind hints as discovery guidance. For each registry kind with no supported claim, return a typed open question with a reason and the registry hint. Sort records by stable id using Unicode code-point order.
