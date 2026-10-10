# From idea to product

Fieldnote exists because notes tend to be written in one tool and read
in another, and the reading side is usually the neglected one. We want a
place where a thought is captured in seconds and then read, weeks later,
without friction. This page is the map of the product; everything else
here hangs off it.

> A good note tool does not ask you to organise first. It lets you
> write, and the structure appears when you need it.

## The reading experience

Most of the life of a note is after the moment of writing. We measure
the product by how it feels to come back: the text should be calm, the
links should resolve, and nothing should jump under your cursor. The
requirements page describes what we hold ourselves to:

- [The reading requirement](requirements/reading.md) - the scenario that
  defines "reads well"

### Why typography first

Comfort over a long session is mostly typography and spacing. We read
the research and wrote down what we will and will not do about it:
[Research: typography](research/typography.md).

## What we cover

The product keeps a deliberately small scope:

- Plain Markdown files, readable by any editor
- A reading view that is quiet and uncluttered
- Links between notes that survive renames
- A small set of decisions, written down where they can be argued with

## One decision, in brief

We chose to build our own reading view instead of reusing an existing
editor component. The reasoning and the tradeoffs live in
[Deciding to write our own reader](decisions/0001-own-the-reader.md).
The short version: the reader is the product, and we want to own it.

## How a note becomes a page

A note earns structure when it is stable enough. The path looks like
this:

1. Capture the thought in plain text, without deciding what it is yet
2. Revisit it; if it keeps coming back, give it a heading and a home
3. When it states something we will honour, promote it to a requirement
   or a decision and link it from here

## Reading the state of a note

Notes carry a short status line so a reader knows how far along they
are. It is one line of plain text at the top:

```json
{
  "title": "The reading experience",
  "status": "settled",
  "open_questions": 2
}
```

`status` is one of `captured`, `revisited` or `settled`. Nothing
becomes a requirement before it is `settled`.

## The state of the pages

| Page | Kind | Where it stands |
| --- | --- | --- |
| [The reading requirement](requirements/reading.md) | Requirement | Scenario written, 2 questions open |
| [Owning the reader](decisions/0001-own-the-reader.md) | Decision | Settled; consequences accepted |
| [Reading comfort](research/typography.md) | Research | Findings recorded |

## Where we still owe work

- [ ] Decide how links behave when a note is renamed
- [ ] Test the reading view on a slow afternoon, not just a fresh one
- [x] Write down the typography findings
