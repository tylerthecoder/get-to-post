-- Run as the database owner, never as the application. No extensions required.
BEGIN;
CREATE SCHEMA chunk_uploads;
REVOKE ALL ON SCHEMA chunk_uploads FROM PUBLIC;
CREATE TABLE chunk_uploads.budget (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT true,
  minute_start timestamptz NOT NULL DEFAULT '-infinity',
  minute_ops integer NOT NULL DEFAULT 0,
  day_start timestamptz NOT NULL DEFAULT '-infinity',
  day_ops integer NOT NULL DEFAULT 0,
  day_creates integer NOT NULL DEFAULT 0,
  day_bytes integer NOT NULL DEFAULT 0
);
INSERT INTO chunk_uploads.budget DEFAULT VALUES;
CREATE TABLE chunk_uploads.uploads (
  key text PRIMARY KEY CHECK (key ~ '^[a-f0-9]{64}$'),
  request text NOT NULL CHECK (octet_length(request) <= 8192),
  bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 262144),
  parts integer NOT NULL CHECK (parts BETWEEN 1 AND 64),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'claimed', 'done')),
  CHECK (parts = (bytes + 4095) / 4096)
);
CREATE TABLE chunk_uploads.parts (
  upload_key text NOT NULL REFERENCES chunk_uploads.uploads(key) ON DELETE CASCADE,
  index integer NOT NULL CHECK (index BETWEEN 0 AND 63),
  data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 4096),
  PRIMARY KEY (upload_key, index)
);
REVOKE ALL ON ALL TABLES IN SCHEMA chunk_uploads FROM PUBLIC;

