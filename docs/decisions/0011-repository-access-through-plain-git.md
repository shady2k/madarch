# 0011. Repositories are read through plain git with read-only credentials

Status: accepted
Date: 2026-09-24

## Context and problem
Reading a repository is the same on every host; webhooks and pull-request APIs
differ per host.

## Decision
The server clones and fetches with plain git over HTTPS tokens or SSH keys,
read-only. The graph's repository list refers to credentials by name; values
live in the server's environment or secret files, never in git. Host-specific
code is limited to webhook authenticity (GitHub HMAC signature, GitLab secret
token) in the first milestone; pull-request comments and statuses are later
adapters with their own, optional, write credential.

## Consequences
- The server holds read access to every listed repository: a valuable target.
  Least privilege and uploading facts from CI (0007) are the mitigations.
- Revisit when a host needs more than authenticity checks for webhooks.
