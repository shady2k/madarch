# A shared browser lookup for wiki scripts and tests

Change: madarch-k5po
Base: 9bb85e5ae2c98c88ef33c1a0acdcea2adf3c90e7
Tasks: madarch-k5po
Kind: no-behavior

## Intent
Remove machine-specific browser paths from the wiki screenshot script and real-browser tests. Resolve an explicitly configured `CHROME` first, then Puppeteer's downloaded browser, then a browser on `PATH`. Keep the real-browser checks usable across clean installs and state clearly when their opt-in run is skipped.

## Out of scope
Bundling a browser into madarch, changing product behavior, or enabling the opt-in E2E suite in every CI run.

## Changes to requirements
None. This is a development-script and test-environment change; the wiki's product requirements do not change.

## Rationale
The browser is a test and screenshot dependency, not part of the shipped product. A downloaded browser makes clean development installs and CI independent of a developer's local browser location. The opt-in E2E condition remains unchanged and is now printed when the suite is skipped.

## Preserved contracts
- product-wiki/app: this change affects only development tooling and test browser selection; the shipped app still builds from `wiki/app` and serves as before.

## Coverage
- product-wiki/app: test

## Blocking questions
None.

## Design and decisions
One resolver in `scripts/chromium.ts` is shared by all browser consumers. The root dev dependency is Puppeteer rather than `puppeteer-core`, and its install script is trusted so Bun can install Puppeteer's browser on clean installs. `CHROME` is the explicit override. The opt-in real-browser suites still require `MADARCH_WIKI_E2E=1` and a built `wiki/app`; without that flag each suite prints the exact enabling condition.

## Acceptance evidence
Pending integration acceptance. Local checks, app build, the real-browser run with explicit `CHROME`, and independent review are recorded in the worker report. A frozen root install leaves Puppeteer's browser executable resolvable; this host could not launch that downloaded browser because `libglib-2.0.so.0` is unavailable. The mutation run remains with the integrator under the worker rules.

## DONE WHEN
Every script and test that launches Chromium uses the shared resolver; no path tied to one machine remains in `src`, `scripts`, `test`, `wiki/app` or `.github`; missing-browser errors explain how to provide one; the resolver and opt-in real-browser tests pass with an explicit browser, and a clean dependency install provides Puppeteer's browser.
