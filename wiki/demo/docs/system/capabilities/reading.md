# Reading

Capability: reading

## Purpose
The notes home's reading half: a note opens, reads in place, and its
links do not lose the reader.

## Requirement: reads-in-place — An old note reads in place
When a reader opens a note written at least two weeks ago, the reading
view shall show its text on the shared reading tokens with no layout
change while the reader reads, serving FR-001.

### Scenario: return
- Given: a note written three weeks ago
- When: the reader opens it in the reading view
- Then: the note reads in place, and no element moves while it is read

## Quality requirements
Performance: a note opens inside a second on the machine that serves it.
Usability: the reading column holds the accepted measure.

## Coverage limits
Handwriting and right-to-left scripts are out of what the tokens were
accepted against.
