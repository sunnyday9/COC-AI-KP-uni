# Scale-out staging measurements

## Local million-row run, 2026-11-26

The run started at 09:52:35 UTC on clean revision `dcb2fab914ad776e12a71f27edce17dff83fd863`. One Windows host ran Node 24.14.1, the load generator, six gateways, four room workers and two preparation workers. The host had an AMD Ryzen 7 H 260, 16 logical CPUs and 31.3 GiB RAM. PostgreSQL 16.15 and a private SeaweedFS bucket ran on IPv4 loopback through WSL. PostgreSQL allowed 100 connections. Each application process used the default pool maximum of 10, creating a theoretical aggregate of 120 application connections plus the generator pool. The S3 HEAD round trip was 44.74 ms. Sources, accounts, story bytes and model traffic were synthetic.

Seed 126 generated 1,000,000 metadata rows across 2,200 accounts, including a 250,000-row library. The run targeted 2,000 sockets across 800 two-player rooms, 200 solo rooms and 200 idle connections. The raw setup results show 1,524 successful initial subscriptions or idle joins and 476 failed initial joins. A separate point-in-time count after setup recorded 1,524 open sockets. There were 784 unexpected transport closures during the run, including unsuccessful attempts. The three playable TXT, illustrated DOCX and raster PDF sources were 542, 28,031 and 49,043 bytes. Their derived artifact totals were 20,219, 21,155 and 21,076 bytes respectively.

The generator scheduled a 12-second warmup and a 90-second paced window at 100 actions per second. The paced window offered 9,000 actions, sent 6,922, observed 402 wire acknowledgements and received 748 live completions (8.31/s per offer window). The database ultimately held terminal receipts for 753 paced actions. First responses were 4,317 `storage_unavailable`, 402 pending and 4,281 without an observed response. The deterministic provider recorded 866 calls and 10 explicit rate-limit responses, with p50/p95/p99 service latency of 110/802/3,004 ms. The 20-import burst published 14 revisions. Two of three additional paced imports published.

| Measurement | Observed | Budget result |
| --- | --- | --- |
| Paced echo p95/p99 | 4,978/12,779 ms across 750 samples | Missed |
| Paced Keeper p95/p99 | 7,883/22,719 ms across 748 samples | Missed |
| Catalog page p95/p99 | 3,265/4,159 ms first observed and 2,573/3,293 ms on repeat owner reads. 178 of 1,080 requests failed. | Missed |
| Paced failures | 8,252 of 9,000 offered actions lacked a live completion | Missed |
| 500-action burst | 6 of 500 observed terminal within 30 s, 10 durable terminal by final reconciliation | Missed |
| Acknowledged action integrity | 406 acknowledgements checked, zero missing, pending or mismatched receipts | Passed for observed acknowledgements |
| Event sequence integrity | 821 paired events, zero mismatches, regressions or missing partner events on continuously connected client pairs | Passed for observed events |
| Client reconnect wave | 50 of 800 within 30 s, including the deliberate resume paths. 308 failed outright. Successful p95/p99 were 60,204/60,614 ms. | Missed |
| Gateway drain and rolling restart | 223 of 223 rejoined in 30 s, including 189 playing clients and 34 idle clients. Rejoin p95/p99 1,665/1,669 ms. All 1,800 memberships remained. | Passed locally |
| Room worker interruption | Three of four scripted barriers timed out. One worker died after a staged rule effect. The acknowledged action completed in 3.23 s, advanced ownership epoch 2 to 3, and replayed a completed receipt on another gateway. | Missed |
| Duplicate rule effects | No duplicate action key in committed turns. The older report read an incorrect HP path. The staged-effect final HP requires evidence from the corrected harness. | Unmeasured for final HP |
| Saturation | 98 connections to the fixture database, peak 54 lock waiters and two I/O waiters, with observed storage errors | Contention observed. Full budget unmeasured. |

The reconnect counts above are reconstructed from the raw records in scenario order. In the original report, the socket response overwrote the scenario label on successful playing-room resumes. The client wave produced 256 deltas and 236 snapshots across all response times, with a 2,938-byte maximum snapshot. The gateway rejoined all affected clients before bringing up its replacement.

