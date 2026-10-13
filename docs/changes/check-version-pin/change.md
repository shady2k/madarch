# The serve-time check test reads the installed check's version

Change: check-version-pin
Base: 6d5bd3520bd160133b26b44e6b0fffe471eeda4d
Tasks: madarch-dc2h
Kind: no-behavior

## Intent
The setup update to shady2k-skills 0.45.0 replaced the installed product check, and a test of the wiki's serve-time check pinned the version it reports as the literal 0.44.0, so the full suite went red on main. The test now reads the version from the check script the checkout installs, which is what the wiki reports.

Stories:
- As the maintainer updating the set's installation, the test suite stays green without editing a test for every new check version.

## Rationale
A test fix: the wiki already reports the installed check's version; the test asserted one particular version instead of the installed one.

## Out of scope
- The wiki app's own fixtures, which name a version as sample data.

## Preserved contracts
- product-wiki/front-matter: the served page still carries the check's run and version, now asserted against the installed script

## Coverage
- product-wiki/front-matter: test
