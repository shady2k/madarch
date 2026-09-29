# receipts

A small archiver for scanned paper receipts. The accounts clerk scans
paper receipts into the `inbox/` folder; receipts imports every PDF it
finds there and keeps the receipts so they can be looked up again by id.

## Running

bun install
bun start
bun run lookup -- receipt-2026-04-12

`bun start` imports every PDF in `inbox/` and exits; `bun run lookup`
prints one receipt from the archive.

See `docs/architecture.md` for how receipts is built.
