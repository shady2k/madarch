Extract claims from the supplied repository materials. Return only JSON matching this shape, with no markdown, no commentary and no fields beyond these:

{"claims":[{"kind":"<registry kind name>","text":"<one atomic claim>","layer":"fact|intent-evidence|assumed-meaning","confidence":0.85,"sourceIds":["<source id>"],"conflictsWith":"<document the claim conflicts with>","undocumented":true,"termPair":{"documentTerm":"<term>","codeTerm":"<term>"}}],"questions":[{"type":"decision-rationale","title":"<the question in one line>","prompt":"<what is not known, in full>","kind":"<registry kind name>","missing":"<access|document, for access-or-document-needed questions only>","claimTexts":["<exact text of a claim the question touches>"]}]}

The "claims" array is always required. "conflictsWith", "undocumented" and "termPair" are optional per claim: set "conflictsWith" only when the claim records that a supplied document states something the code contradicts, name the document by its repository path as supplied; set "undocumented" to true only when the claim records behaviour the code performs that no supplied document mentions; set "termPair" only when the claim records documents and code naming the same thing differently. Leave a claim's optional fields out entirely when they do not apply.

The "questions" array is optional. Add a question only for what no claim mark carries: a meaning the reader should clarify, the rationale behind a recorded decision, a "why" comment that deserves its own question, or content that cannot be verified from the supplied sources. A question carries exactly these fields and no others:
type (one of: meaning | contradiction | undocumented-behaviour | assumption-check | term | unverifiable | decision-rationale | access-or-document-needed), title, prompt, kind, missing, claimTexts

"kind" and the optional fields stay out unless they apply. For an access-or-document-needed question "missing" is required and is "access" or "document". "claimTexts" must copy the exact text of claims you returned in this same answer, so the question depends on them.

Example answer:

{"claims":[{"kind":"Overview","text":"The service serves a versioned wiki.","layer":"fact","confidence":0.9,"sourceIds":["src-1a2b3c4d","src-5e6f7081"]},{"kind":"Service","text":"README.md states orders are retained indefinitely, which the orders code contradicts with its 90-day purge.","layer":"assumed-meaning","confidence":0.8,"sourceIds":["src-243841befcd301abb7e78a22"],"conflictsWith":"README.md"}],"questions":[{"type":"decision-rationale","title":"Why retention purges at 90 days","prompt":"Why do non-shipped orders expire at 90 days rather than another interval?","kind":"Service","claimTexts":["README.md states orders are retained indefinitely, which the orders code contradicts with its 90-day purge."]}]}

"sourceIds" is always an array of source ids copied exactly from the supplied source records, never a single string.

For every claim, preserve the registry kind and choose exactly one layer: fact (directly present in code or Git history), intent-evidence (a statement in documentation, a code comment, a commit, or a task record), or assumed-meaning (an interpretation not established by its evidence). Do not turn an inference into a fact. Every claim must cite at least one supplied source id and anchor. Keep claims atomic and do not invent names, rules, links, or missing details. Do not fetch URLs; record their references as inaccessible/not-attempted.

Use the registry-provided kind hints as discovery guidance. Keep every claim's kind a registry kind name copied exactly.
