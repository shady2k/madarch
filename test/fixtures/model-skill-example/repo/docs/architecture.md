# Architecture

receipts is one Bun process written in TypeScript.

## Importing

The importer reads every PDF the clerk leaves in `inbox/`, parses each
one, and extracts the vendor, the date and the total.

The Cleaner removes duplicate receipts before they reach the archive.

## Storage

Imported receipts go to the archive, from which the lookup command
reads one receipt by id. A receipt is searchable within a minute of
the scan.

## Later

Phase 2 mirrors the archive to S3 for off-site backup.
