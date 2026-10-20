# Known land zones — a local table, checked first

Extract into `civicpulse-app`, then:

    cd server
    npm run setup      # creates the table and the seed zones
    npm run dev

Add this to `server/package.json` scripts:

    "zones": "node src/zones.js"

## What this changes

The land check now asks the database before it asks anything on the internet:

1. **`land_zones`** — a small indexed table of places the ward office already knows about.
   One query, no network, answers in a millisecond. A match here is final.
2. Overpass, if no zone covers the point.
3. Nominatim, if Overpass is unreachable.

A campus is not a matter of opinion. Recording it once beats asking a volunteer-mapped
service every time, and it works on a network that blocks both.

## Seeded for your area

| Zone | Kind | Radius |
|---|---|---|
| SRM Institute of Science and Technology, Kattankulathur | private | 1100 m |
| SRM Hospital and Research Centre | private | 400 m |
| Zoho Corporation, Estancia IT Park | private | 700 m |
| Estancia Township | private | 600 m |

**The coordinates are approximate.** They will catch the campuses, but correct them once
you have stood in each place — see below. Anywhere not covered by a zone falls through to
the external services and usually resolves as public, which is the behaviour you want:
private places are the exception worth naming, not the rule.

## Correcting or adding a zone

Drop a pin in the report form and read the latitude and longitude it shows. Then:

    npm run zones -- add "SRM Institute of Science and Technology, Kattankulathur" private 12.8231 80.0442 1100 "University campus"

Re-adding an existing name updates it rather than duplicating.

    npm run zones                                 list everything
    npm run zones -- check 12.8231 80.0442        what the app would say here
    npm run zones -- remove "Estancia Township"

`check` is the useful one while tuning: it prints the three nearest zones with distances,
so you can see whether a radius is too small or too large.

## Choosing a radius

Measure from the centre to the furthest edge you want covered. A university campus is
usually 800 to 1500 m, a corporate estate 400 to 800 m, a gated society 150 to 400 m.

Too large is worse than too small: an oversized radius swallows the public road outside
the gate, and genuine reports there get refused.

## Why circles and not boundaries

A polygon is more accurate. It is also far more work to enter, and needs PostGIS to query
properly. For "is this inside the campus" a circle is right often enough, and the whole
thing stays in plain SQL with the `distance_m` function you already have.

If you outgrow it, PostGIS and real boundaries from OpenStreetMap are the upgrade path —
but that is a different project.

## Wiring the SQL into setup

`land-zones.sql` is a separate file so you can run it on its own. To have `npm run setup`
create the table too, add one line to `server/src/setup.js`, just after the existing
schema is applied:

    const zones = fs.readFileSync(path.join(dir, 'land-zones.sql'), 'utf8');
    await q(zones);
    console.log('Land zones ready.');

Or run it once by hand:

    psql -U postgres -d civicpulse -f src/land-zones.sql
