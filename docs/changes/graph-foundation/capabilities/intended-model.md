# Intended model

Capability: intended-model

## Purpose
Reading what people and agents declare the architecture to be from the YAML
files of a repository, refusing anything that cannot be read exactly, and
saying where each problem is.

## Requirement: strict-yaml — Strict YAML only
When the model's files are loaded, the loader shall refuse anchors, aliases,
merge keys, custom tags and duplicate keys, naming the file and line of each.

### Scenario: duplicate-key
- Given: a model file in which one element has the key `parent` twice
- When: the model is loaded
- Then: loading fails with an error naming the file, the line and the key, and no model is produced

### Scenario: anchor
- Given: a model file that defines an anchor and refers to it with an alias
- When: the model is loaded
- Then: loading fails with an error naming the file and the line of the anchor

## Requirement: schema — Every file matches the model schema
When the model is loaded, the loader shall validate it against the model's JSON
Schema, refusing unknown fields, missing required fields and values of the
wrong kind, naming the file, the line and the path of each problem. The schema
is published as a JSON Schema file generated from the same source as the code's
types.

### Scenario: unknown-field
- Given: an element with a field `owner` that the schema does not define
- When: the model is loaded
- Then: loading fails with an error naming the file, the line and the path `elements[2].owner`

### Scenario: all-errors
- Given: a model with three independent schema errors in two files
- When: the model is loaded
- Then: the error lists all three, each with its file and line

## Requirement: files — A model is every YAML file in its folder
When a repository's model is loaded, the loader shall read every `*.yaml` file
in its `madarch/` folder as one model, in a fixed order, so that splitting a
model across files changes nothing but where each part is written.

### Scenario: split-model
- Given: the same model written once in one file and once across three files
- When: both are loaded and compiled
- Then: the two compiled models are identical

## Requirement: ids — Ids are unique and stable
While a model is valid, every element, interface, relation, zone, category,
environment and state shall have an id unique within its kind across the
model, of letters, digits, dots, dashes and underscores, which does not change
when the thing moves or is renamed. If an id repeats, then the loader shall
refuse the model naming both places.

### Scenario: duplicate-element-id
- Given: two elements with the id `orders-api` in different files
- When: the model is loaded
- Then: loading fails with an error naming both files and lines

