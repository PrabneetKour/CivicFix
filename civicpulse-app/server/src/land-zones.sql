-- Locally known land zones.
--
-- The external services are slow, sometimes blocked, and only as good as what volunteers
-- have mapped. A campus or a gated society is a fact the ward office already knows, so
-- record it once and answer instantly from the database.
--
-- Each zone is a centre point and a radius. Circles rather than polygons: a polygon is
-- more accurate but far more work to enter by hand, and for "is this inside the campus"
-- a circle is right often enough to be worth the simplicity.
--
-- Zones are checked before Overpass and Nominatim, so a match here settles it.

CREATE TABLE IF NOT EXISTS land_zones (
  id         serial PRIMARY KEY,
  name       text    NOT NULL,
  kind       text    NOT NULL CHECK (kind IN ('private', 'public')),
  latitude   double precision NOT NULL,
  longitude  double precision NOT NULL,
  radius_m   integer NOT NULL CHECK (radius_m BETWEEN 20 AND 20000),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name)
);

CREATE INDEX IF NOT EXISTS idx_land_zones_pos ON land_zones (latitude, longitude);

-- ---------------------------------------------------------------------------
-- Seed zones for Chengalpattu / Kattankulathur.
--
-- These coordinates are approximate — good enough to catch the campus, worth
-- correcting once you have stood in each place. Drop a pin in the report form,
-- read the latitude and longitude it shows, and UPDATE the row.
-- ---------------------------------------------------------------------------

INSERT INTO land_zones (name, kind, latitude, longitude, radius_m, note) VALUES
  ('SRM Institute of Science and Technology, Kattankulathur',
   'private', 12.8230, 80.0444, 1100,
   'University campus. Internal roads, paths and drains are maintained by the institution, not the municipality.'),

  ('SRM Hospital and Research Centre',
   'private', 12.8213, 80.0419, 400,
   'Hospital campus within SRM. Institutional responsibility.'),

  ('Zoho Corporation, Estancia IT Park',
   'private', 12.8455, 80.0086, 700,
   'Corporate campus. Roads inside the estate are privately maintained.'),

  ('Estancia Township',
   'private', 12.8470, 80.0120, 600,
   'Gated township. Internal roads are the association''s responsibility.')
ON CONFLICT (name) DO NOTHING;
