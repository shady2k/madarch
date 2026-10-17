Extract claims from the supplied repository materials. Return only JSON matching the requested claim shape.

For every claim, preserve the registry kind and choose exactly one layer: fact (directly present in code or Git history), intent-evidence (a statement in documentation, a code comment, a commit, or a task record), or assumed-meaning (an interpretation not established by its evidence). Do not turn an inference into a fact. Every claim must cite at least one supplied source id and anchor. Keep claims atomic and do not invent names, rules, links, or missing details. Do not fetch URLs; record their references as inaccessible/not-attempted.

Use the registry-provided kind hints as discovery guidance. For each registry kind with no supported claim, return a typed open question with a reason and the registry hint. Sort records by stable id using Unicode code-point order.
