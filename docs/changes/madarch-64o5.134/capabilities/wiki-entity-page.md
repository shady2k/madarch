# Entity page and documents

Capability: wiki-entity-page

## Purpose

The page every entity opens with, and the document page that extends it, state what the graph knows of the entity:
every declared field with its value and the opinions that hold it, the containers the entity lies in, the place its
newest opinion rests on, its relations both ways as far as there are rows, and its picture at the depth the renderer
draws. A document adds its Markdown body. A picture a renderer cannot draw says so with the place and the cause the
server reported, in the reader's language; the reader chooses another renderer himself, and the page never stands in
for one renderer with another.

## Requirement: details — every declared field is stated with its opinions

The page shall ask the graph for the entity's details and draw each declared field with its value, a mark on a field
two producers disagree on, and under the value the producer that stated it and the place it rests on, without a table,
a data file or a text pointer of its own.

### Scenario: disputed-field
- Given: an entity whose `url` field two producers state with different values
- When: its page is opened
- Then: the `url` row states no value, wears the disputed mark, and its source line names both producers

### Scenario: untouched-kind
- Given: a kind no template describes
- When: an entity of it is opened
- Then: its page states every declared field, and no page of the product stands without one

## Requirement: trail — the containers are links

The page shall walk the containers the graph answers (a member's `partOf` outward, a container's `contains` inward) and
draw each as a link into its own page.

### Scenario: file-in-folders
- Given: a file in a repository and two folders
- When: its page is opened
- Then: the breadcrumb names the repository and the folders in order, each linked to its page, and the file last

## Requirement: picture — a failure is its own answer

The diagram section shall ask the server for one format, draw the answer, and on a failed answer state the reader's
sentence with the place and the cause the server reported; it shall not ask another format in the answer's place.

### Scenario: likec4-cannot-draw
- Given: a LikeC4 render that fails with a cause
- When: the page is opened
- Then: one alert names what happened, the place and the cause are shown as data, and only the chosen format was asked

## Requirement: document — the body is the graph's text

A document page shall draw the graph's Markdown under a header that names its file, its folders and its repository, and
open an outside link in a new tab.

### Scenario: guide-page
- Given: a document entity whose `body` field holds Markdown
- When: its page is opened
- Then: the body is drawn in the reading column, its headings answer their anchors, and an `http` link opens a new tab
