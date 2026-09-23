# 0010. One Docker image that runs without network access

Status: accepted
Date: 2026-09-24

## Context and problem
Organisations run madarch themselves, often in closed networks that mirror
images into internal registries.

## Decision
One image contains the server, the core and the official plugins. Custom
plugins are added by building on it (`FROM madarch` plus the plugin). No
outbound calls at runtime: no telemetry, no CDN; the UI's assets ship in the
image. Configuration is one file plus environment variables; all data lives on
one volume.

## Consequences
- Updating one plugin means a new image.
- Plugins as separate containers speaking HTTP are a possible second protocol,
  added only on real need.
- A Helm chart comes later.
