# Durable canonical DAG

Canonical items use a versioned provider-neutral union and deterministic JSON. Item IDs are SHA-256 over `refract:item:v1\\0` plus canonical UTF-8 bytes. Payloads are zstd-compressed only after hashing; an existing ID is decompressed and byte-compared before reuse.

Context nodes are immutable `(parent, item)` links. Their IDs are SHA-256 over `refract:node:v1\\0`, the parent ID or 32 zero bytes, and the item ID. Folding ordered items reuses exact prefixes and creates only changed suffixes. A request stores the input tail presented to the model and the output tail after its result. Provider object references may select an existing output tail as explicit ancestry.

The durable SQLite database is physically independent from raw capture. One serialized transaction writes items, nodes, request tails, occurrences, and provider-object lookup. Transcript reconstruction walks only durable nodes and remains valid if `raw.db` is deleted. Active transport rows recover to `aborted_by_restart`; no success is fabricated.
