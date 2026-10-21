# The product check is not run over a registry that is not a regular file

Change: madarch-9uop-product-check
Base: 65d1b549541b44d88532e75e794a0656587a2e19
Tasks: madarch-9uop
Kind: no-behavior

## Intent
A product whose docs/kinds.yaml is a FIFO made the wiki hang: the set's product check opens the registry and blocks. The wiki now names the file as not a regular file and does not run the check over it, as its test already requires. The ci.yml push filter no longer ignores the .shady2k files that madarch or CI executes.

## Out of scope
- Any edit of the installed copies under .shady2k/ (a defect in the check's reading is reported upstream).
- Guarding other non-regular files of a product folder.

## Rationale
The suite that catches this did not run when the setup update merged, because CI ignored every .shady2k path although madarch runs .shady2k/checks.

## Preserved contracts
- product-wiki/front-matter: a served product still has its documents checked and the findings placed on the page.

## Coverage
- product-wiki/front-matter: test

## Where it is seen

Kind: internal
Place: the wiki server reading a product folder and the CI trigger list
Reason: the result is a refusal message of the product check on a registry that is not a regular file and a CI trigger list; nothing a person reaches changes.

1. A person serves a product whose docs/kinds.yaml is not a regular file and sees the wiki answer at once, naming the file.

## Blocking questions
None.

## Design and decisions
runProductCheck stats docs/kinds.yaml before spawning the check; an existing entry that is not a regular file returns a not-run result naming the file and its path. The CI ignore list names only the files madarch and CI never execute.

## Acceptance evidence
Pending.

## DONE WHEN
A FIFO registry returns at once with the file named, the kinds-registry test passes well inside its bound, and a change to .shady2k/checks runs CI.
