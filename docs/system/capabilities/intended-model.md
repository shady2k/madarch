# Intended model

Capability: intended-model

## Purpose
Reading what people and agents declare the architecture to be from the YAML
files of a repository, refusing anything that cannot be read exactly, and
saying where each problem is: its parts and how they relate, the data entities
that cross between them, and the use cases that run through them as scenarios.

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
data entity, scenario, environment and state shall have an id unique within
its kind across the model, and every step and alternative an id unique within
its scenario, of letters, digits, dots, dashes and underscores, which does not
change when the thing moves or is renamed. If an id repeats, then the loader
shall refuse the model naming both places.

### Scenario: duplicate-element-id
- Given: two elements with the id `orders-api` in different files
- When: the model is loaded
- Then: loading fails with an error naming both files and lines

### Scenario: duplicate-step-id
- Given: a scenario `place-order` with two steps of id `s2`
- When: the model is loaded
- Then: loading fails naming `place-order`, both steps' lines and the id `s2`

## Requirement: references — Every reference resolves
When the model is loaded, the loader shall resolve every reference (an
element's parent, a relation's ends, a refined relation, an interface's
provider, a relation's interface, zones, categories, environments and states,
the entities a transfer carries, a scenario's actor, the relation of each step
and the step an alternative starts at) and refuse any that names nothing,
naming the referring place and the missing id.

### Scenario: step-over-missing-relation
- Given: scenario `place-order` whose step `s4` names the relation `inventory-reserves-stock`, and no relation of that id
- When: the model is loaded
- Then: loading fails naming `place-order`, step `s4`, its file and line, and `inventory-reserves-stock` as not found

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

## Requirement: relation-names — Every relation is named, or warned about
A relation shall have a `name` saying what it does in a few words ("places
orders"). If a relation has no name, then loading shall still succeed and
return a warning naming the relation, its file and line; warnings never refuse
a model, and a model with none returns an empty list of them.

### Scenario: unnamed-relation
- Given: a model whose relation `checkout-calls-orders` has no name, and whose relation `orders-publishes-placed` is named "publishes placed orders"
- When: the model is loaded
- Then: it loads, and the one warning names `checkout-calls-orders` with its file and line

## Requirement: messaging — Publishers and subscribers are marked
A relation through an interface whose contract is of kind topic or queue shall
say how its initiator uses it: `action: send` for one that publishes or sends
to it, `action: receive` for one that subscribes to it or receives from it.
The relation's ends stay as written, from the initiator to what it depends on
(usually the broker that provides the interface), so dependencies are
unchanged. If a relation carries `action` without
naming an interface of kind topic or queue, then the model is refused naming
the relation, its file and line. If a relation through a topic or queue
interface has no `action`, then loading shall still succeed and return a
warning naming the relation, its file and line.

### Scenario: subscriber-marked
- Given: `inventory-reserves-stock` from `inventory-api` to `event-bus` through `topic-order-placed` with `action: receive`
- When: the model is loaded
- Then: it loads with no warning, and the relation still goes from `inventory-api` to `event-bus`

### Scenario: action-without-messaging
- Given: `checkout-calls-orders` through an interface with contract `http::POST::/api/orders` and `action: send`
- When: the model is loaded
- Then: loading fails naming `checkout-calls-orders` with its file and line, saying `action` belongs only to a relation through a topic or queue

### Scenario: messaging-without-action
- Given: `orders-publishes-placed` through `topic-order-placed` with no `action`
- When: the model is loaded
- Then: it loads, and one warning names `orders-publishes-placed` with its file and line

## Requirement: transfers — Data transfers have a direction each
An interaction shall carry any number of data transfers, each with a direction
(forward, from the initiator, or reverse), a confidentiality, and a list of
data categories, a list of the data entities it carries, or both, kept
separate from the confidentiality. A transfer's categories are those it names
and those of the entities it carries, each once. If a transfer names neither
categories nor entities, then the model is refused naming the relation, the
transfer, its file and line.

### Scenario: two-directions
- Given: the interaction `checkout-charges-card` sends payment-card and personal data forward and nothing categorised back
- When: the model is compiled
- Then: the compiled interaction has a forward transfer with categories payment-card and personal, confidentiality confidential, and a reverse transfer with no categories, confidentiality internal

### Scenario: categories-from-entities
- Given: the interaction `auth-publishes-login` whose forward transfer names the category `personal` and the entities `session-id` (category communications-secrecy) and `user-name` (category personal)
- When: the model is compiled
- Then: the compiled transfer names the entities `session-id` and `user-name` and the categories communications-secrecy and personal, each once

### Scenario: transfer-names-nothing
- Given: a transfer of `checkout-calls-orders` with a direction and a confidentiality and neither categories nor entities
- When: the model is loaded
- Then: loading fails naming `checkout-calls-orders`, the transfer, its file and line, saying a transfer names categories, entities or both

## Requirement: entities — Data entities name what crosses, with its classification
The model shall let data entities be declared, each with an id, a name, an
optional description and evidence, and its classification as a list of the
model's data categories (such as personal data, commercial secret,
communications secrecy). An empty list is an answer: the entity is of no
category. If an entity has no `categories` at all, then loading shall still
succeed and return a warning naming the entity, its file and line, saying its
classification is not stated.

