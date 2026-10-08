# 0018. The wiki is madarch's own thin app over its server, not an existing wiki engine

Status: accepted
Date: 2026-10-09

## Context and problem
Decision 0017 makes the wiki the product's source of truth, kept as Markdown in
git, written by people and agents through one path that checks a document's
form before it commits, with comments in git, a chat whose agent applies a
change at once, computed pages over the LadybugDB graph and the same program
locally and centrally. Something has to show the pages and take the edits.

## Considered options
1. A git-native wiki (Gollum, OtterWiki, the Gitea/Forgejo wiki).
2. A rich wiki with git sync (Wiki.js, Outline, Docmost, BookStack, XWiki).
3. A git-based CMS editor (Decap, Sveltia, TinaCMS, Keystatic).
4. The static site engines madarch already uses (Starlight, Zensical), with
   editing added as islands.
5. madarch's own thin single-page app, built to static files and served by the
   madarch server, which holds every rule and every write.

## Decision
Option 5, decided by the owner on 2026-10-09 after the research of that day
(its report kept with madarch-q67).

- None of options 1–3 meets 0017 together: the git-native wikis have no
  pre-write check, no comments and another runtime; the rich wikis make their
  own database authoritative (Wiki.js's git pull overwrites the wiki;
  Outline is under the Business Source License); the CMS editors check fields
  only in the browser, keep no comments and offer no agent path.
- Option 4 builds the whole site ahead of time, so a change made in the chat
  would wait for a rebuild; Starlight's git support is a page's last-updated
  time and a link to the forge's editor. Starlight and Zensical stay as the
  read-only export madarch already builds.
- The app is static files (React, built by Vite) that read pages and views
  from madarch's API, so an edit shows at once. Off the shelf: CodeMirror 6 as
  the editor (it keeps the bytes typed; a visual mode may come later as a
  deliberate reformat), remark for Markdown, Mermaid, MiniSearch for search.
  The diagram tabs stay: LikeC4 (interactive, itself React), Mermaid and
  archify, now recomputed after every change.
- The server keeps the truth and the rules: the write path (check, write the
  bytes as given, commit as the author, one writer per repository), the graph,
  computed pages and views, comments in git, the chat's agent, the API and MCP.

## Consequences
- madarch builds and maintains a front end; its pages, editor, chat panel and
  comments are its own work.
- Sign-in, single sign-on and roles (madarch-toc) are needed before the
  central mode is used by a team; the local mode for one person starts
  without them.
- A git author is text, not proof: who made an edit is established by
  madarch's sign-in and the server's signature on its commits.
- Revisit if several people need to edit one page at the same moment, which
  would call for a live editing layer (a CRDT such as Yjs) in front of git.
