# Owner fill-path investigation conclusions

Task: madarch-64o5.74. Review: ALX-693; repository-input decision: ALX-694.

## Established failure and count repair

The observed API connection loss was caused by earlyoom killing the PostgreSQL
backend serving the API's `vertexCounts` request, not by a fill-child connection.
The backend reached about 2.5 GiB RSS; PostgreSQL then restarted its other backends.
The later administrator-command FATAL belonged to cleanup, not this API failure.
This establishes the cause of the observed reproduction, not every historical 500.

The SQL generator repeated the full active-existence selector for every kind.
With k kinds and k existence-value tables, that produced quadratic SQL growth.
A copied investigation store held only 78 nodes and 402 entity declarations.
Before repair, 186 count branches generated 3,330,769 bytes and 34,595 UNION ALLs.
The complete old EXPLAIN timed out at both five and ten seconds without a plan.
One old branch took 251.428 ms to plan and 46.879 ms to execute.

The repair groups active vertices by kind in one aggregate, restricted to the
published names. SQL shrank to 20,361 bytes and 185 UNION ALLs inside the single
unchanged existence selector. On the same copied store the full new plan finished
within five seconds: GroupAggregate by en.name, one node-table scan, 143.148 ms
planning and 110.624 ms execution. These are plan measurements, not total RSS.
Temporal, context, source, dispute and merge semantics remain in the selector.
Missing groups still count as zero; no schema migration or deadline change is needed.
Search now also shares one active-vertex set across its kind/text-field branches.
Its matched values, label ranking, distinct totals and evidence exclusions remain.

## Stop hypothesis

The hypothesis that `stop` caused the observed API loss was tested and rejected.
With no daemon, stop preserves an API-held store; losing one backend does not
imply a server shutdown. With a live daemon, stop intentionally shuts down its
server; restarting the daemon or standalone serve opens a working GraphQL reader.
These checks belong in `test/owner-stop.test.ts` and
`test/owner-daemon-stop.test.ts` as regressions, not as an investigation journal.

## Product repository input

Repository input was restored to main's behavior. The Architect decided in
ALX-694 that an engine filter contradicted the product's `exclude:` rule and the
main-line check; this reversal is valid and needs no separate owner decision.
The `git:code.commit/code.author` symptom on 587 files is tracked separately as
madarch-64o5.156. It is not part of this repair.

## Acceptance boundary

The owner-fill-path scenario is not accepted. Its post-count-fix run stopped at
“madarch serve answers”: no address appeared within the unchanged 30-second
wait. It failed before any home/catalogue GraphQL request, fill or two-tree count
acceptance. That run therefore does not establish end-to-end acceptance.
The executor's nine existing baseline failures are separate debt; this work must
not increase their set. Regression and static-check results accompany the repair.
