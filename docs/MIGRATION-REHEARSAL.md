# SQLite and private story storage cutover rehearsal

This runbook covers the offline import for [#125](https://github.com/sunnyday9/COC-AI-KP-uni/issues/125). Run it against an isolated PostgreSQL database and a new private bucket. The import covers a single closed SQLite deployment. All gateways, room workers, story workers and other writers for both deployments must be stopped during the import.

## Back up and validate

1. Stop the SQLite application and any local preparation children. Checkpoint SQLite WAL with `PRAGMA wal_checkpoint(TRUNCATE)` and confirm a successful checkpoint, or use SQLite's backup API against the stopped source. Save the database as `ai-kp.db`. Copy the uploads, RAG and dossier directories as one matched checkpoint, preserving filenames and file modification times. Keep an untouched backup for reopening the original deployment and use a working copy for import.
2. Keep both copies in an operator-only location. If the source schema predates the importing application's schema, apply the existing SQLite schema migrations to the working database copy using the matching local application before taking the final import snapshot. Quiesce the local application again and retain the resulting matched snapshot.
3. Supply explicit `DATA_DIR`, `UPLOADS_DIR`, `RAG_DATA_DIR` and `DOSSIER_DATA_DIR` pointing to the working copy. Configure `DEPLOYMENT_MODE=shared-accounts`, the dedicated `DATABASE_URL`, and the same `JWT_SECRET` as the source. Inject the secret and the database and object-store credentials through the deployment's existing secret configuration. Settings ciphertext is copied byte for byte and the import verifies it can be decrypted with that secret.
4. Configure `STORY_S3_BUCKET`, `STORY_S3_REGION` and any endpoint or path-style options as in the shared catalog deployment. Provision enough private temporary disk for staging the original and encoded artifact bytes. The importer keeps one story's bytes in memory while planning, followed by one object at a time during upload and readback. Relational rows and object manifest entries are currently held in memory. Size the offline run from representative backups before scheduling a larger window.
5. From the checkout, run:

   ```sh
   npm run migrate:sqlite --workspace=server -- --offline
   ```

   Compare scoped counts and SHA-256 values with the frozen backup using the operator-only `sqlite_import.reconciliation` JSONB record. The command prints aggregate counts. Keep a private export of the reconciliation row with the backup metadata. The SQL comparison checks the actual row contents, including account identities, membership row order, character bindings, current host, story owner, exact transcript positions, action receipts and pending checkpoints. The object comparison reads back each expected object's bytes. An identical rerun verifies the same result without duplicating rows or changing object bytes. A divergent source, target row set, or existing object fails the run. When an attempt stops before commit, immutable objects can remain in the dedicated bucket. Retry against the same snapshot to reuse those objects, or retire that dedicated target after inspecting it.

### Legacy story treatment

The local room format stores the story ID and owner but has no immutable story pin. Use a matched freeze whose current files are known to be the ones used by ongoing rooms. The importer pins that exact available bundle after checking its index spans, source text, dossier, coverage and reveal anchors with the shared playability validator. Existing valid dossier/gaps UUIDs are retained. Older matching artifacts without revision metadata receive a deterministic pin and inferred legacy quality. Original source bytes and the selected local index, dossier, gaps and annex bytes are checksummed and retained. The published shared bundle has its own manifest. The importer verifies index offsets against the original text before adjusting chunks to the trimmed text used by the dossier and its anchors. The legacy annex is retained for recovery and the shared turn path uses the supported source, index, dossier and gaps.

A source with incomplete preparation remains in the catalog without a playable version. A playing room that cannot be matched to a complete, coherent bundle blocks the import. Restore its matching files or resolve it with the owner before reopening traffic. Preserve the source backup for older local revisions, retired training data and legacy files outside the scoped account catalog. The importer cannot recover a revision already overwritten or deleted from the matched local files. An ambiguous legacy artifact lookup fails rather than selecting one of multiple unregistered candidates.

## Cutover

1. While shared traffic is closed, back up the reconciled PostgreSQL database with `pg_dump -Fc --no-owner --no-privileges` and capture a private bucket checkpoint. Include object keys, sizes, required metadata and SHA-256 values. Keep the database dump and object checkpoint together. Verify their reads and record this as the pre-cutover recovery point.
2. Start the shared application with PostgreSQL, private storage, `STORY_PREPARATION_ENABLED=1`, `ENABLE_SHARED_ROOMS=1` and `ENABLE_ROOM_WORKER_FAILOVER=1`. Confirm health, sign-in with original credentials, access to owned originals, absence of cross-tenant access, archived history paging, and WS reconnection and action outcomes for saved rooms. Switch routing only after verification.
3. Keep SQLite frozen once shared traffic starts. Preserve the exclusive write authority even if the shared app is replaced. Record the new checkpoint after closing admissions, stopping every gateway, room and story worker, and permitting any in-flight durable write to settle. Retain accepted receipts and their current statuses, including pending checkpoints. Take a fresh PostgreSQL dump and a corresponding bucket checkpoint after the stop. Reconcile the latest account, settings, catalog entries, objects and room receipts before choosing the restore point.

## Restore and rollback

- Before accepting shared writes, route back to the frozen local application and its matched SQLite/files checkpoint if the cutover must be abandoned.
- After accepting shared writes, restore the latest quiescent shared checkpoint into a fresh PostgreSQL database and private bucket. Hash every restored object and preserve keys and metadata. Restore the database via `pg_restore --exit-on-error --no-owner --no-privileges`. Keep the original database and bucket available for investigation. Wait for any restored room leases to expire before reopening saved rooms.
- Restart the shared application against the restored authority or use a previously validated shared-compatible application release. Reconcile the latest checkpoint against the restored receipts and catalog. Test account settings, a post-cutover original and its private access, and the same action ID across a WebSocket reconnect before routing traffic. A rollback to the original SQLite application after shared writes would require a separate reverse migration with reconciliation.

## Run the fixture rehearsal

Install the checkout dependencies. Provision two new loopback PostgreSQL databases named with the `aikp_migration_` prefix and two private loopback object buckets whose names contain `migration`. Set `MIGRATION_FIXTURE_DB`, `MIGRATION_RESTORE_DB`, `STORY_S3_BUCKET`, `MIGRATION_RESTORE_BUCKET`, `STORY_S3_ENDPOINT`, `STORY_S3_REGION` and the matching AWS SDK credentials. Put the matching PostgreSQL client utilities on the path. The Windows WSL fixture can instead set `MIGRATION_PG_WSL_ROOT` to the isolated fixture root containing the PostgreSQL 16 client and libraries. Use a network reserved for fixture apps, and reserve the two consecutive HTTP ports starting at `MIGRATION_APP_PORT` (default 19425).

```sh
node --import tsx e2e/migration.rehearsal.mjs
```

The rehearsal creates a disposable local backup, imports twice, checks object integrity and ownership, and exercises the real HTTP and WebSocket paths with deterministic Keeper replies. It records a baseline checkpoint and restores the later matched checkpoint to the second database and bucket after accepting a new account, encrypted setting, private upload and room action. It verifies the restored account and original, full pre-cutover transcript and post-cutover receipt, including deduplication on retry. The run established behavior for this fixture. Capacity for larger imports and provider-dependent preparation on non-text stories still need separate measurement.


### Recorded fixture result

The PostgreSQL 16 and SeaweedFS rehearsal transferred 3 accounts, 1 encrypted settings row, 3 catalog entries, 2 playable pins, 2 rooms, 4 memberships, 2 characters, 132 transcript messages and 3 action receipts. The transferred multiplayer room retained its original story owner, successor host and paused pending action. All 18 object bytes matched their SHA-256 values. Replaying the import kept the same rows and bytes. A same-size corrupt object and a target with post-cutover writes both blocked reimport.

The later checkpoint contained 19 objects. Its restored multiplayer history contained 136 messages. The restored application returned the new account, settings and private upload and returned the same completed receipt when the post-cutover action was retried.
