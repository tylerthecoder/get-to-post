CREATE SCHEMA IF NOT EXISTS request_logging;
REVOKE ALL ON SCHEMA request_logging FROM PUBLIC;

CREATE TABLE IF NOT EXISTS request_logging.requests (
  id uuid PRIMARY KEY,
  received_at timestamptz NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  query jsonb NOT NULL,
  headers jsonb NOT NULL,
  url_bytes integer NOT NULL,
  truncated boolean NOT NULL DEFAULT false,
  environment text NOT NULL,
  deployment text
);

CREATE TABLE IF NOT EXISTS request_logging.outcomes (
  request_id uuid PRIMARY KEY REFERENCES request_logging.requests(id),
  finished_at timestamptz NOT NULL,
  http_status integer NOT NULL,
  upstream_status integer,
  error_code text,
  duration_ms integer NOT NULL,
  response_bytes integer NOT NULL
);

CREATE INDEX IF NOT EXISTS requests_received_at_idx ON request_logging.requests (received_at DESC);
REVOKE ALL ON ALL TABLES IN SCHEMA request_logging FROM PUBLIC;

-- No public read policies or app-facing log routes. The setup script grants
-- the runtime role only USAGE on this schema and INSERT on these two tables.
-- A missing outcome leaves the durable request row as evidence of interruption.