## Requirement: references — Every reference resolves
When the model is loaded, the loader shall resolve every reference (an
element's parent, a relation's ends, a refined relation, an interface's
provider, a relation's interface, zones, categories, environments and states)
and refuse any that names nothing, naming the referring place and the missing
id.

### Scenario: unknown-parent
- Given: an element whose `parent` is `billing`, and no element `billing`
- When: the model is loaded
- Then: loading fails naming the element, its file and line, and `billing` as not found

## Requirement: nesting — Elements nest to any depth
The model shall let an element have one parent element, to any depth, and shall
refuse a cycle of parents naming the elements in it. Kinds of element are
person, external, domain, system, service, module, store and broker.

### Scenario: service-gains-internal-elements
- Given: a model where `checkout-web` relates to `payments-api`, then a version where `checkout-web` gains the modules `checkout-cart` and `checkout-ui` and the relation starts at `checkout-cart`
- When: both versions are compiled and viewed at the level of services
- Then: both views show the same single relation from `checkout-web` to `payments-api`

### Scenario: parent-cycle
- Given: `a` has parent `b` and `b` has parent `a`
- When: the model is loaded
- Then: loading fails naming `a` and `b` as a cycle

## Requirement: moves — Moving an element keeps its identity
When an element's parent changes, its id, its interfaces and every relation
naming it shall stay the same; only its place in the tree changes.

### Scenario: service-moves-domain
- Given: `payments-api` under `payments`, then a version where it is under `finance`, with the same relations
- When: both versions are compiled
- Then: `payments-api` keeps its id, interfaces and relations; only its ancestors differ

## Requirement: relations — Relations at any level, refined explicitly
The model shall let a relation join elements at whatever level of detail is
known. A relation may refine another; its ends shall be the refined relation's
ends or their descendants, otherwise the model is refused. A relation that
names an interface or carries data transfers is an interaction, a node with its
own id.

### Scenario: refinement-outside-ends
- Given: a relation refining `checkout-uses-payments` whose end is `orders-api`, outside `payments`
- When: the model is loaded
- Then: loading fails naming the refining relation and the end that is out of place

## Requirement: transfers — Data transfers have a direction each
An interaction shall carry any number of data transfers, each with a direction
(forward, from the initiator, or reverse), a confidentiality and a list of data
categories, the two kept separate.

### Scenario: two-directions
- Given: the interaction `checkout-charges-card` sends payment-card and personal data forward and nothing categorised back
- When: the model is compiled
- Then: the compiled interaction has a forward transfer with categories payment-card and personal, confidentiality confidential, and a reverse transfer with no categories, confidentiality internal

## Requirement: contracts — Interfaces carry normalized contract ids
Every interface shall have a provider element and a contract id
of the form `kind::rest`, the kind being http, grpc, topic, queue, data or rpc. The compiler
shall normalize HTTP methods to upper case and path parameters to `{}`. If a
contract id does not parse, then the model is refused naming it.

### Scenario: path-parameters
- Given: an interface with contract `http::get::/api/orders/{orderId}`
- When: the model is compiled
- Then: its contract id is `http::GET::/api/orders/{}`

## Requirement: zones — Zones are inherited unless changed
An element shall be in its parent's zones unless it adds zones, excludes some of
them, or replaces them all. A zone has a free-word kind. If an element excludes
a zone it would not be in, then the model is refused naming both.

### Scenario: inherit-add-exclude
- Given: domain `payments` in zone `internal`, `payments-api` adding `pci`, `payments-ui` excluding `internal` and adding `dmz`
- When: the model is compiled
- Then: `payments-api` is in `internal` and `pci`; `payments-ui` is in `dmz` only

### Scenario: replace
- Given: `payments` in `internal` and `pci`, and `payments-batch` replacing its zones with `batch`
- When: the model is compiled
- Then: `payments-batch` is in `batch` only

## Requirement: environments — Environments bind, differ in zones and in content
The model shall let each environment give values to the variables relations
bind through, add or exclude zones per element, and have only some elements:
an element that names environments exists only in those. Secret values are
never stored, only the variable's name.

### Scenario: two-environments
- Given: `checkout-charges-card` binding through `PAYMENTS_URL`, set to a stub's address in test and to the production address in production, and `payments-api` adding `dmz` in production only
- When: the model is compiled
- Then: the relation resolves to a different address per environment, and `payments-api` is in `dmz` in production and not in test

### Scenario: element-in-one-environment
- Given: `payments-stub` naming only the environment test
- When: the model is compiled
- Then: `payments-stub` exists in test and not in production

## Requirement: states — Architecture states form one chain
The model shall let states be declared, each after at most one other, forming
one chain from a first state; a model with none has the single state as-is. An
element or relation may exist since a state and until a state (exclusive). If
the states branch, cycle or have no first state, then the model is refused.

### Scenario: as-is-and-to-be
- Given: states as-is and to-be, `legacy-billing` until to-be and `billing-api` since to-be
- When: the model is compiled
- Then: in as-is `legacy-billing` exists and `billing-api` does not; in to-be the reverse

### Scenario: branching-states
- Given: states `target-a` and `target-b` both after as-is
- When: the model is loaded
- Then: loading fails naming the two states that follow the same one

## Requirement: evidence — Elements and relations may name their evidence
An element, an interface and a relation may list the files, optionally with a
line, from which it was written; the compiled model keeps them as given.

### Scenario: evidence-kept
- Given: `checkout-cart` with evidence `services/checkout/src/cart/index.ts` line 1
- When: the model is compiled
- Then: the compiled element carries that file and line

## Quality requirements
- Performance: loading and compiling a model of 10 000 elements takes under
  five seconds on a developer's laptop.
- Reliability and recovery: loading has no side effects; a refused model leaves
  nothing behind.
- Security and data protection: secret values are never read or stored; only
  variable names.
- Data: the format has a `version`; an unknown version is refused.
- Usability: every error names the file and the line.
- Compatibility and operation: not applicable (a library).

## Context
Decisions 0002 (YAML in git), 0005 (layers), 0006 (bindings by variable
names), 0014 (format principles), 0015 (states). Rules and flows are not part
of the format yet.

## Coverage limits
Only models written in this format; there is no import from other formats.