### Scenario: entity-classified
- Given: the entity `session-id` named "Session id" with categories communications-secrecy
- When: the model is compiled
- Then: the compiled model holds `session-id` with its name and the category communications-secrecy, and no warning names it

### Scenario: entity-of-no-category
- Given: the entity `order-number` with `categories: []`
- When: the model is loaded
- Then: it loads with no warning naming `order-number`, and the compiled entity has an empty list of categories

### Scenario: classification-not-stated
- Given: the entity `user-name` with no `categories` field
- When: the model is loaded
- Then: it loads, and one warning names `user-name`, its file and line, saying its classification is not stated; the compiled entity has no list of categories

## Requirement: scenarios — Use cases are scenarios over the model's relations
The model shall let scenarios be declared, each describing one use case: an
id, a name, an optional description (its goal and preconditions in prose), an
optional actor (an element), the requirements it realises as a list of ids of
the form `capability/requirement`, and its main flow as an ordered list of
steps. Each step has an id, the relation it runs over (at any level, a
refinement or not) and an optional name of what happens. A scenario may list
alternative flows, each with an id, the main-flow step it starts at, the
condition under which it is taken (`when`, in prose) and its own ordered steps;
an alternative replaces the main flow from that step on. If a requirement id
is not of the form `capability/requirement`, an alternative starts at a step
the main flow does not have, or a scenario or an alternative has no step, then
the model is refused naming the scenario, its file and line.

### Scenario: scenario-compiled
- Given: the scenario `place-order` with actor `customer`, requirement `ordering/place-order`, steps `s1` over `checkout-places-order` and `s2` over `orders-publishes-placed`, and the alternative `card-declined` at `s2` when "the payment is declined" with one step over `checkout-shows-error`
- When: the model is compiled
- Then: the compiled scenario holds its actor, its requirement, its two steps in order with their relations, and the alternative with its start, its condition and its step

### Scenario: alternative-at-unknown-step
- Given: the alternative `card-declined` of `place-order` starting at `s9`, which the main flow does not have
- When: the model is loaded
- Then: loading fails naming `place-order`, `card-declined`, its file and line, and `s9` as not a step of the main flow

### Scenario: malformed-requirement-id
- Given: the scenario `place-order` naming the requirement `place-order` with no capability
- When: the model is loaded
- Then: loading fails naming `place-order`, its file and line, and saying a requirement is named as `capability/requirement`

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

## Requirement: evidence — Evidence names a file at a revision
An element, an interface, a relation and a data entity may list its evidence: each item names
a file by its path from the repository's root, optionally a line or a range of
lines (`line`, and `endLine` not before it), and optionally the commit it was
read at together with the file's git blob id there (`commit` and `blob`, each
40 hexadecimal digits, given both or neither), so the item still identifies
the exact text read after a squash or a rebase removes the commit. The
compiled model keeps every item as given. If an item has `endLine` without
`line` or before it, a `commit` without a `blob` or the reverse, or a commit or
blob that is not 40 hexadecimal digits, then the model is refused naming the
item, its file and line.

### Scenario: evidence-kept
- Given: `checkout-cart` with evidence `services/checkout/src/cart/index.ts` lines 1 to 12 at a commit with the file's blob id there, and `checkout-ui` with evidence `services/checkout/src/ui/index.ts` and nothing else
- When: the model is compiled
- Then: the compiled `checkout-cart` carries that file, lines 1 to 12, that commit and that blob, and `checkout-ui` carries only its file

### Scenario: commit-without-blob
- Given: an evidence item with a commit and no blob
- When: the model is loaded
- Then: loading fails naming the element, the item's file and line, and saying a commit and a blob are given together

### Scenario: range-reversed
- Given: an evidence item with `line: 20` and `endLine: 12`
- When: the model is loaded
- Then: loading fails naming the element, the item's file and line, and saying `endLine` may not come before `line`

## Quality requirements
- Performance: loading and compiling a model of 10 000 elements takes under
  five seconds on a developer's laptop.
- Reliability and recovery: loading has no side effects; a refused model leaves
  nothing behind.
- Security and data protection: secret values are never read or stored; only
  variable names.
- Data: the format has a `version`; an unknown version is refused.
- Usability: every error and every warning names the file and the line.
- Compatibility and operation: not applicable (a library).

## Context
Decisions 0002 (YAML in git), 0005 (layers), 0006 (bindings by variable
names), 0014 (format principles), 0015 (states), 0016 (the product's
knowledge base). Flows are written as scenarios; rules are not part of the
format yet. Whether a requirement a scenario names exists is the model check's
question, since the loader reads only the model's folder.

## Coverage limits
Only models written in this format; there is no import from other formats.
