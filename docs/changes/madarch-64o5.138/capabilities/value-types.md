# Value types

Capability: value-types

## Purpose
Reusable catalogue value contracts for decision 0039 items 3, 4 and 29.

## Requirement: validation — Declared types govern every value
Every catalogue field shall name a value type. A JSON field shall declare a Draft 2020-12 JSON Schema. The reader shall refuse missing types and schemas with the full source path and line. Shared schemas shall have unique immutable IDs and resolve references offline. Unknown formats, invalid schemas and unresolved references shall be refused. Patterns shall be declared only in shared catalogue value types, not field schemas. The writer shall reject invalid keys, vertex values and edge attributes with VALUE_TYPE_MISMATCH, field, expected type and value before publication SQL.

### Scenario: recorded-git-values
- Given: repository remotes and author name/email strings emitted by the Git and disk producers
- When: values include scp-like, local or empty remotes, empty identity strings or malformed recorded email
- Then: the Git remote and recorded-identity types accept those producer values without imposing strict URI or email rules; remote acceptance does not assert connectivity, and remote strings containing NUL are refused

### Scenario: missing-schema
- Given: a JSON field without a schema
- When: its catalogue is read
- Then: a finding names its full source path and line

### Scenario: invalid-value
- Given: a field using a shared email type and a document referencing that same type
- When: a writer receives a malformed email
- Then: publication refuses the value with VALUE_TYPE_MISMATCH before SQL
