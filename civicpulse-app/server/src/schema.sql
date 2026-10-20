-- CivicFix schema (PostgreSQL 12+, no extensions required)

CREATE TABLE IF NOT EXISTS users (
  id            serial PRIMARY KEY,
  name          text        NOT NULL,
  email         text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  role          text        NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS issues (
  id             serial PRIMARY KEY,
  user_id        integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_url      text,
  category       text    NOT NULL CHECK (category IN
                   ('pothole','garbage','water_leakage','broken_streetlight','road_damage')),
  description    text    NOT NULL,
  latitude       double precision NOT NULL CHECK (latitude  BETWEEN  -90 AND  90),
  longitude      double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  severity       smallint NOT NULL DEFAULT 3 CHECK (severity BETWEEN 1 AND 5),
  status         text     NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','in_progress','resolved')),
  upvotes        integer  NOT NULL DEFAULT 0,
  -- Priority Score = Severity x 10 + Upvotes, kept by the database itself
  priority_score integer  GENERATED ALWAYS AS (severity * 10 + upvotes) STORED,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- one vote per person per issue
CREATE TABLE IF NOT EXISTS issue_upvotes (
  issue_id   integer NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id    integer NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issue_id, user_id)
);

CREATE TABLE IF NOT EXISTS status_history (
  id         serial PRIMARY KEY,
  issue_id   integer NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  status     text    NOT NULL,
  changed_by integer REFERENCES users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

-- photo or video, and whether the file carried its own GPS tag
ALTER TABLE issues ADD COLUMN IF NOT EXISTS media_type    text NOT NULL DEFAULT 'photo'
  CHECK (media_type IN ('photo','video','none'));
ALTER TABLE issues ADD COLUMN IF NOT EXISTS geo_source    text NOT NULL DEFAULT 'device'
  CHECK (geo_source IN ('exif','device','manual'));
ALTER TABLE issues ADD COLUMN IF NOT EXISTS exif_lat      double precision;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS exif_lng      double precision;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS exif_drift_m  double precision;

-- federated sign-in: a Google account has no password of ours to store
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider text NOT NULL DEFAULT 'password'
  CHECK (auth_provider IN ('password','google'));

-- a report carries both a geotagged still and a clip
ALTER TABLE issues ADD COLUMN IF NOT EXISTS video_url text;

-- GIS land-use classification for the reported point
ALTER TABLE issues ADD COLUMN IF NOT EXISTS land_class text NOT NULL DEFAULT 'unknown'
  CHECK (land_class IN ('public','private','unknown'));
ALTER TABLE issues ADD COLUMN IF NOT EXISTS land_note  text;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS device_lat double precision;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS device_lng double precision;

-- when the camera says the picture was taken
ALTER TABLE issues ADD COLUMN IF NOT EXISTS photo_taken_at timestamptz;

-- the reporter was warned this looked like private land and chose to file anyway
ALTER TABLE issues ADD COLUMN IF NOT EXISTS private_ack boolean NOT NULL DEFAULT false;

-- community verification: residents confirm or dispute that the issue is really there
ALTER TABLE issues ADD COLUMN IF NOT EXISTS confirmations integer NOT NULL DEFAULT 0;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS disputes      integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS issue_verifications (
  issue_id   integer NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id    integer NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  verdict    text    NOT NULL CHECK (verdict IN ('confirm','dispute')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issue_id, user_id)     -- one verdict per person per issue
);

CREATE INDEX IF NOT EXISTS idx_verifications_issue ON issue_verifications (issue_id);

-- keep both counters in step with the verification table
CREATE OR REPLACE FUNCTION sync_verification_counts() RETURNS trigger AS $$
DECLARE target integer;
BEGIN
  IF TG_OP = 'DELETE' THEN target := OLD.issue_id; ELSE target := NEW.issue_id; END IF;
  UPDATE issues SET
    confirmations = (SELECT count(*) FROM issue_verifications WHERE issue_id = target AND verdict = 'confirm'),
    disputes      = (SELECT count(*) FROM issue_verifications WHERE issue_id = target AND verdict = 'dispute')
  WHERE id = target;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_verifications ON issue_verifications;
CREATE TRIGGER trg_sync_verifications
AFTER INSERT OR UPDATE OR DELETE ON issue_verifications
FOR EACH ROW EXECUTE FUNCTION sync_verification_counts();

-- an admin's depot or ward office, used as the starting point for directions
ALTER TABLE users ADD COLUMN IF NOT EXISTS office_lat   double precision;
ALTER TABLE users ADD COLUMN IF NOT EXISTS office_lng   double precision;
ALTER TABLE users ADD COLUMN IF NOT EXISTS office_label text;

-- the duplicate check hits this every time someone files a report
CREATE INDEX IF NOT EXISTS idx_issues_cat_pos   ON issues (category, latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_issues_priority  ON issues (priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_issues_status    ON issues (status);
CREATE INDEX IF NOT EXISTS idx_issues_user      ON issues (user_id);

-- great-circle distance in metres
CREATE OR REPLACE FUNCTION distance_m(
  lat1 double precision, lon1 double precision,
  lat2 double precision, lon2 double precision
) RETURNS double precision AS $$
  SELECT 6371000 * 2 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) *
    power(sin(radians(lon2 - lon1) / 2), 2)
  )));
$$ LANGUAGE sql IMMUTABLE;

-- keep issues.upvotes in step with the junction table
CREATE OR REPLACE FUNCTION sync_upvote_count() RETURNS trigger AS $$
DECLARE target integer;
BEGIN
  IF TG_OP = 'DELETE' THEN target := OLD.issue_id; ELSE target := NEW.issue_id; END IF;
  UPDATE issues SET upvotes = (
    SELECT count(*) FROM issue_upvotes WHERE issue_id = target
  ) WHERE id = target;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_upvotes ON issue_upvotes;
CREATE TRIGGER trg_sync_upvotes
AFTER INSERT OR DELETE ON issue_upvotes
FOR EACH ROW EXECUTE FUNCTION sync_upvote_count();

-- log every status change so residents can track progress
CREATE OR REPLACE FUNCTION log_status_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO status_history (issue_id, status) VALUES (NEW.id, NEW.status);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO status_history (issue_id, status) VALUES (NEW.id, NEW.status);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_status_history ON issues;
CREATE TRIGGER trg_status_history
AFTER INSERT OR UPDATE OF status ON issues
FOR EACH ROW EXECUTE FUNCTION log_status_change();
