# Wiki navigation

Capability: wiki-navigation

## Purpose
The wiki's menu and catalogue share the product manifest's one-level group parents, so a reader sees
the same sub-areas in both and each group carries the total of its branch. What waits for the reader
— questions, tasks and problems — stands directly under Home with its counts, sources and settings
sit at the foot, and the glossary is a compact table whose original opens in place.

## Requirement: sub-areas — The menu and catalogue nest the manifest's one-level groups
When a product's manifest declares one-level group parents, the menu and catalogue shall nest each
group's sub-areas beneath it and show the group's total over every sub-area, counted before rows
that have their own pages are hidden. An edge that would make a cycle shall be discarded, and the
groups it would hide shall stand at the top level.

### Scenario: sub-areas-are-nested
- Given: a manifest whose Operations group holds configuration, dependencies, build-and-deploy and runtime sub-areas
- When: the menu and catalogue are read
- Then: the sub-areas stand nested under Operations and its total counts every row of the branch

### Scenario: a-cycle-stands-at-the-top
- Given: a manifest whose parent edges form a cycle
- When: the menu is read
- Then: the invalid edge is discarded and the groups stand at the top level rather than disappearing

## Requirement: waiting-first — What waits for the reader stands under Home
The menu shall place questions, tasks and problems directly under Home with their open counts, and
an empty count shall be grey. Sources and settings shall stand at the foot of the menu. The home
page's kind cards shall not stand on the front.

### Scenario: waiting-sits-under-home
- Given: a product with open questions, tasks and problems
- When: the menu is read
- Then: the three entries stand directly under Home with their open counts

### Scenario: empty-counts-are-grey
- Given: a product with no open problem
- When: the menu is read
- Then: the problems entry shows a grey zero

## Requirement: glossary-table — The glossary is a compact table
The glossary shall be a table with one row per term: the term, its definition in the wiki's
language, its source mark, and its place shown once. The original shall expand in place. Seven terms
shall fit one 1150 px screen.

### Scenario: a-term-is-one-row
- Given: a glossary term with a definition, a source and a place
- When: the glossary is read
- Then: it is one row carrying the term, the definition, the source and the place once, and the original opens in place

### Scenario: seven-terms-fit
- Given: a glossary with seven terms
- When: the glossary is read at 1150 px
- Then: all seven rows fit one screen

## Requirement: menu-state — A menu badge follows the page it counts
A tasks badge shall read the same closure the Tasks page reads, so a task a default-branch commit
closed is not open in the menu. A problems badge shall refresh when any file the Problems page reads
changes: the manifest and its templates, the Markdown kinds, documents, questions, corrections, and
the store's identities and classifications. A manifest group may say `open: true`, and the menu
shall open it without naming the product group in the app.

### Scenario: a-commit-closed-task-is-not-open
- Given: an open task that a default-branch commit closes
- When: the menu's tasks badge is read
- Then: the task is not counted as open

### Scenario: a-group-marks-itself-open
- Given: a manifest group with `open: true`
- When: the menu is first drawn
- Then: that group is open without the app naming it
