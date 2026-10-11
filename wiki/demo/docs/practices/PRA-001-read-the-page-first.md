# PRA-001 — A reading rule is changed without reading the page first

Status: active
Since: 2026-10-11
Evidence: two sessions where a typography change landed unread

## Class
A change to the reading rules is made from the numbers alone — the token
values, the measure — and the page it lands on is never opened before and
after, so a rule that reads well in the numbers ships reading badly.

## Mechanism
The tokens and the check give quick green answers, and opening the real
page needs a build and a browser; the smaller, faster loop wins the turn.

## Practice
A reading rule changes only with the page read rendered, before and
after, in both themes; the numbers ride behind the reading.

## How we will know
The next change's record names the pages that were read, and no checkpoint
finds a reading defect the tokens said could not happen.
