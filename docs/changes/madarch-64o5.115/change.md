# Person, Role and Permission are catalogue kinds, and access is role-based

Change: madarch-64o5.115
Base: 1460a3b7dfeb14756a5cda0c017eab599b2837da
Tasks: madarch-64o5.115, madarch-64o5.109
Kind: no-behavior

## Intent
The owner's words of 2026-11-15: «мы же потом конкретным пользователям будем роли назначать — как раз
ролевой доступ таким образом и появится». The catalogue now holds «Человек» (person), «Роль» (role),
«Право» (permission) and «Роль доступа» (access role): a person holds roles, a role grants permissions and
has access roles, and a use case's or a process step's actor is the same «Роль» entity a reader reads the
product with.

## Out of scope
- Sign-in: the server milestone creates people from an identity provider and assigns their roles.
- The permission check point in the write path and the action routes, which this change settles in the
  catalogue and another task wires.
- Filling the access kinds on a product; the catalogue declares them.

## Rationale
The catalogue had a business role, a user role, an actor and a user as four kinds with no fields and no
key, and a kind's audience was a list of free words. The owner's model — a concrete person, the role they
play, what that role may do — is one role kind (ArchiMate's and C4's actor, RBAC's permission set kept
apart as the access role), one person kind, and permissions; and the audience of a kind names the very
role entities a person holds, so a problem escalated to «a role» and the reader a page is written for are
the same thing.

## Changes to requirements
None. The change realizes the existing `product-wiki` catalog requirement — the roles and permissions are
catalogue kinds like the rest — and leaves the server's identity requirement as it stands.

## Preserved contracts
- product-wiki/catalog: every kind still declares its audience as the names of declared roles, now the natural keys of «Роль» entities, and the catalogue check still refuses an audience naming a role the manifest does not declare
- server/identities: a source still keeps one stable server-assigned id through a rename, and the access kinds name a role by its key rather than an identity

## Coverage
- product-wiki/catalog: static test
- server/identities: static test

## Where it is seen
Kind: command
Place: `bun run check:catalog` and the catalogue page of a product made with `madarch init --template everything`

1. Run `bun run check:catalog`: it reads «Человек», «Роль», «Право» and «Роль доступа» as kinds with fields, keys and relations, and no finding.
2. Read the catalogue page: «Роль» stands beside «Человек» and «Право», and its relations read «исполняет», «даёт» and «имеет роль доступа».
3. Read any kind's declaration: its audience names declared roles, and those names are the keys of «Роль» entities.

## Blocking questions
None.

## Design and decisions
One role kind absorbs the business role, the user role and the actor: user, administrator, operations,
tester, product, analyst, architect and developer are its entities, and they are the roles a reader reads
the product as. «Человек» is the concrete person — the owner locally, a commit author once the server signs
people in — related to a role by «исполняет» (`holds`). «Право» is one action with a key and the scope it
reaches; «Роль» grants it (`grants`). «Роль доступа» stays its own kind, the permission set a system
checks, which a role has (`hasAccessRole`). Every action of the product will declare the permission it
needs; locally the one owner holds all of them.

## Acceptance evidence
Static: `bun run check` passed with the catalogue branch's merge.
Test: `test/catalogue-starter-kinds.test.ts` reads «Человек», «Роль», «Право» and «Роль доступа» on a
starter product's catalogue page with their Russian labels; the catalogue reader refuses an audience naming
an undeclared role.
Mutation: not made; filed per the stage rule.
Review: pending; this record is for the review.

## DONE WHEN
The catalogue holds person, role, permission and access role with fields, keys and relations; a person holds
roles and a role grants permissions; and a kind's audience names declared role entities.
