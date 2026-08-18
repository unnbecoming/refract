# Security model

Refract is a fixed-origin reverse proxy, not an open forward proxy. The data plane accepts only `POST /v1/messages`, `POST /v1/chat/completions`, and `POST /v1/responses`. Upstream origins and credentials are read once at boot.

Provider credentials must be mounted as read-only files and named by `ANTHROPIC_API_KEY_FILE` and `OPENAI_API_KEY_FILE`. Caller `authorization`, `proxy-authorization`, `x-api-key`, and `api-key` values are removed. Refract injects only the credential for the matched fixed route, after constructing the observation view.

Credential, cookie, and `SENSITIVE_HEADER_NAMES` values are redacted before any raw-storage queue. Known credential values are also scanned across body chunk boundaries. If one appears in a body, forwarding remains byte-exact but the raw exchange is deleted and marked `dropped_secret`. Credential protection outranks exact recording.

Raw bodies may contain other application secrets and are sensitive even after header redaction. They live only in the separate short-retention raw database. Durable canonical storage is not implemented yet.

The admin listener defaults to loopback. A non-loopback bind requires `ADMIN_TOKEN_FILE`; health probes remain unauthenticated. Do not expose the current transport-state API without TLS and an external network boundary.
