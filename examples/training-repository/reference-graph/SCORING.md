# Which names this reference asks to be scored on

One row per node kind and relation the reference uses, and `code.references`,
which it does not state. `recall: no` prints `n/a` for that name's recall;
`scored: no` keeps both sides of the name out of every count, because the
reference does not state it or the two sides mean different facts there. A name
scored `yes` is a name this reference stands behind: a `no` here is a decision,
not a gap, and a `yes` that the reference could not defend would make the score
a lie.

| name | recall | scored | why |
| --- | --- | --- | --- |
| `code.author` | yes | yes | |
| `code.broker` | yes | yes | |
| `code.channel` | yes | yes | |
| `code.ci-job` | yes | yes | |
| `code.ci-workflow` | yes | yes | |
| `code.column` | yes | yes | |
| `code.commit` | yes | yes | |
| `code.compose-service` | yes | yes | |
| `code.contract` | yes | yes | |
| `code.cycle` | yes | yes | |
| `code.database` | yes | yes | |
| `code.debt` | yes | yes | |
| `code.dependency` | yes | yes | |
| `code.dockerfile` | yes | yes | |
| `code.document` | yes | yes | |
| `code.document-section` | yes | yes | |
| `code.entry-point` | yes | yes | |
| `code.env-definition` | yes | yes | |
| `code.env-var` | yes | yes | |
| `code.field` | yes | yes | |
| `code.file` | yes | yes | |
| `code.health-endpoint` | yes | yes | |
| `code.healthcheck` | yes | yes | |
| `code.image` | yes | yes | |
| `code.index` | yes | yes | |
| `code.input` | yes | yes | |
| `code.k8s-deployment` | yes | yes | |
| `code.k8s-service` | yes | yes | |
| `code.lockfile` | yes | yes | |
| `code.logger` | yes | yes | |
| `code.make-target` | yes | yes | |
| `code.manifest` | yes | yes | |
| `code.message` | yes | yes | |
| `code.metric` | yes | yes | |
| `code.metrics-endpoint` | yes | yes | |
| `code.migration` | yes | yes | |
| `code.module` | yes | yes | |
| `code.newcomer-command` | yes | yes | |
| `code.newcomer-failure` | yes | yes | |
| `code.newcomer-prerequisites` | yes | yes | |
| `code.operation` | yes | yes | |
| `code.package` | yes | yes | |
| `code.port` | yes | yes | |
| `code.probe` | yes | yes | |
| `code.process` | yes | yes | |
| `code.repository` | yes | yes | |
| `code.route` | yes | yes | |
| `code.service` | yes | yes | |
| `code.sql-build` | yes | yes | |
| `code.sql-sink` | yes | yes | |
| `code.state` | yes | yes | |
| `code.state-machine` | yes | yes | |
| `code.symbol` | yes | yes | |
| `code.table` | yes | yes | |
| `code.task` | yes | yes | |
| `code.test-case` | yes | yes | |
| `code.alters` | yes | yes | |
| `code.authored` | yes | yes | |
| `code.backed-by` | yes | yes | |
| `code.belongs-to` | yes | yes | |
| `code.built-by` | yes | yes | |
| `code.calls` | yes | yes | |
| `code.calls-remote` | yes | yes | |
| `code.carries` | yes | yes | |
| `code.consumes` | yes | yes | |
| `code.contains` | yes | yes | |
| `code.contains-job` | yes | yes | |
| `code.covers` | yes | yes | |
| `code.creates` | yes | yes | |
| `code.cycle-member` | yes | yes | |
| `code.declares` | yes | yes | |
| `code.declares-dependency` | yes | yes | |
| `code.defines` | yes | yes | |
| `code.depends-on` | yes | yes | |
| `code.document-link` | yes | yes | |
| `code.exposes` | yes | yes | |
| `code.exposes-metric` | yes | yes | |
| `code.flows-into` | yes | yes | |
| `code.foreign-key` | yes | yes | |
| `code.implements` | yes | yes | |
| `code.imports` | yes | yes | |
| `code.listens-on` | yes | yes | |
| `code.logical-reference` | yes | yes | |
| `code.mentions` | yes | yes | |
| `code.parent` | yes | yes | |
| `code.probes` | yes | yes | |
| `code.publishes` | yes | yes | |
| `code.reads-env` | yes | yes | |
| `code.reads-table` | yes | yes | |
| `code.renamed-to` | yes | yes | |
| `code.resolves` | yes | yes | |
| `code.runs` | yes | yes | |
| `code.served-by` | yes | yes | |
| `code.starts` | yes | yes | |
| `code.targets` | yes | yes | |
| `code.tasks` | yes | yes | |
| `code.tests` | yes | yes | |
| `code.touched` | yes | yes | |
| `code.transitions` | yes | yes | |
| `code.uses-database` | yes | yes | |
| `code.uses-type` | yes | yes | |
| `code.writes-table` | yes | yes | |
| `code.references` | no | no | the reference states calls (`code.calls`) and the types a signature names (`code.uses-type`); a name mention resolved to a symbol is an extraction reading the reference does not state, so the relation is not scored either way |
