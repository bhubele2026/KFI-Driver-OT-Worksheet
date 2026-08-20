# CLAUDE.md

Working notes for this repo live in [`replit.md`](replit.md); subsystem docs are in
[`docs/`](docs/) (extraction, Zenople export, auth, week cutover).

**Integration contract: `~/projects/KFI-Financial-Dashboard/INTEGRATION.md`.** The OT
Worksheet owns Connecteam and the Zenople punch *export*. Reporting data belongs in the
warehouse — this app does not yet read it (`WAREHOUSE_DATABASE_URL` unset), which is
recorded as debt there. Read the contract before adding any integration or credential.
