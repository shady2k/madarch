# Wiki walk

Capability: wiki-walk

## Purpose
A committed walk reads every page of a product's wiki through the server's JSON and reports the
milestone's five classes of defect with the page and field that carries each one. The same walk runs
in CI over the training product in both languages as a ratchet, so a new finding fails the job while
the findings already present stay counted rather than blocking every change.

## Requirement: five-classes — Every page is checked through its JSON for the five classes
When a filled product's wiki is walked, the walk shall read the status, every kind's catalogue, every
entity page in each interface language the manifest declares, and every document page through the
server's JSON responses. It shall report each empty section, raw key, passage outside the wiki's
language, raw id, and node drawn without evidence, naming the page, section, field and value. It
shall exit 0 when it finds nothing, 1 when it reports a finding, and 2 when a page cannot be read or
a document listing says it is truncated, naming the address.

### Scenario: every-class-is-found
- Given: a served fixture product with one planted empty section, raw key, foreign-language passage, raw id and node without evidence
- When: the walk runs
- Then: it reports exactly one finding of each class with the page, section, field and value, and exits 1

### Scenario: clean-product-exits-zero
- Given: a served fixture product with no finding of any class
- When: the walk runs
- Then: it prints no finding and exits 0

### Scenario: unreadable-page-exits-two
- Given: a product whose document listing reports itself truncated
- When: the walk runs
- Then: it exits 2 naming the address and the truncation

## Requirement: ratchet — CI holds each class to its baseline
When the walk runs in CI, it shall generate the training repository, fill and serve it, walk it in
English and Russian, and compare the count of each class with the baseline recorded beside the
script. It shall fail when a class count exceeds its baseline count, and when the baseline names no
class that the walk found. It shall pass when every count is at or below its baseline.

### Scenario: counts-hold-at-baseline
- Given: the training product whose per-class counts equal the baseline file
- When: the CI walk runs
- Then: the job passes and prints each class with its count

### Scenario: unnamed-class-fails
- Given: a walk that finds a class the baseline file does not name
- When: the CI walk compares the counts
- Then: the job fails naming the class
