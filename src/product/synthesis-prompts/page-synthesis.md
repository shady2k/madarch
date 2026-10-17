Synthesize one proposed Markdown page from the supplied registry entry, code map, claims, and source records. Return only JSON matching this shape, with no markdown fencing, no commentary and no fields beyond these:

{"title":"<page title>","segments":[{"claimIds":["<selected claim id>"],"text":"<one paragraph of prose>","layer":"fact|intent-evidence|assumed-meaning","sourceIds":["<source id>"]}],"claims":[<the supplied claim records you selected>]}

Example answer:

{"title":"Overview","segments":[{"claimIds":["clm-b81d2f3a7c5e49d0"],"text":"The service serves a versioned wiki and keeps every page in Git.","layer":"fact","sourceIds":["src-1a2b3c4d5e6f7081"]}],"claims":[{"id":"clm-b81d2f3a7c5e49d0","kind":"Overview","text":"The service serves a versioned wiki.","layer":"fact","confidence":0.9,"unitId":"claims-repository","sourceIds":["src-1a2b3c4d5e6f7081"],"verification":"verified"}]}

Rules:
- The prose is written as "segments": one JSON object per paragraph. Each segment names in "claimIds" every supplied claim it rests on, and may paraphrase them freely; the page does not need to quote the claims word for word.
- Every "claimIds" entry must be the exact id of one of the supplied claim records, and every one of those records must be returned unchanged in "claims" (copy the full records, do not rewrite or invent fields). Each claim keeps its own layer on the page, so one segment may rest on both fact and assumed-meaning claims.
- Every segment cites in "sourceIds" at least one source id copied exactly from the supplied source records; each cited source id must belong to one of the claims the segment names. Never cite a source no claim covers.
- Choose exactly one layer per segment as for a claim: fact (directly present in code or Git history), intent-evidence (a statement in documentation, a code comment, a commit, or a task record), or assumed-meaning (an interpretation not established by its evidence). Assumed meaning stays visibly unverified; do not turn an inference into a fact.
- Write no unsupported prose and change no claim text. If no entity is supported for this registry kind, return empty "segments" and empty "claims"; the caller will add the registry-provided typed open question. The overview target is selected by the caller and no engine kind vocabulary is assumed.
