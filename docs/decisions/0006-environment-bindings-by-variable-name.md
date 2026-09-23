# 0006. Relations bind to environments through variable names; no secrets

Status: accepted
Date: 2026-09-24

## Context and problem
A service's code reads a topic name, a host or a port from an environment
variable; the value per environment is set by deployment configuration,
often in another repository. Neither alone shows the interaction.

## Decision
A logical relation is environment-independent and names the variable it binds
through (`binding: { env: ORDERS_TOPIC }`). Per-environment bindings (topic
name, host, port, cluster) form a deployment layer, filled by plugins or by
hand. The core resolves the chain variable → value → endpoint → provider per
environment. Secret values are never stored, only references (variable name,
secret path).

## Consequences
- The same logical interaction can map to different topics or hosts per environment.
- Resolution needs deployment facts; without them the chain stops at the variable
  and reports "not enough data".
- Revisit if values commonly arrive through channels that have no variable name
  (service discovery only, for example).
