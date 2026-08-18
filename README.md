# Refract

Refract is a byte-transparent, credential-isolating reverse proxy and recorder for Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses. It forwards fixed provider routes without translating protocols, stores a permanent provider-neutral context DAG, and keeps exact raw bodies only in a separate short-retention database.

The project is greenfield. It has no predecessor schema, compatibility layer, or import path.

## Status

Phase 1 transport is implemented for the three fixed provider paths. It preserves request and response body bytes, query strings, status, duplicate end-to-end headers, content encodings, and streaming order while removing hop-by-hop headers and rewriting authority for fixed configured origins. It includes upstream keep-alive, backpressure, cancellation, timeout handling, in-memory lifecycle state, and separate data/admin listeners.

Phase 2 adds proxy-owned provider credentials and bounded raw capture. Caller authorization is stripped, the matched provider key is injected from a boot-read file, and all observation headers are redacted before storage. Exact body chunks live only in a separate short-retention SQLite database; secret-contaminated, oversize, or pressure-limited captures are dropped and labeled without changing forwarded traffic.

Phase 3 adds the permanent provider-neutral context DAG: canonical JSON, domain-separated item/node hashes, zstd item storage with collision guards, immutable prefix reuse and branching, request tails and occurrences, explicit provider-object ancestry, restart recovery, and transcript reconstruction independent of raw capture.

Phase 4 adds incremental SSE decoding and canonical adapters for Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses. Streaming and non-streaming calls feed the same durable DAG without owning transport backpressure. Retained complete raw captures can be reparsed idempotently with `npm run replay -- <request-id>` after a build.

Phase 5 adds the bounded versioned inspection API, Prometheus metrics, sequenced live invalidation events, separately gated raw downloads, and the bundled production UI. The responsive workspace includes live activity, cursor-filtered requests, durable transcripts and lineages, request/raw inspectors, statistics, and storage health. Credentials remain in process memory only; raw bodies are never part of ordinary transcript rendering.

## Run

```bash
ANTHROPIC_ORIGIN=https://api.anthropic.com \\
OPENAI_ORIGIN=https://api.openai.com \\
ANTHROPIC_API_KEY_FILE=/run/secrets/refract/anthropic \\
OPENAI_API_KEY_FILE=/run/secrets/refract/openai \\
DURABLE_DB_PATH=/var/lib/refract/observability.db \
RAW_DB_PATH=/var/cache/refract/raw.db \\
npm run build && npm start
```

The data listener defaults to `127.0.0.1:8340`; the admin listener defaults to `127.0.0.1:8341`. A non-loopback `ADMIN_HOST` is rejected unless `ADMIN_TOKEN_FILE` names a boot-read token of at least 24 bytes. Health endpoints are `/health/live` and `/health/ready`; the temporary transport state endpoint is `/api/v1/transport`.

## Development

Requires Node.js 22 or newer.

```bash
npm ci
npm run check
```

See [ADR 0001](docs/adr/0001-greenfield-boundaries.md) for the load-bearing boundaries, [security](docs/security.md) for credential/data handling, and [raw capture operations](docs/operations.md) for retention and limits.
