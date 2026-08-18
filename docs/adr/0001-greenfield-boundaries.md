# ADR 0001: Greenfield boundaries

Status: accepted

Refract starts from an empty repository and does not consult, copy, import, migrate, or preserve another implementation. There is no compatibility contract, prior schema, dual-write path, deprecated endpoint, or migration shim.

The data plane accepts only three fixed method/path pairs and forwards to boot-frozen configured origins. Body bytes, query strings, status, SSE framing, ordering, and backpressure are transparent. Fixed-origin authority rewriting, provider credential replacement, and hop-by-hop header removal are mandatory exceptions.

Provider credentials belong only to Refract. Known secret values are forbidden at every observation boundary, including unknown canonical payloads. Forwarded bytes are never rewritten to satisfy recording. A raw exchange contaminated by a known secret is dropped and labeled rather than persisted or falsely called exact.

Durable canonical transcripts intentionally preserve semantic request and response content and must be treated as sensitive. Exact raw bodies live in a physically separate disposable SQLite database with bounded retention and growth.

The admin listener defaults to loopback. A non-loopback bind requires an admin token file. Raw download is independently disableable and audited.