-- One lock serializes quotas, capacity, writes, and claims across ALL instances.
-- Return errors (do not raise them) after charging admission, so invalid/replayed
-- operations cannot roll back the rate budget. No caller-controlled SQL/identifiers.
CREATE FUNCTION chunk_uploads.operate(
  action text, token_hash text, request_text text DEFAULT NULL,
  total_bytes integer DEFAULT NULL, total_parts integer DEFAULT NULL,
  body_digest text DEFAULT NULL, part_index integer DEFAULT NULL, part_data bytea DEFAULT NULL, expires_epoch bigint DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '2s'
SET lock_timeout = '100ms'
AS $$
DECLARE
  b chunk_uploads.budget%ROWTYPE;
  u chunk_uploads.uploads%ROWTYPE;
  t timestamptz;
  old_data bytea;
  assembled bytea;
  received integer;
BEGIN
  IF action NOT IN ('create', 'put', 'status', 'claim', 'finish') OR action IS NULL
     OR token_hash IS NULL OR token_hash !~ '^[a-f0-9]{64}$'
     OR octet_length(request_text) > 8192 OR octet_length(part_data) > 4096 THEN
    RETURN jsonb_build_object('error', 'invalid_upload');
  END IF;
  SELECT * INTO b FROM chunk_uploads.budget WHERE id FOR UPDATE;
  IF NOT FOUND OR NOT b.enabled THEN RETURN jsonb_build_object('error', 'uploads_disabled'); END IF;
  t := clock_timestamp();
  -- Cleanup scans at most 32 uploads and cascades at most 2048 chunk rows.
  DELETE FROM chunk_uploads.uploads WHERE expires_at <= t;
  IF b.minute_start <= t - interval '1 minute' THEN b.minute_start := t; b.minute_ops := 0; END IF;
  IF b.day_start <= t - interval '24 hours' THEN
    b.day_start := t; b.day_ops := 0; b.day_creates := 0; b.day_bytes := 0;
  END IF;
  -- Internal finish releases a claimed slot even when the public budget is spent.
  -- The restricted function cannot make another POST or reopen the upload.
  IF action <> 'finish' THEN
    IF b.minute_ops >= 240 THEN RETURN jsonb_build_object('error', 'upload_rate_limited', 'retryAfter', 60); END IF;
    IF b.day_ops >= 6000 THEN RETURN jsonb_build_object('error', 'upload_daily_limit', 'retryAfter', 86400); END IF;
    b.minute_ops := b.minute_ops + 1; b.day_ops := b.day_ops + 1;
  END IF;
  UPDATE chunk_uploads.budget SET minute_start = b.minute_start, minute_ops = b.minute_ops,
    day_start = b.day_start, day_ops = b.day_ops, day_creates = b.day_creates, day_bytes = b.day_bytes WHERE id;
  SELECT * INTO u FROM chunk_uploads.uploads WHERE key = token_hash;
  IF action = 'create' THEN
    IF request_text IS NULL OR total_bytes IS NULL OR total_bytes NOT BETWEEN 1 AND 262144
       OR total_parts IS NULL OR total_parts <> (total_bytes + 4095) / 4096
       OR body_digest IS NULL OR body_digest !~ '^[a-f0-9]{64}$'
       OR expires_epoch IS NULL OR expires_epoch < 0 OR expires_epoch > 4102444800 THEN
      RETURN jsonb_build_object('error', 'invalid_upload');
    END IF;
    IF to_timestamp(expires_epoch) <= t OR to_timestamp(expires_epoch) > t + interval '15 minutes' THEN
      RETURN jsonb_build_object('error', 'invalid_expiry');
    END IF;
    IF u.key IS NOT NULL THEN
      IF u.request <> request_text OR u.bytes <> total_bytes OR u.parts <> total_parts OR u.digest <> body_digest OR u.expires_at <> to_timestamp(expires_epoch) THEN
        RETURN jsonb_build_object('error', 'upload_conflict');
      END IF;
      -- A retried create never extends expiry, resets chunks, or reopens a claim.
    ELSE
      IF b.day_creates >= 64 OR b.day_bytes + total_bytes > 16777216 THEN
        RETURN jsonb_build_object('error', 'upload_daily_limit', 'retryAfter', 86400);
      END IF;
      IF (SELECT count(*) FROM chunk_uploads.uploads) >= 32 THEN
        RETURN jsonb_build_object('error', 'upload_capacity', 'retryAfter', 60);
      END IF;
      INSERT INTO chunk_uploads.uploads (key, request, bytes, parts, digest, expires_at)
        VALUES (token_hash, request_text, total_bytes, total_parts, body_digest, to_timestamp(expires_epoch)) RETURNING * INTO u;
      UPDATE chunk_uploads.budget SET day_creates = day_creates + 1, day_bytes = day_bytes + total_bytes WHERE id;
    END IF;
  ELSIF u.key IS NULL THEN RETURN jsonb_build_object('error', 'upload_not_found');
  END IF;
  IF action = 'put' THEN
    IF u.state <> 'open' THEN RETURN jsonb_build_object('error', 'upload_consumed'); END IF;
    IF part_index IS NULL OR part_index < 0 OR part_index >= u.parts OR part_data IS NULL
       OR octet_length(part_data) <> least(4096, u.bytes - part_index * 4096) THEN
      RETURN jsonb_build_object('error', 'invalid_chunk');
    END IF;
    SELECT data INTO old_data FROM chunk_uploads.parts WHERE upload_key = token_hash AND index = part_index;
    IF FOUND THEN
      IF old_data <> part_data THEN RETURN jsonb_build_object('error', 'chunk_conflict'); END IF;
    ELSE
      INSERT INTO chunk_uploads.parts VALUES (token_hash, part_index, part_data);
    END IF;
  ELSIF action = 'claim' THEN
    IF u.state <> 'open' THEN RETURN jsonb_build_object('error', 'upload_consumed'); END IF;
    -- Leave enough lifetime for the 40-second function; crashes retain the claim
    -- until expiry. A missing completion is never interpreted as safe to retry.
    IF u.expires_at <= t + interval '1 minute' THEN RETURN jsonb_build_object('error', 'upload_expiring'); END IF;
    SELECT count(*), string_agg(data, ''::bytea ORDER BY index) INTO received, assembled
      FROM chunk_uploads.parts WHERE upload_key = token_hash;
    IF received <> u.parts OR octet_length(assembled) <> u.bytes THEN RETURN jsonb_build_object('error', 'upload_incomplete'); END IF;
    IF encode(sha256(assembled), 'hex') <> u.digest THEN RETURN jsonb_build_object('error', 'digest_mismatch'); END IF;
    IF (SELECT count(*) FROM chunk_uploads.uploads WHERE state = 'claimed') >= 4 THEN
      RETURN jsonb_build_object('error', 'execution_capacity', 'retryAfter', 30);
    END IF;
    UPDATE chunk_uploads.uploads SET state = 'claimed' WHERE key = token_hash;
    DELETE FROM chunk_uploads.parts WHERE upload_key = token_hash;
    RETURN jsonb_build_object('request', u.request, 'body', encode(assembled, 'base64'));
  ELSIF action = 'finish' THEN
    UPDATE chunk_uploads.uploads SET state = 'done' WHERE key = token_hash AND state = 'claimed';
  END IF;
  SELECT * INTO u FROM chunk_uploads.uploads WHERE key = token_hash;
  RETURN jsonb_build_object('state', u.state, 'bytes', u.bytes, 'chunks', u.parts, 'expiresAt', u.expires_at,
    'received', (SELECT coalesce(jsonb_agg(index ORDER BY index), '[]'::jsonb) FROM chunk_uploads.parts WHERE upload_key = token_hash));
END;
$$;
REVOKE ALL ON FUNCTION chunk_uploads.operate(text,text,text,integer,integer,text,integer,bytea,bigint) FROM PUBLIC;
COMMIT;
