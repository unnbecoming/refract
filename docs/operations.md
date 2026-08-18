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
