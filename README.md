# Refract

Refract is a byte-transparent, credential-isolating reverse proxy and recorder for Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses. It forwards fixed provider routes without translating protocols, stores a permanent provider-neutral context DAG, and keeps exact raw bodies only in a separate short-retention database.

The project is greenfield. It has no predecessor schema, compatibility layer, or import path.

## Status

Phase 0 workspace initialization. The forwarding data plane is not implemented yet.

## Development

Requires Node.js 22 or newer.

```bash
npm ci
npm run check
```

See [ADR 0001](docs/adr/0001-greenfield-boundaries.md) for the load-bearing boundaries.