Across 298 database probe samples, round-trip p95/p99 were 59.57/107.83 ms. The oldest queued or running import reached 34.1 s and the oldest unfinished action observed after a wire acknowledgement reached 89.1 s. Peak queue depths were 31 room commands, 24 rooms with pending turns and eight preparation jobs. Sampled peak RSS was 156.6 MiB for a gateway, 152.7 MiB for a room worker, 657.7 MiB for a preparation worker and 255.4 MiB for the generator. The generator’s event-loop delay p99 was 113.4 ms. PostgreSQL CPU, physical disk latency and enforced process memory ceilings were unavailable. First-observed catalog pages used the existing PostgreSQL cache.

The raw report is `stage126-large-175233.json` in the local run output directory, SHA-256 `e00ae03c782afd2c80681eeebf126fe51c59d93df5bdbca63810ef18ddbb8a3e`.

## Local smoke after recovery instrumentation changes, 2026-11-27

A clean `1f45fe5` run used two gateways, two room workers, one preparation worker, 32 rooms, 64 sockets and 5,000 catalog rows. The 45-second paced window offered 360 actions at 8/s. There were 326 live and durable completions. Echo p95/p99 were 2,185/2,317 ms and Keeper p95/p99 were 2,570/6,516 ms, missing both budgets. All 64 sockets were open at the start. The burst reached 16 of 16 terminal receipts within 30 seconds.

The raw reconnect rows confirm 12 of 12 client-wave resumes, 32 of 32 gateway-drain resumes and two of two worker-failure resumes within 30 seconds. Six client-wave resumes used bounded state and six used deltas. After the acknowledged-action and staged-effect barriers, each worker was killed once. Ownership advanced and the affected actions completed in 6.55 s and 6.06 s, with completed receipts returned through another gateway. The staged effect left 8 HP and one character patch. Among 365 acknowledged actions there were zero lost, pending or mismatched receipts, and there were zero duplicate committed action keys. There were no mismatches or regressions across 567 paired events. The subsequent harness change preserves scenario labels directly.

The raw report is `stage126-resume-smoke-20261127-000338.json` in the local run output directory, SHA-256 `59bb9c73e54a1337d571763944c1c569976a23e0bfd4fa66f5bc3b7892075591`.

The corrected harness also completed a clean `6eb24990fa25e26f758d6cfb4047f7aa9eb7404f` run with the same smoke configuration. It recorded 12/12 client-wave, 32/32 gateway and 2/2 worker resumes within 30 seconds directly. Client-wave p95/p99 were both 253 ms. Gateway p95/p99 were 234/234 ms. Worker action recovery took 6.20 s and 6.48 s. The staged effect again left 8 HP and one patch. Among 361 acknowledged actions there were zero missing, pending or mismatched receipts. There were no mismatches or regressions across 560 paired events. Paced echo p95/p99 were 2,107/2,196 ms and Keeper p95/p99 were 2,478/6,545 ms. The run completed 320 of 360 paced actions and all 16 burst actions within 30 seconds.

The raw report is `stage126-resume-smoke-20261127-000511.json`, SHA-256 `1659ce35d3258b0bc6c93678c728d7edd086437fe7467f2f7e8f9cbc4eb1c2c3`.

## Controlled local rerun, 2026-11-27 China Standard Time

The rerun began at 16:09:36 UTC on 2026-11-26 at clean revision `415c1b12ab8b0010b4c71b029798479bcfaf5050`. It used the same host, seed, fixture counts, replica counts, 12-second warmup and 90-second offered window as the first million-row run. It added batched gateway command-result polling, partitioned mailbox admission, batched room lease renewals and a configured pool maximum of six connections per application process. PostgreSQL retained its 100-connection server limit. SeaweedFS 4.54 returned a 52.48 ms HEAD round trip over loopback. The combined changes and repeated run establish the observed difference between these runs. Individual change effects remain unmeasured.

All 2,000 sockets joined and were open at the first simultaneous count. The paced window offered 9,000 actions, of which 8,827 were sent. There were 4,305 wire acknowledgements, 7,545 live completions (83.83/s per offer window) and 7,561 durable terminal receipts after reconciliation. First responses included 388 `storage_unavailable` and 4,307 without an observed response. All three fixture preparations, three paced imports and 20 burst imports published. The deterministic provider recorded 9,448 calls, 183 simulated rate limits and p50/p95/p99 service latency of 103/800/832 ms.

