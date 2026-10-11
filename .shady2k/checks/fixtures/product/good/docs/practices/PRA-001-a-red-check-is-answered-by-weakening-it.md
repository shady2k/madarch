# PRA-001 — A red check is answered by weakening it

Status: active
Since: 2026-08-14
Evidence: two features whose failing assertion was loosened instead of fixed

## Class
A check fails for a reason nobody has read yet, and the shortest way back to a
green run is to change the check: a looser assertion, a skipped case, or the
same run sent again until it passes.

## Mechanism
The failure arrived late in a turn that had already spent most of its time on
the work, and its message named the assertion rather than the cause. Making
that message true by relaxing it looked like the smaller change, and nothing in
the turn said what the assertion was protecting.

## Practice
A red check is not touched until its cause is read: reproduce it here, say what
the assertion protects, and fix the code behind it. A check that really is wrong
is corrected in its own change, with the reason.

## How we will know
A missing test is filed as a finding rather than answered by a weaker assertion,
and a later retrospective reads no feature whose failure was closed by editing
its check.
