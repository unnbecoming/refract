# Raw capture operations

Raw capture defaults to `/var/cache/refract/raw.db`, seven-day retention, 256 KiB zstd blocks, a 64 MiB per-exchange cap, and a bounded 256-write queue. Set `RAW_CAPTURE_ENABLED=false` to disable it.

Key controls:

- `RAW_RETENTION_HOURS`
- `RAW_PRUNE_INTERVAL_SECONDS`
- `RAW_DELETE_BATCH_SIZE`
- `RAW_MAX_DB_BYTES` and lower `RAW_TARGET_DB_BYTES`
- `RAW_MAX_EXCHANGE_BYTES`
- `RAW_BLOCK_BYTES`
- `RAW_MAX_QUEUED_WRITES`
- `SENSITIVE_HEADER_NAMES` as a comma-separated case-insensitive list

Retention is evaluated from immutable creation time. Lowering the retention window makes older rows eligible on the next prune. Emergency pruning deletes oldest exchanges until used pages reach the low-water target. Incremental vacuuming reclaims pages without a blocking full vacuum.

Capture states are `recording`, `complete`, `partial`, `dropped_secret`, `dropped_oversize`, `dropped_pressure`, and `dropped_storage`. Only `complete` means ordered chunks reconstruct the exact observed body. Raw SQLite and zstd work run off the transport event loop; a locked database may leave writes pending but cannot delay forwarding. Startup failure disables raw recording and appears in `/api/v1/transport` while the data plane remains available.

Canonical parsing observes at most `PARSER_MAX_BODY_BYTES` per direction (default 16 MiB). Exceeding it leaves forwarding unchanged and records `parse_status=failed` with `body_limit`. On startup, active durable requests become `aborted_by_restart`. To repair one failed parse while its raw exchange is still complete, build the current release and run `npm run replay -- <request-id>`. Repeating the command replaces occurrences and reuses immutable items/nodes; it does not duplicate the DAG.

## Admin API and UI

The admin listener serves health probes, `/metrics`, `/api/v1/*`, and the bundled SPA. Health and static UI assets contain no recorded data and load without credentials. Metrics and every API route use the configured admin bearer gate. The browser keeps a manually entered token only in React memory; it is never written to local/session storage or a URL. Use TLS at the ingress boundary for any non-loopback exposure.

Versioned inspection routes include bounded cursor-paginated requests, request detail/transcript, context transcript, lineage, statistics, system/storage status, and sequenced SSE invalidation events. Transcripts walk only the permanent durable DAG. Live events are hints with a 512-event replay ring; a cursor gap emits `reset` and clients re-fetch authoritative state.

Raw download is independently disabled by default. Set `RAW_DOWNLOAD_ENABLED=true` only for a trusted admin boundary. `GET /api/v1/raw/:requestId` returns a sanitized manifest; `?direction=request|response` downloads exact bytes and emits a structured access log. A durable request whose raw row was pruned returns `410 raw_expired`, while its transcript, usage, lineage, and parse status remain available.

The UI shell uses a self-only script CSP, self plus inline style geometry for virtualized rows/charts, no objects/frames/base URI, immutable hashed assets, and a no-store HTML shell. Recorded Markdown never enables raw HTML; external links receive safe attributes and unknown canonical values render as collapsed JSON. Request lists are virtualized and transcripts render incrementally, switching to virtualization above 100 visible items.

## Limits, drain, and recovery

`MAX_CONCURRENT_REQUESTS` (128), `MAX_REQUEST_BODY_BYTES` (64 MiB), `MAX_HEADER_BYTES` (32 KiB), and `MAX_CONNECTIONS` (1024) bound exposed transport resources. Saturation returns 503 with `Retry-After: 1`; oversized bodies return 413. Observer/raw queues remain independently bounded. SIGTERM first makes readiness return 503, stops accepts, drains active streams up to `SHUTDOWN_GRACE_MS`, drains canonical observers, checkpoints both WALs, then closes stores. Startup marks interrupted durable rows `aborted_by_restart` and never invents successful completion.

Build before running `npm run doctor`; it validates boot-frozen origins, secret files, paths, listener/auth policy, retention, and limits without printing credential values. Back up the durable PVC with SQLite-aware snapshot/checkpoint handling. Raw capture is disposable and must not drive durable backup retention.

## Container and capacity baseline

The multi-stage image pins Node 22 Bookworm. SQLite native addons compile against the build/runtime glibc; build tools do not enter the final image. Runtime is UID/GID 10001 with a read-only root filesystem. Only `/var/lib/refract`, `/var/cache/refract`, and bounded `/tmp` are writable; provider/admin secrets are read-only files.

`npm run test:soak` is a repeatable guard, not a production capacity promise. On the acceptance runner it forwarded two waves of 12 concurrent 2 MiB responses (48 MiB total) in 825 ms: aggregate 58 MiB/s, p95 TTFB 215 ms, and 117 MiB RSS growth with the second wave remaining within the 64 MiB plateau allowance. Repeated emergency pruning kept an 8 MiB raw cap bounded. Size CPU/memory and raw high/low water marks from representative traffic before deployment; the manifest's requests/limits are conservative starting values.
