# Refract

Refract is a byte-transparent, credential-isolating reverse proxy and recorder for Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses. It forwards fixed provider routes without translating protocols, stores a permanent provider-neutral context DAG, and keeps exact raw bodies only in a separate short-retention database.

The project is greenfield. It has no predecessor schema, compatibility layer, or import path.

## Status

Phase 1 transport is implemented for the three fixed provider paths. It preserves request and response body bytes, query strings, status, duplicate end-to-end headers, content encodings, and streaming order while removing hop-by-hop headers and rewriting authority for fixed configured origins. It includes upstream keep-alive, backpressure, cancellation, timeout handling, in-memory lifecycle state, and separate data/admin listeners.

Provider credential replacement and recording are not implemented yet. Do not place this release in front of real provider credentials.

## Run

```bash
ANTHROPIC_ORIGIN=https://api.anthropic.com \\
OPENAI_ORIGIN=https://api.openai.com \\
npm run build && npm start
```

The data listener defaults to `127.0.0.1:8340`; the admin listener defaults to `127.0.0.1:8341`. A non-loopback `ADMIN_HOST` is rejected unless `ADMIN_TOKEN_FILE` names a boot-read token of at least 24 bytes. Health endpoints are `/health/live` and `/health/ready`; the temporary transport state endpoint is `/api/v1/transport`.

## Development

Requires Node.js 22 or newer.

```bash
npm ci
npm run check
```

See [ADR 0001](docs/adr/0001-greenfield-boundaries.md) for the load-bearing boundaries.
