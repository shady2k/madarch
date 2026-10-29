# Domain page

Capability: domain-page

## Purpose
A domain page answers the question a person asks when they open it: what does this part of the product do, for whom,
and how does it go? It opens with the business — who takes part, the main scenario in plain steps, the rules that
govern it, what can go wrong, and what is still open — and it keeps the developer's detail in one section at its
end. The sections are the core's, their headings are in the wiki's language, every place a page names is a key the
graph held when the page was written, and a part the documents or the graph leave empty is said on the page instead
of being left out. The unit that writes the page summarises what the earlier units of the run already established —
the enriched scenarios, rules and decisions — instead of reading the code again.

## Requirement: business-first — A domain page carries the business before the code, in six sections whose order and headings the core owns

A domain page carries six sections in this order: Participants, Main scenario, Rules that govern it, What can go
wrong, Open points, and For the developer. The unit gives the parts; the core writes the sections, so no part is
missing because a model forgot it, and the headings are in the language the product's pages are written in.

### Scenario: the-page-opens-with-the-business
- Given: a domain of the training product, and a unit that read its documents and the pages the earlier units wrote
- When: the unit writes the domain's page
- Then: the page carries Participants, Main scenario, Rules that govern it, What can go wrong, Open points and For the developer, in that order, and no other section stands between them

### Scenario: a-ru-page-carries-the-same-sections
- Given: a product whose pages are written in Russian, and the same fields of the same domain
- When: its domain page is written
- Then: its headings are the Russian headings of the same six sections, in the same order, and its places are the same graph keys the English page names

## Requirement: participants-and-steps — Participants are roles and systems in plain words, and the main scenario is numbered steps in the order a person lives them

Participants are one bullet each: a role a person plays or a system the product talks to, named for a reader and not
for a folder. The main scenario is a numbered list whose steps follow one another as the person and the product go
through them. Each statement of both is grounded on a document section, on a container the product is made of (a
service, a module, a file) or on an answered question, and a gap the documents leave — no participant named, no step
told — is a sentence on the page, grounded the same way.

### Scenario: participants-are-plain-words
- Given: a domain whose passage names a shopper and the promotions service, and a unit that read it
- When: the unit writes the page
- Then: Participants holds one bullet per participant, each a sentence about a role or a system with the footnote that lists its grounds

### Scenario: the-main-scenario-is-numbered
- Given: a domain whose main scenario the unit gives as three steps
- When: the page is written
- Then: Main scenario holds the three steps as `1.`, `2.` and `3.`, in the order the unit gave them, each with its own footnote

## Requirement: code-detail-belongs-to-the-developer — Routes, codes, headers and timeouts stand only in the section for the developer, and a business field refuses them by the key they are named by

A business section says what the domain is for in words a reader needs no code to follow. The places of the code —
a route, a function, a table, a channel — are the developer section's, where each is a key the graph held when the
page was written and where the codes, headers and timeouts are stated as sentences grounded on those keys. A
business field that names a place of the code is refused with the field, the key and the section the key belongs to,
and nothing is written. The developer section's keys are the page's `relates`, so the engine can draw from them.

### Scenario: a-code-key-in-a-business-field-is-refused
- Given: a unit that grounds a step of the main scenario on a route of the graph
- When: it writes the domain's page
- Then: the write is refused, the refusal names the field, the key and the developer section, and nothing is written

### Scenario: the-developer-places-are-the-pages-relates
- Given: a domain page whose developer section names one route, two functions and one table
- When: the page's front matter is read
- Then: its `relates` names those four keys in code point order, and every one of them is a key of the graph at the last filled commit

## Requirement: open-points — A statement the unit cannot ground is refused, and what the documents and the graph leave unsaid is said as an open point

Every statement a page carries is grounded: a sentence with no footnote, or a footnote whose grounds do not
resolve, is refused with the rule that names it. What the unit cannot show is therefore never written as fact; the
unit states it in Open points as a sentence about what the documents and the graph leave open, grounded on the
passage it read. A business section the documents settle nothing about says so in its own sentence rather than
standing empty.

### Scenario: an-ungrounded-statement-is-refused
- Given: a unit that states a participant with no grounds
- When: it writes the domain's page
- Then: the write is refused with the rule that says a statement stands on at least one ground, and nothing is written

### Scenario: a-field-the-documents-leave-empty-is-said
- Given: a domain whose documents name no rule that governs it
- When: its page is written
- Then: Rules that govern it holds a sentence saying the documents name no rule for this domain, grounded on the domain's passage, and is never an empty heading

## Requirement: summary-of-earlier-units — The domain unit writes from the enriched scenarios, rules and decisions the earlier units produced, not by reading the code again

The unit is handed the pages the earlier units of the run wrote — the enriched use cases, rules and decisions — and
states the domain from them, so one fact is told the same way on the domain page and on the page it came from. The
code is read only for the developer section, and only for the places that section names.

### Scenario: the-unit-is-handed-the-earlier-pages
- Given: a fill whose scenarios, rules and decisions units have written their pages
- When: the domain unit is asked for its page
- Then: its prompt carries the pages of those kinds it reads, and the pages it writes name the same rules the enriched use cases named
