# Owning the reader

## Context

The reading view is where notes spend most of their life, so its
behaviour is the product's behaviour. We could build on an existing
editor component and inherit a reader, or write our own against plain
Markdown. Building on someone else's component gets us further faster;
owning it means the reading experience never argues with us.

## Decision

We will build our own reader on top of a plain Markdown parser. The
component we ship owns `layout`, `link resolution` and nothing else;
writing stays plain text in any editor.

## Consequences

- We carry the parsing and rendering of the reading view ourselves
- Reading behaviour changes on our schedule, not a dependency's
- Any editor that writes Markdown works; no lock-in on the writing side
- Small bugs in the reader are ours to find and fix

## Tradeoffs

| Choice | What it costs |
| ------ | ------------- |
| Own reader | More code we maintain; slower to the first useful version |
| Reused component | Faster start; reading behaviour we cannot shape |

## Links

- The requirement this serves: [The reading requirement](../requirements/reading.md)
- The wider picture: [From idea to product](../vision.md)
