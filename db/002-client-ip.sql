-- Apply as the database owner BEFORE deploying the IP-aware logger.
-- Additive and safe to rerun; historical rows retain NULL addresses.
ALTER TABLE request_logging.requests
  ADD COLUMN IF NOT EXISTS client_ip inet,
  ADD COLUMN IF NOT EXISTS client_ip_source text;
