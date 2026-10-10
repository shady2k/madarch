# Reading comfort

## Findings

What the research on long-session reading comes down to:

- Line length is the biggest single lever: roughly 45 to 75 characters
  per line, and reader comfort drops quickly outside that band
- Font size matters less than measure and leading; going one size up
  with a good measure beats shrinking type to fit
- Text set slightly loose reads as calm; tight setting reads as dense
- Layout shift while a page settles is felt as untrustworthiness,
  independent of how the settled page looks

As one of the usability write-ups puts it: "readers do not complain
about typography; they simply read less."

## What we will do

- Fix a measure for the reading view and never let content stretch it
- Prefer generous leading over small type
- Reserve space for anything that loads late, so nothing reflows

## Related

The decision this feeds: [Owning the reader](../decisions/0001-own-the-reader.md).
