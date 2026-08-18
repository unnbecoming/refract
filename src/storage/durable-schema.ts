export const DURABLE_SCHEMA_VERSION = '1';

export const DURABLE_SCHEMA = `
CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE items (
  id BLOB PRIMARY KEY CHECK (length(id) = 32),
  schema_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_codec TEXT NOT NULL CHECK (payload_codec = 'zstd'),
  payload BLOB NOT NULL,
  canonical_bytes INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX items_kind_idx ON items(kind);
CREATE TABLE context_nodes (
  id BLOB PRIMARY KEY CHECK (length(id) = 32),
  parent_id BLOB REFERENCES context_nodes(id),
  item_id BLOB NOT NULL REFERENCES items(id),
  depth INTEGER NOT NULL CHECK (depth > 0),
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX context_nodes_parent_idx ON context_nodes(parent_id);
CREATE INDEX context_nodes_item_idx ON context_nodes(item_id);
CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  provider TEXT NOT NULL,
  api_surface TEXT NOT NULL,
  method TEXT NOT NULL,
  path_and_query TEXT NOT NULL,
  state TEXT NOT NULL,
  streaming_requested INTEGER NOT NULL,
  http_status INTEGER,
  model_requested TEXT,
  model_resolved TEXT,
  input_tail_id BLOB REFERENCES context_nodes(id),
  output_tail_id BLOB REFERENCES context_nodes(id),
  parent_request_id TEXT REFERENCES requests(id),
  lineage_source TEXT,
  client_session_id TEXT,
  provider_response_id TEXT,
  previous_response_id TEXT,
  provider_conversation_id TEXT,
  upstream_request_id TEXT,
  ttfb_ms INTEGER,
  total_ms INTEGER,
  stream_ms INTEGER,
  request_bytes INTEGER NOT NULL DEFAULT 0,
  response_bytes INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_input_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER,
  usage_json_zstd BLOB,
  estimated_cost_microusd INTEGER,
  pricing_revision TEXT,
  parse_status TEXT NOT NULL DEFAULT 'pending',
  parse_error_code TEXT,
  parse_error_message TEXT,
  raw_capture_state TEXT NOT NULL DEFAULT 'pending',
  error_kind TEXT,
  error_message TEXT
);
CREATE INDEX requests_started_idx ON requests(started_at_ms DESC, id DESC);
CREATE INDEX requests_provider_idx ON requests(provider, started_at_ms DESC);
CREATE INDEX requests_input_tail_idx ON requests(input_tail_id);
CREATE INDEX requests_output_tail_idx ON requests(output_tail_id);
CREATE INDEX requests_parent_idx ON requests(parent_request_id);
CREATE UNIQUE INDEX requests_provider_response_idx ON requests(provider, provider_response_id) WHERE provider_response_id IS NOT NULL;
CREATE TABLE request_item_occurrences (
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  phase TEXT NOT NULL CHECK (phase IN ('input', 'output')),
  ordinal INTEGER NOT NULL,
  node_id BLOB NOT NULL REFERENCES context_nodes(id),
  provider_type TEXT,
  provider_item_id TEXT,
  provider_metadata_zstd BLOB,
  PRIMARY KEY (request_id, phase, ordinal)
);
CREATE INDEX request_item_node_idx ON request_item_occurrences(node_id);
CREATE TABLE provider_objects (
  provider TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  output_tail_id BLOB REFERENCES context_nodes(id),
  PRIMARY KEY (provider, object_type, object_id)
);
`;
