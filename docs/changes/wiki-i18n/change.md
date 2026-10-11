# The wiki chrome is available in Russian and English

Change: wiki-i18n
Base: 58fc5c0a65ad66176173d8049da3d65198e62879
Tasks: madarch-iuc.13
Kind: behavior

## Intent
The owner asked madarch-iuc.13 to add Russian and English to the product wiki app, with a reader-visible language choice, remembered preference, browser-language default and locale-aware counts and dates. Product-owned page content stays in its authored language. The same work supplies the owner-requested Russian chrome pair and an English pair without changing the owner's browser preference.

## Out of scope
Translating product documents, adding languages beyond English and Russian, translating the mockup, and changing the browser's language or saved preference without the reader's choice.

## Rationale
The local wiki serves product readers whose chrome and content can be in different languages. A switch lets each reader choose the chrome without changing product documents or system settings.

## Preserved contracts
- product-wiki/pages: test
- product-wiki/shell: test, browser-walk
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test

## Coverage
- product-wiki/pages: test
- product-wiki/shell: test, browser-walk
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
- product-wiki/internationalization: static, test, mutation, review, browser-walk