| Measurement | Observed | Budget result |
| --- | --- | --- |
| Paced echo p95/p99 | 3,014/5,809 ms across 7,555 samples | Missed |
| Paced Keeper p95/p99 | 4,005/6,249 ms across 7,545 samples | Missed |
| Catalog page p95/p99 | 165/280 ms on 390 first-observed owner reads and 96/193 ms on 690 later pages. Zero of 1,080 requests failed. | Passed locally |
| Paced failures | 1,455 of 9,000 offered actions (16.2%) lacked live completion | Missed |
| 500-action burst | 499 of 500 terminal within 30 s (99.8%). Burst echo p95/p99 15,410/22,350 ms and Keeper 15,820/22,594 ms. | Missed |
| Acknowledged action integrity | 5,999 checked, zero missing, pending or mismatched receipts | Passed for observed acknowledgements |
| Rule effects | Zero duplicate committed action keys. Two intentional effects each left 8 HP and one character patch. | Passed for observed effects |
| Event sequence integrity | 14,960 paired events, zero mismatches, regressions or missing partner events on continuously connected client pairs. No inconsistent replay frames. | Passed for observed events |
| Client reconnect wave | 277 of 800 within 30 s. Of 732 successes, 400 used deltas and 332 used snapshots. Success p95/p99 56,645/56,936 ms. There were 68 transport failures. | Missed |
| Gateway drain and restart | 333 of 333 rejoined in 30 s, p95/p99 1,894/1,895 ms. All 1,800 memberships remained. Peak sampled allocation was 403 sockets and 301 subscriptions on a surviving gateway. | Passed locally |
| Room worker interruption | Three of four planned fault barriers fired and three clients rejoined within 30 s. Acknowledged actions recovered in 3.44, 3.41 and 3.23 s with higher epochs and completed receipts replayed on another gateway. The fourth target had lost its socket in the earlier wave and never sent its fault command. | Missed |
| Fault overlap | The gateway drain started 94.90 s into a 90-second paced window because it waited for the earlier wave. All worker interruptions followed it. | Missed |
| Saturation | Peak 64 client backends of 100 available, 30 lock waiters and two I/O waiters. Observed queues cleared after the run. | Partial telemetry. Full budget unmeasured. |

The database probe p95/p99 were 42.71/80.02 ms across 207 samples. Peak simultaneous wait counts included 23 advisory waiters, 14 transaction-ID waiters and 23 lightweight `WALWrite` lock waiters, from separate sample maxima. Gateway processes dominated advisory waits. Each room worker reached five lightweight WAL-write waiters at its individual peak. Queue maxima were 504 pending room commands, 55 rooms with pending turns and five pending preparation jobs. The oldest pending regular command reached 2.70 s, the oldest queued or running import 11.17 s and the oldest unfinished wire-acknowledged action observed by the client 67.70 s. Final samples showed zero in all three queue counts.

Sampled peak RSS was 168.7 MiB for a gateway, 242.5 MiB for a room worker, 676.8 MiB for a preparation worker and 291.4 MiB for the generator. Generator event-loop delay p99 was 46.1 ms. Physical PostgreSQL storage latency, host CPU and enforced process ceilings remain unmeasured.

The gateway result in this run covers client rejoin and membership count. The later overlapping-recovery smoke also checks the membership roster and replacement readiness.

The raw report is `stage126-resume-million-20261127-000934.json`, SHA-256 `6ba7c7a862fe571b514b68eb1236b2ed9f3e027deb6f3782324df54e8e59b445`.

## Local worker targeting smoke, 2026-11-27 China Standard Time

Clean revision `29b892c5fb38fdc276772041b966cc735aa526ad` tested the revised fault target selection with 32 rooms, 64 initially open sockets, 5,000 metadata rows, three gateways, four room workers and one preparation worker. Each application process had a six-connection pool. The 60-second paced window offered 480 actions at 8/s and observed 462 live completions and 463 durable terminal receipts. Paced echo p95/p99 were 537/2,307 ms, missing its budget. Deterministic Keeper p95/p99 were 1,949/4,839 ms, within its budget. All 16 burst actions reached a terminal receipt within 30 seconds.

