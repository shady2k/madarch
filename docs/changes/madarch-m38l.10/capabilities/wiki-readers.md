# Wiki readers

Capability: wiki-readers

## Purpose
Who the wiki is for and who is writing in it: madarch's own wiki that opens
first and is reachable from every product, a glossary in every product whose
terms link from the text, the role a reader chose and what it changes on a
page, and the one place that answers who the user is for every write. The
decision behind it is `docs/decisions/0031-madarch-wiki-first-roles-and-identity.md`.

## Requirement: own-wiki — madarch's own wiki opens first and is one click away from every product
When the root of the server is opened and the products home holds no product,
the server shall open madarch's own wiki, a product of the same format served by
the same engine, whose pages are written for a reader who has never heard the
word "manifest". madarch's own wiki shall be in the product selector of every
product, always, and the top bar of every page shall carry a help icon beside the
language menu that opens madarch's documentation. A page shall carry no
documentation link of its own. madarch holds no product content of its own: its wiki is the madarch product
repository, and the program carries a pinned revision of that repository,
recorded in a lock line of this repository and fetched when the program is
built, so that a first run needs no network. The pinned revision shall be
installed as a git checkout of the repository in the madarch home and served as
an always-present entry. When the machine is online the wiki shall be refreshed
by fetching the repository and fast-forwarding the checkout, only when the
checkout has no change of its own; a refresh that fails or is skipped shall
leave the wiki as it stood and be named, with the repository and the folder, in
the server's log.

### Scenario: clean-home-opens-own-wiki
- Given: a products home with no product
- When: the root is opened
- Then: the answer redirects to madarch's own wiki, whose home page says in two words what madarch is, and the product selector lists madarch

### Scenario: help-icon-from-any-product
- Given: a products home with a product and madarch's own wiki
- When: a page of the product is opened and the help icon is pressed
- Then: madarch's own documentation opens, and no page of the product shows a documentation link of its own

### Scenario: offline-first-run
- Given: a machine with no network and no madarch's own wiki folder yet
- When: the server starts
- Then: the pinned revision is installed as a git checkout of its own and served, and nothing waits for the network

### Scenario: refresh-fast-forwards-an-untouched-checkout
- Given: an installed checkout of the pinned revision, and a repository that has moved on from it
- When: the refresh runs online
- Then: the checkout is fast-forwarded to the repository's head; a checkout with a commit or an uncommitted change of its own is left as it is and the log names its folder

## Requirement: glossary — Every product has a glossary whose terms link from the text
A product's glossary shall be the terms of the documents its manifest names as
glossaries. A term is a bold phrase that opens a list item; the item shall give
the definition in plain words, may list under it the synonyms ("Also called"),
the names the term has in code ("In code"), the places that use it ("Used in")
and an ambiguity ("Ambiguous"), the last with a link to an open question when one
exists. The glossary page shall list every term with its definition, its
synonyms and code names, the document and line it is stated at, and a mark on an
ambiguous term. Every term, and every synonym, that appears in the text of a
page shall be a link to its glossary entry when it is the same words, whole and
in the same case; the engine shall not guess a match. The glossary shall be read
without a fill.

### Scenario: terms-with-grounds
- Given: a product whose glossary document has a term with synonyms, code names and an ambiguity
- When: the glossary page is opened
- Then: the term shows its definition, its synonyms, its code names, the document and line it is stated at, and the ambiguity is marked

### Scenario: exact-term-links
- Given: a page whose text uses a glossary term, one of its synonyms and a word that only resembles a term
- When: the page is read
- Then: the term and the synonym are links to the entry and the resembling word is plain text

### Scenario: own-glossary
- Given: madarch's own wiki
- When: its glossary is opened
- Then: it defines manifest, kind, template, ground, statement, fill, unit and refresh

## Requirement: roles — A reader's role chooses which blocks of a page are open and what leads the navigation
The wiki shall ask the reader once, on the first open, which role they read as:
product, analyst, architect, developer, operations, tester or everything. The
card shall be skippable and a skip shall mean everything. The role shall be kept
in the user's settings on the machine, not per product, and shall be switchable
in the top bar at any time. The manifest shall declare, per role, which blocks of
a template are open and which groups lead the navigation. A block that is not
open shall stay on the page, collapsed, so that every page is one page in layers
and no role has a version of it. The wiki shall never guess a role from what a
reader does.

### Scenario: asked-once
- Given: a machine whose settings hold no role
- When: the wiki is opened, the role "developer" is chosen, and the wiki is opened again in another product
- Then: the card was shown the first time only, and the second open reads as a developer

### Scenario: skip-means-everything
- Given: the same machine
- When: the card is skipped
- Then: the role is everything, every block is open, and the card is not asked again

### Scenario: one-page-two-roles
- Given: a page of a code entity and a manifest that opens the source for the developer and the relations for the product role
- When: the page is read as each role
- Then: the same blocks are on the page, the source is open for the developer and collapsed for the product role, and the groups the role leads come first in the navigation

### Scenario: role-not-declared
- Given: a manifest that declares no role
- When: a reader chooses a role
- Then: everything stays open and the order of the manifest stays, and the manifest's finding for an unknown role names its file and line

## Requirement: identity — One place says who the user is, and every write records it
Every write the wiki makes to a product (an answer, a correction, a comment)
shall ask one module who the user is. Without a team server that module shall
answer with git's `user.name` and `user.email` of the product repository, shall
say whether the user's own signing key is configured, and shall mark the write
"local, not verified". If git has no name or no email, then the write shall be
refused with the product's path and the command that sets it. The mark shall be
written with the write, in the commit message and, for a comment, in the
message file. A module that answers from a team server's verified sign-in is
designed in decision 0031 and is not part of this capability.

### Scenario: answer-carries-the-git-identity
- Given: a product repository whose git has a name and an email
- When: an answer is written in the wiki
- Then: the commit's author is that name and email and its message states that the author is local, not verified

### Scenario: no-identity-refuses
- Given: a product repository whose git has no `user.name`
- When: an answer is written
- Then: nothing is written and the refusal names the product's path and `git config user.name`

## Quality requirements
- Security and data protection: the identity is a claim, never a proof; the wiki says so on every write and never shows "verified" for a local one.
- Usability: the role card and the help icon are reachable by keyboard and carry labels in both interface languages.
- Reliability: a failed refresh of madarch's own wiki never replaces working content with less, and an offline start needs no network.
- Compatibility: a manifest with no roles, no glossary and no own wiki folder reads as before.

## Context
Decision 0031, which amends 0029 (layers, glossaries, roles in one page) and
builds on 0021 and 0023.

## Coverage limits
- The team server's sign-in, server commits and role from the user's groups are designed in decision 0031 and not built.
- A glossary term found by an agent in code is written as a term in a glossary document by the fill; this change reads and shows those terms.
