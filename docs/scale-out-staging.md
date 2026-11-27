# Scale-out staging acceptance

This plan defines the workload and initial acceptance budgets for [#126](https://github.com/sunnyday9/COC-AI-KP-uni/issues/126). Record the tested commit, hardware, process counts, limits, fixture seed, and raw results with each run. The planning target is 5,000 simultaneous WebSockets across 2,500 playing rooms and a private catalog of 3,000,000 stories.

## Reference deployment

| Role | Replicas | Resources per replica |
| --- | ---: | --- |
| HTTP and WebSocket gateway | 6 | 2 vCPU, 4 GiB RAM |
| Room worker | 5 | 4 vCPU, 8 GiB RAM |
| Story preparation worker | 2 | 4 vCPU, 8 GiB RAM |
| PostgreSQL primary | 1 | 8 vCPU, 32 GiB RAM and SSD-backed storage |
| Load generator | 1 | 8 vCPU, 16 GiB RAM |

Use independent processes, a private S3-compatible bucket, and a shared PostgreSQL primary on the intended deployment network. Record the database and object storage versions, pool settings, service-to-database latency, and object storage latency. Distribute sockets evenly across gateways and place both members of each multiplayer room on different gateways. The 2,000 cross-gateway rooms and 500 solo rooms produce up to 4,500 distinct room subscriptions across gateways. With the current 1,024-room cap per gateway, six replicas leave capacity for one gateway to restart. Use the observed peak on each replica to verify the reconnect placement. Capture throughput, memory, and event-loop delay on the generator to verify it can sustain the offered load.

## Deterministic workload

- Create 2,500 playing rooms, including 2,000 two-player rooms and 500 solo rooms. Maintain 500 additional idle connections for a total of 5,000 sockets. Use an even spread of client schedules so a paced run offers about 100 actions per second, approximately one per room every 25 seconds.
- Seed 3,000,000 catalog records across at least 5,000 owners. Include small libraries and at least one library with 250,000 records. Cycle through first and later keyset pages and separate cold reads from warm reads. Attach actual synthetic sources and coherent prepared artifacts to at least 120 titles, exercised in both story workflows. Include 40 text files, 40 illustrated documents, and 40 PDFs requiring OCR. Record actual source and artifact size distributions and reuse playable fixtures across the active rooms.
- Warm up for five minutes. Run at least 30 minutes of mixed paced play, catalog requests, and two imports per minute. Issue an extra 20 imports within one minute. Use deterministic Keeper delays with expected p50 near 100 ms and p95 near 800 ms, including occasional multi-second calls and explicit rate limits on one provider origin. Count setup, admission, and recovery requests separately.
- During the mixed run, submit 500 actions in one second. Disconnect and resume at least 1,000 clients. Include both recent cursors and cursors requiring a bounded state response. Restart one gateway and each room worker one at a time. Kill a worker with a known action acknowledged and another with a staged rule effect. Keep paced traffic on the other rooms throughout.
- Record initial responses and terminal outcomes by stable action ID. After recovery, resubmit each interrupted ID through another gateway. Reconcile accepted IDs against durable receipts and committed rule effects. Compare live event sequences on both multiplayer clients.

## Initial acceptance budgets

| Measurement | Budget |
| --- | --- |
| Paced player echo | p95 ≤ 500 ms, p99 ≤ 1.5 s |
| Paced Keeper completion with the deterministic provider | p95 ≤ 2 s, p99 ≤ 5 s |
| Catalog metadata page at limit 25 | p95 ≤ 200 ms, p99 ≤ 750 ms, cold reads recorded separately |
| Paced unexpected request or operation failure | ≤ 0.5% per operation, including dropped connections and final failures after retry |
| Burst admission | Record immediate overload separately. At least 99.9% of the original actions reach a terminal receipt within 30 s of the burst using bounded retry. |
| Acknowledged actions and committed rule effects | Zero lost acknowledged actions, zero duplicate committed effects, and zero client sequence regressions |
| Recovery | At least 99% of affected clients rejoin within 30 s of each induced failure, and all recoverable acknowledged actions resolve within 60 s. A saved pause is recorded with its cause. |
| Saturation | No OOM or persistent queue growth. Each process stays below 80% of its memory limit after warm-up. Report PostgreSQL connection occupancy, query latency, lock waits, CPU and I/O, and oldest pending action and import age. |

Sample query pressure and process memory through the entire run. Report p95 and p99 separately for paced, burst, reconnect, and recovery windows, with counts and offered versus achieved rate. Record queue wait and provider service latency separately. Count explicit overload and policy pauses by code even if the client later succeeds. A local smaller fixture run can verify the harness before the reference deployment is available.

## Live BYOK check

Use a separately approved staging account, provider, credential, time window, and spending cap. Use two rooms and include a reconnect. Stop after five minutes, 20 completed turns, 50 provider requests, or the approved spending cap, whichever comes first. Record quota responses observed within that window. Record the provider request count, latency, retry or rate-limit counts, and any failures. Store only aggregate measurements and exclude endpoints, credentials, response text, and player data from the report. This check measures the approved provider and account at the tested rate.

## Sign-off

Record each budget as passed, missed, or unmeasured. Attach the migration and rollback rehearsal evidence and the deterministic and live BYOK results. A reference run is pending until staging is provisioned. See the [local measurements and raw report identifiers](scale-out-staging-results.md).

## Running the synthetic load generator

Use Node 24 or later and install the workspace dependencies with `npm ci`. Provision an empty PostgreSQL database and a same-named role matching stage126_<10 lower-case hexadecimal digits>. Provision an empty private S3-compatible bucket named fixture-stage126-<10 lower-case hexadecimal digits>. Supply the PostgreSQL connection URI in `STAGING_DATABASE_URL` and the S3 fixture JSON in STAGING_S3_FIXTURE. The object contains endpoint, region, bucket, forcePathStyle and credentials as used by the shared-story integration test. Supply secrets through the environment without echoing either variable. Both endpoints must use explicit IPv4 loopback addresses and ports. Dispose of the dedicated database, role and bucket after each run.

Run `node e2e/staging-load.mjs`. Set `STAGING_REPORT` to a new file path for the JSON report. The default local profile starts two gateways, two room workers and one preparation worker. `STAGING_PROFILE`=reference selects the workload counts from this plan while keeping the generator and child processes on one host. It exercises the reference workload shape and does not qualify as the reference deployment. Collect the distributed topology and resource-limit evidence separately. With the application's default PostgreSQL pool maximum of 10, provision at least 160 connections for the reference placement or size the pools explicitly, leaving headroom for maintenance.

Individual overrides use the STAGING_ prefix. Useful controls include GATEWAYS, ROOM_WORKERS, PREP_WORKERS, ROOMS, MULTI_ROOMS, IDLE, OWNERS, METADATA, LARGE_LIBRARY, ARTIFACTS_PER_FORMAT, WARMUP_SEC, PACED_SEC, ACTIONS_PER_SEC, CATALOG_PER_SEC, IMPORTS_PER_MINUTE, IMPORT_BURST, BURST, RECONNECT, LEASE_MS, JOIN_CONCURRENCY, PG_POOL_MAX and SEED. The reference profile seeds the first 250,000 metadata records into one account and spreads remaining records across the other accounts. Metadata distinguishes equal timestamps and a mix of owner sizes. Actual prepared fixtures are spread across accounts and assigned to rooms in both workflows. Metadata-only placeholders have no source bytes.

Model responses for gameplay and dossier generation are deterministic fixtures. Gameplay exercises the application's admission queue, retry policy and persisted turn pipeline. Preparation still performs a real upload, parse or OCR, indexing, coverage calculation, artifact publication and shared storage read. DOCX fixtures contain a raster illustration. PDF fixtures have raster pages without a selectable text layer. Recorded import status identifies the preparation stage when a fixture fails. Source and artifact sizes in the reports describe these generated fixtures. They do not model a real-corpus size distribution.

The report retains initial action responses and codes, observed terminal receipt timings, event comparisons, client reconnect latency, replica memory and queue sampling. HTTP catalog samples label the first observation per owner separately from repeat reads. Those labels do not establish a physically cold database cache. The database latency probe includes queue queries and network round-trip. The load report samples total client backend occupancy and groups fixture wait events by replica, wait kind and event. PostgreSQL host CPU, physical storage latency and enforced process ceilings require deployment telemetry. Provider service timings exclude internal retries' waits and worker admission queue waits. The worker metrics carry admission-wait counters separately.

A worker fault is armed at an acknowledged action or after an HP change has been staged. Interruptions use the same action ID and the harness records the replayed receipt on another gateway. The gateway drain uses the runtime's signal handler, moves affected sockets to surviving gateways and records the room subscription peak. The intentional disconnect wave exercises both the recent replay cursor and the bounded snapshot path. Timing and recovery samples, along with any missed fault barrier, are visible in the report.
