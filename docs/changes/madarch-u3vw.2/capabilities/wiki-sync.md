# Wiki sync

Capability: wiki-sync

## Purpose
A reader can run the wiki's one refresh from the top bar and see what the run changed: the pages it
opened or closed, each a link, with a count; a run that changed nothing says so, and a failed run
says why. The result is the latest clean run's, read from the graph's own work items and kept beside
the store so a restarted server still answers with it.

## Requirement: top-bar — A visible Sync button runs the one refresh
When a product's wiki is served, its top bar shall carry a visible sync control in the wiki's
language. Pressing it shall send the same refresh request the fill menu sends and start no second
mechanism. While the run the reader started is under way, the control shall be spent, and it shall
return to its ready state when that run ends.

### Scenario: sync-presses-the-one-refresh
- Given: a served product wiki whose fill menu presses a refresh request
- When: the reader presses the top bar's sync control
- Then: the app sends one refresh request of the same kind the fill menu sends, and no other refresh is started

### Scenario: sync-is-spent-during-a-run
- Given: a sync run the reader started is under way
- When: the top bar is read
- Then: the sync control is spent and cannot start a second run

## Requirement: changed-pages — The finished run lists the pages it changed
When a sync run ends cleanly, the wiki shall list the pages it changed as links to their pages, in
code point order, with the count beside them. A run that changed no page shall say so in one line.
A run that failed shall say why behind the wiki's failure note and shall not write an empty result.
The list shall come from the nodes and edges the run's work items opened or closed, read as the
pages that stand for them now, and from the Markdown pages whose file was read. A first fill or
rebuild shall name every page it wrote; a run that read no new commit shall name none; a removed page
shall not be named. The list and the run's finishing time shall be kept beside the store, so a
restarted server still answers with the latest clean run's list.

### Scenario: a-run-lists-its-changed-pages
- Given: a filled product and a new commit that adds a function
- When: a sync run finishes cleanly
- Then: the list names the function's file page and its own page as links, with the count

### Scenario: an-unchanged-run-names-none
- Given: a filled product whose commit did not change
- When: a sync run finishes cleanly
- Then: the list says that no page changed

### Scenario: a-failed-run-does-not-write-the-list
- Given: a sync run whose fill or agent stage fails
- When: the run ends
- Then: the failure is shown and the previous list is not replaced by an empty one