All four worker fault barriers fired. Kills occurred at 41.01, 50.43, 59.18 and 68.13 seconds into the 60-second paced window, so the last fault fell outside it. In each case ownership advanced and the acknowledged action returned a completed receipt from another gateway after 3.01–3.45 seconds. Both staged effects ended at 8 HP with one patch each. Reconciliation found zero lost, pending or mismatched receipts among 503 acknowledged actions, zero duplicate committed action keys and zero sequence mismatches or regressions across 777 paired events. Within 30 seconds, 12 of 12 client-wave clients, 22 of 22 gateway-drain clients and four of four worker-failure clients resumed.

The raw report is `stage126-resume-faults-20261127-001431.json`, SHA-256 `0546484f5a1aaf4528465b0f8bf8f2bc27160ff7292b59bf0723581737ac331e`.

## Local overlapping-recovery smoke on the final room runtime, 2026-11-27

Clean revision `6175e17b92356b508b95cbc74708baea06b53650` includes the room-governance runtime at `231ab03`. The single-host run started at 03:18:47 UTC with three gateways, two room workers, one preparation worker, six PostgreSQL connections per application pool, 64 initially open sockets and 5,000 metadata rows. PostgreSQL 16.15 and SeaweedFS 4.54 ran through WSL on loopback. The 55-second paced window offered 440 actions at 8/s and observed 437 live completions and 437 durable terminal receipts. The three actions without live completion (0.68%) exceeded the 0.5% budget. Paced echo p95/p99 were 1,179/2,287 ms, missing its budget. Deterministic Keeper p95/p99 were 1,824/2,823 ms, within its budget. All 220 catalog requests and all eight preparations, including three startup fixtures, succeeded. All 16 burst actions reached a terminal receipt within 30 seconds.

The gateway drain began 22.01 seconds into the paced window. Its replacement passed readiness after 3.21 seconds. Room, user and role were unchanged for all 56 membership rows, and 25 paced actions were dispatched on other gateways during the disruption. Both worker fault barriers fired. The workers were killed at 30.62 and 37.14 seconds into the window. Durable terminal receipts were observed at 33.99 and 40.50 seconds, with 26 and 25 unrelated-room dispatches respectively during the disruptions. Both actions advanced ownership epoch and returned completed wire receipts on retry. The client wave resumed 12 of 12 clients within 30 seconds, split evenly between replay and bounded snapshots. The gateway drain resumed 18 of 18 clients, and both worker fault clients resumed within 30 seconds.

Reconciliation found zero missing, pending or mismatched receipts among 477 acknowledged actions, zero duplicate committed action keys, and zero sequence mismatches or regressions among 743 paired events. The staged effect left 8 HP and one character patch. There were zero unexpected transport closures. PostgreSQL peaked at 32 client backends of 100 available and zero sampled lock waiters. The query probe p95/p99 were 12.10/32.70 ms through loopback.

The raw report is `stage126-final-overlap-20261127-111846.json`, SHA-256 `053f147b88f1de99aa8ed9c476040fb08a4867a1db2a5f2f0b044be3ca0711c2`. An earlier attempt at `7df0c3c` stopped during gateway replacement because the harness shadowed its process startup function. Its raw report is `stage126-final-overlap-20261127-111622.json`, SHA-256 `c289f9a6ada0b2a4a02afb31e359d9d890b92fa53e82c5153c03de22cff2d04a`.

## Local three-million-row catalog smoke, 2026-11-27

Clean revision `6175e17b92356b508b95cbc74708baea06b53650` served 480 catalog requests at 12 per second on the same loopback PostgreSQL and object store. The post-run SQL count found 3,000,000 synthetic metadata rows across 5,000 owners, including 250,000 rows for the largest library. The three prepared text, DOCX and OCR fixtures brought the total to 3,000,003 catalog entries.

All catalog requests succeeded. The 161 first-observed owner pages had p95/p99 of 7.31/10.50 ms. The 319 later pages had p95/p99 of 8.00/12.37 ms. The PostgreSQL cache was not flushed. This 40-second smoke had 16 open sockets and eight playing rooms. It sampled metadata paging with light gameplay and kept paced and burst imports disabled.

The raw report is `stage126-final-catalog-20261127-112003.json`, SHA-256 `a186642a19ac3ee2aad05f0a3f2fe0bc7a3f9a404671d9e9277237bf175acecc`. The SQL count is recorded in `stage126-final-catalog-20261127-112003-counts.csv`, SHA-256 `f4f3ee01a2f9431dc7a84646ca9dd043eda9b3f5010f23ba6f7ea6d3b08667f7`.

