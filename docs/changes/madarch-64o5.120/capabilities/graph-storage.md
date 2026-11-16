# Graph storage

Capability: graph-storage

## Purpose
Checked identities and relations in the graph's common writer: a reference is an edge, a mention of an entity in
written text is an edge of the statement that holds the string, and a plain name is only ever offered, never guessed.

## Requirement: mentions — A uid token in written text is an edge of the statement that holds it

The common writer shall scan every text field and every string inside a JSON value it writes, in decoded form, and
shall record each uid token — the characters `[[uid:`, a lowercase hyphenated UUID and `]]` — as a `mentions` edge from the written assertion to the named vertex. It shall
refuse a token naming no active vertex, naming the field's pointer, the code-point span, the uid and its own path and
line. The occurrence discriminator shall be the RFC 6901 pointer to the field or string plus the token's zero-based
code-point start and end in the decoded string, so two occurrences of one target stay two edges. When a source states a
field's text again, it shall retract the mentions of the statement it replaced in the same transaction; the rows stay
as history and no traversal reaches a token the text no longer holds. A backslash before the opening `[[` escapes the
whole token and `\\` escapes a backslash, consumed left to right; a malformed reserved token shall be a validation
error, not plain text.

### Scenario: token-becomes-edge
- Given: a written kind whose text field names a stated term `see` followed by that term's uid token
- When: the value is written by an agent
- Then: the graph holds a `mentions` edge from that assertion to the term, its discriminator the field's pointer and the token's code-point span

### Scenario: missing-target
- Given: a token whose uid names no entity of the product
- When: the value is written
- Then: the write is refused naming the field's pointer, the uid and the source, and the transaction leaves no vertex, edge or assertion

### Scenario: text-changed
- Given: a text with two tokens, written by one source
- When: that source states the same field again with one of the two tokens
- Then: the occurrence it left is retracted by that source, the repeated one stands again, and a traversal reaches one mention

### Scenario: escaped-token
- Given: a text holding a backslash before the opening brackets of a token
- When: the value is written
- Then: no mention edge is made and the text stays as written

## Requirement: mention-hints — A plain name is offered, never guessed

On every text write the answer shall carry the names the written value leaves unlinked: the field's pointer, the
code-point span, the name, and every same-named candidate as `{uid, kind, kindLabel, label, domain}`. A candidate shall
not create an edge. The hints shall be answered to an MCP write tool as they are to a person's write, and a name a
token already covers, or an escaped token, shall not be offered.

### Scenario: ambiguous-name
- Given: a domain and a subsystem both named `Payments`, the subsystem carrying the domain `Commerce`
- When: an agent writes a note whose label names `Payments` in plain text
- Then: the answer offers both candidates, each with its kind's label, and the graph gains no edge between them

### Scenario: mcp-answer
- Given: the same write through the MCP `put_entity` tool
- When: the tool answers
- Then: the answer carries the same hints as the in-process write answer

## Requirement: mention-dictionary — Names and synonyms of every entity, with the kind's label

The dictionary a plain name is matched against shall be every entity's name and its synonyms. Names shall be matched
literally, in code-point order, with no case folding, word boundary or guess. The synonyms shall be the common field the
system part declares on every entity, and a product kind shall not declare a synonyms field of another shape. A
same-named entity of another kind shall stay another candidate, and a candidate shown to a person shall name its kind.

### Scenario: synonyms-match
- Given: an entity named `Settlement register` whose synonyms hold `Settlement`
- When: a text names `Settlement` in plain text
- Then: the entity is offered as a candidate of that name

### Scenario: kind-label
- Given: two kinds whose labels are `Domain` and `Subsystem`, each with an entity named `Payments`
- When: the candidates are shown
- Then: each candidate carries its kind's label beside its label

## Requirement: unlinked-mentions — A page lists the names its text leaves unlinked, and one press links one

An entity's page shall list the names its own current text leaves without a link, each with the candidates it may
mean, rendered with the kit's Button. It shall not offer the page's own entity as a candidate. A press shall write the
token at exactly the span the page showed, as that person's statement of the field: a span the text no longer holds, a
span inside an existing token, or a target no active entity holds shall be refused naming the field and the place.

### Scenario: page-lists-and-links
- Given: a term whose body names a stated domain in plain text and no other name
- When: the term's page is opened and the candidate the page offers is pressed
- Then: the page lists the name with the domain's kind, and after the press the term's body holds the token and the graph holds the mention

### Scenario: stale-span
- Given: a page drawn before another source rewrote the field
- When: a reader presses a candidate the page showed
- Then: the write is refused saying the text changed since the page showed it, and the field keeps its current text
