# First contact: madarch explains what to do and where to go

Change: first-contact-cli
Base: 334ef752b7ffa5f8bc1122ff9ae6507bc5dbfcc5
Tasks: madarch-74k4.2.6
Kind: behavior

## Intent
A newcomer running madarch learns what it did, where the product lives, how to open its wiki from the current machine, and what to do next. Short grouped help gives command-specific guidance based on whether the current folder is a product, a Git checkout, or neither. `new`, `init`, `serve` and `list` use readable success output; serving explains SSH tunneling and does not attempt to open a browser on headless or SSH machines. `--host` allows an explicit bind address with a warning for network exposure. The wiki shows accurate linked, cloned, moved and missing repository states with readable spacing. Install scripts finish with the two ways to start a product.

## Out of scope
- The output contract and `--json` for `demo`, `clone`, `bootstrap`, `rename`, `remote`, `repo add` and `upgrade`, including their remaining consumer audit. The coordinator will file this as follow-up work.
- Changing the `version: X` output.
- Publishing or changing a release.

## Changes to requirements
- product-repository/draft (amended): first-contact CLI help, location hints, new/init guidance, serving address and SSH tunnel, headless browser suppression, `--host`, human list output, and the unchanged version line.
- product-wiki/repositories (amended): actual linked, cloned, moved and missing states, localized labels, and readable overview row layout at desktop and phone widths.
- release-binary/installers (amended): the install scripts end with the same `new` and `init` start commands.

## Preserved contracts
- product-repository/manifest: test — manifest identity and repository declarations stay unchanged.
- product-wiki/pages: test — product pages remain the documents and README already served.
- release-binary/version: test — `madarch version` keeps the exact `version: X` output.

## Coverage
- product-repository/draft: test
- product-repository/first-contact: test
- product-repository/manifest: test
- product-wiki/repositories: test, browser-walk
- product-wiki/pages: test
- release-binary/installers: test
- release-binary/version: test

## Blocking questions
None.
