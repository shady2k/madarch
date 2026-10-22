# 0031. madarch's own wiki opens first; one page serves every role and level; identity is git locally and OIDC on a server

Status: accepted
Date: 2026-10-23

Amends 0029: its reader levels gain layers, glossaries and roles inside one page, and its remote
(the server) gains an identity. Builds on 0021 (the product repository contract) and 0023 (people's
writing is in git).

## Context and problem

A fresh install opens an empty wiki. The wiki must also serve a product manager who has never heard
the word "manifest" and an experienced product engineer, and it must say who wrote an edit, an
answer or a correction. The owner's words, 2026-10-23:

- On the first page: «Здесь должна быть ссылка на документацию madarch. Мы же с тобой
  договаривались, что у нас будет вики самого madarch. И вот если пользователь только запустил, у
  него еще ничего нет, и чтобы не показывать пустую страницу открывать по умолчанию вики самого
  madarch?»
- On the help link: «Ссылка на документацию madarch на каждой странице пожалуй делать не нужно, Давай
  вынесем в header рядом с глобусом иконку с вопросом.»
- On readers: «Эта вики должна содержать сведения для разных ролей и уровня знаний, как для
  какого-нибудь продакта, который вообще не слышал слово "манифест", так и для опытного продуктового
  инженера.» And, agreeing: «отдельная версия страницы - это плохая практика».
- On glossaries: «Ну да, ведь у нас же еще должен быть глоссарий! И не только наш madarch, но и
  глосарий каждого продукта.»
- On roles: «роль нужно будет брать из профиля пользователя».
- On local identity he answered «Да» to the reasoning that a local login protects nothing, because
  the person can commit to git directly, and that it breaks "download and run".

## Decision

**madarch's own wiki.** madarch's documentation is a product like any other: the madarch product
repository, built by the same engine and format, with every statement grounded. With no product yet,
the root opens madarch's wiki instead of an empty page. madarch is always in the product selector.
A «?» icon in the top bar, beside the language globe, opens madarch's documentation from any
product. Pages carry no documentation link of their own.

**One page, in layers; no page versions.** Readers of every level get the same page, ordered from
general to particular, with a plain "in two words" summary first. Every term is a link to the
glossary.

**Glossaries.** Each product has a glossary kind: the terms the agent finds in the product's
documents and code, each grounded, with a plain-language definition, synonyms and the code names it
maps to. An ambiguous term becomes an open question. madarch's own glossary (manifest, kind,
template, ground, statement, fill and the rest) lives in madarch's wiki.

**Roles.** A role (product, analyst, architect, developer, operations, tester, or "everything")
chooses which template blocks are open and what leads the navigation. The manifest declares the
blocks per role.
- Locally, the role is asked once on the first open, can be skipped (default: everything), is kept in
  the user's settings on the machine and can be switched in the top bar.
- With a team server, the default role comes from the user's SSO groups, and the profile can
  override it. For Keycloak this is the groups claim in the token.
- The role is never guessed from behaviour.

**Identity.** One "who is the user" seam, with two implementations now.
- Local: no sign-in. The author is git's `user.name` and `user.email`. Commits are signed with the
  user's own git signing key when one is configured. Every write is marked "local, not verified",
  because git's author is whatever the person set.
- Server: the person signs in from the local madarch with OpenID Connect, the way `gh auth login` and
  `az login` do: the device authorization grant (RFC 8628) or a browser flow. Keycloak or any OIDC
  provider works; GitHub or GitLab suit small teams. The server accepts changes only from a verified
  identity, sets the author from the verified claims, commits as itself (the committer) and signs the
  commit. This is git's author/committer split, as GitHub does for edits made in its web editor.
- A product setting can require a verified identity to open its wiki.
- Every edit, answer and correction records its author and how the author was verified.

## Consequences

- The root of a clean products home opens madarch's wiki, and the «?» icon reaches it from every
  product.
- Manifests gain per-role block lists and a glossary kind. The training repository's glossary page
  lists its terms with grounds, and flags "payment token" as ambiguous.
- Local writes work offline and need no account. An answer written in the wiki is committed with the
  git identity and marked "local, not verified".
- The server half (OIDC sign-in, server commits, the require-verified setting, SSO groups for roles)
  is designed here and left for the server milestone. The identity seam is the one place it plugs in.

## Open

- The exact wording and storage of the "how verified" mark on a written file.
- Which OIDC flow the local madarch tries first, device or browser.
- How the manifest names the per-role blocks.