## Integrated replay and mixed-failure smoke, 2026-11-27

Clean deployment-branch revision `37e1a25f4f18f772c730e1527b61ac5725fe9fbd` repeated the 64-socket, 55-second run. In separate failure budgets, one of 440 paced actions lacked live completion, zero of 220 catalog requests failed, both paced imports completed, and none of the 96 established connections counted during pacing closed unexpectedly. Echo and deterministic Keeper p95/p99 were 1,493/2,460 ms and 2,139/3,147 ms, respectively. Each missed its p95 target.

The gateway and both worker replacements passed readiness within the paced window. The gateway preserved all 56 membership identities and roles. Both workers advanced the target room epoch and returned the completed receipt through a different gateway than the one that acknowledged the action. All 32 targeted reconnects completed within 30 seconds. There were 476 acknowledged actions with zero missing, pending or mismatched receipts, and 747 paired events with zero mismatches. One staged rule effect left 8 HP and one character patch.

The raw report is `stage126-integrated-37e1a25-20261127-113258.json`, SHA-256 `c78e7d23c82213ed10cdffe3784b9e0361f420812581bdaaacdfff98e0bfcb0`.

## Integrated million-row mixed rerun, 2026-11-27

Clean deployment-branch revision `b6c04c6a5f8114763d1941953166cbf0ed488a7b` repeated the controlled 90-second profile at 100 actions per second. The run opened 2,000 sockets across 1,000 playing rooms with six gateways, four room workers, two preparation workers, and 1,000,000 synthetic metadata rows. Each application pool was capped at six connections. The run used the integrated room-governance runtime and the stricter receipt, readiness and failure checks.

| Measurement | Observed | Budget result |
| --- | --- | --- |
| Paced echo p95/p99 | 2,977/6,042 ms | Missed |
| Paced deterministic Keeper p95/p99 | 4,087/6,370 ms | Missed |
| Paced failures and terminal outcomes | 7,588 live completions and 7,601 durable terminal receipts out of 9,000 offered. 1,412 actions lacked live completion. There were 43 unexpected closes across 3,112 established connections counted during pacing. | Missed for actions and socket drops |
| Catalog p95/p99 | 75/139 ms first observed, 35/105 ms for later pages, zero failures in 1,080 requests. | Passed locally |
| Preparation | All three paced imports and all 20 burst imports completed. | Passed for observed imports |
| Action burst | All 500 actions had terminal receipts within 30 seconds. | Passed locally |
| Acknowledged actions and replay | 8,926 acknowledged actions with zero missing, pending or mismatched receipts and zero duplicate committed action keys. 15,032 paired events had no mismatches, regressions or missing partner events on continuously connected pairs. | Passed for observed operations |
| Reconnect wave | 314 of 800 within 30 seconds, with 43 failed attempts. | Missed |
| Gateway rollout | 309 of 309 affected clients rejoined within 30 seconds. The replacement was ready after 12.51 seconds and preserved all 1,800 room, user and role entries. | Passed locally |
| Room worker recovery | All four targeted clients rejoined within 30 seconds. Durable receipts recovered in 3.29–4.38 seconds with advanced ownership epochs. Each retry returned a completed receipt on a different gateway. Both staged effects left 8 HP and one character patch each. | Passed locally |
| Fault overlap | The gateway recovery and first two worker recoveries finished in the paced window with concurrent unrelated actions. The third worker replacement was ready at 93.23 seconds and the last kill occurred at 93.83 seconds. | Missed |

PostgreSQL peaked at 64 of 100 client backends, with up to 22 lock waiters, one I/O waiter and 491 pending room commands. The oldest pending regular room command observed was 2.56 seconds.

The raw report is `stage126-integrated-million-b6c04c6-20261127-113504.json`, SHA-256 `bc94c37a0d4a000f81eae25aa63689dbeaf5260d05ed82a53e591c2ee0e90b74`.

## Sign-off

The reference deployment, its 30-minute mixed test, PostgreSQL host resource telemetry and the separately authorized live BYOK check remain unmeasured. The local runs exercise isolated PostgreSQL and S3 fixtures and cannot establish production capacity. See the [staging plan](scale-out-staging.md) for the target workload and budgets.
