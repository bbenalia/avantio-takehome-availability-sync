-- Every accepted request, never modified (SPEC §4.2).
CREATE TABLE updates (
  id               bigserial     PRIMARY KEY,
  accommodation_id text          NOT NULL,
  from_date        date          NOT NULL,
  to_date          date          NOT NULL,
  available        boolean       NOT NULL,
  price_per_night  numeric(10,2) NOT NULL,
  accepted_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE SEQUENCE desired_version_seq;

CREATE TABLE desired_days (
  accommodation_id text          NOT NULL,
  date             date          NOT NULL,
  available        boolean       NOT NULL,
  price_per_night  numeric(10,2) NOT NULL,
  version          bigint        NOT NULL,
  synced_version   bigint        NOT NULL DEFAULT 0,
  changed_at       timestamptz   NOT NULL DEFAULT now(),
  synced_at        timestamptz,
  attempts         int           NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz   NOT NULL DEFAULT now(),
  last_error_code  text,
  last_error_at    timestamptz,
  failed_at        timestamptz,
  PRIMARY KEY (accommodation_id, date)
);

CREATE INDEX desired_days_due ON desired_days (next_attempt_at)
  WHERE version > synced_version AND failed_at IS NULL;

CREATE TABLE portal_state (
  id           int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  paused_until timestamptz
);
INSERT INTO portal_state (id) VALUES (1) ON CONFLICT DO NOTHING;
