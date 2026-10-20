import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Switch, useLocation } from "wouter";
import L from "leaflet";
import exifr from "exifr";
import "leaflet/dist/leaflet.css";
import {
  Activity, AlertTriangle, ArrowLeft, ArrowRight, ArrowUpRight, Camera, Check, CheckCircle2,
  CircleHelp, ClipboardList, CloudUpload, FileText, Filter, Flag, Globe2, ImagePlus, Lightbulb,
  LocateFixed, LockKeyhole, Menu, Navigation, Plus, Search, ShieldCheck, Siren, SlidersHorizontal,
  ThumbsUp, Video, X,
} from "lucide-react";
import {
  backIssue, checkLand, createIssue, verifyIssue, signInWithGoogle, getPolicy, findNearbyIssues, getCurrentUser, getIssues, getMyReports,
  distanceInMeters, register, signIn, updateIssueStatus, upvoteIssue, isAuthed, signOut, getReportQuota,
} from "./lib/api";

const CATEGORY_LABELS = {
  pothole: "Pothole",
  garbage: "Garbage",
  water_leakage: "Water leakage",
  broken_streetlight: "Broken streetlight",
  road_damage: "Road damage",
};
const CATEGORY_ICONS = {
  pothole: AlertTriangle,
  garbage: ClipboardList,
  water_leakage: Activity,
  broken_streetlight: Lightbulb,
  road_damage: Navigation,
};
const CATEGORY_DESK = {
  pothole: "Roads maintenance squad",
  garbage: "Sanitation squad",
  water_leakage: "Water board crew",
  broken_streetlight: "Street lighting crew",
  road_damage: "Roads maintenance squad",
};
const STATUS_LABELS = { pending: "Pending review", in_progress: "In progress", resolved: "Resolved" };
const SEVERITY_SCALE = [
  [5, "Critical danger or obstruction", "An immediate hazard to life, or a main route is blocked."],
  [4, "High impact safety risk", "Likely property damage, or a main artery is breaking down."],
  [3, "Moderate civic disruption", "A persistent inconvenience or sanitation hazard."],
  [2, "Minor street defect", "Localised chipping or overflow. Not hazardous."],
  [1, "Cosmetic or low urgency", "An aesthetic defect, or routine scheduled maintenance."],
];
const DESCRIPTION_CUES = [
  "near the junction", "pedestrian hazard", "waterlogs in the monsoon",
  "unlit after dark", "beside a school gate",
];

/* One place that watches the device position, so every map can show "you are here". */
function useMyPosition(watch = true) {
  const [position, setPosition] = useState(null);
  const [accuracy, setAccuracy] = useState(null);
  useEffect(() => {
    if (!navigator.geolocation) return undefined;
    const ok = (p) => { setPosition([p.coords.latitude, p.coords.longitude]); setAccuracy(p.coords.accuracy); };
    const opts = { enableHighAccuracy: true, timeout: 12000, maximumAge: 10000 };
    if (!watch) { navigator.geolocation.getCurrentPosition(ok, () => {}, opts); return undefined; }
    const id = navigator.geolocation.watchPosition(ok, () => {}, opts);
    return () => navigator.geolocation.clearWatch(id);
  }, [watch]);
  return { position, accuracy };
}

const youIcon = () => L.divIcon({ className: "", iconSize: [18, 18], iconAnchor: [9, 9],
  html: '<div class="you-dot"></div>' });

function metresBetween(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 +
            Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const formatKm = (m) => (m < 950 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const formatMins = (sec) => {
  const mins = Math.max(1, Math.round(sec / 60));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, "0")}`;
};

/* OSRM's public router over the OpenStreetMap road network — free, no key.
   Falls back to a straight line at 25 km/h if it cannot be reached. */
async function routeBetween(from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from[1]},${from[0]};${to[1]},${to[0]}`
            + "?overview=full&geometries=geojson&steps=true";
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (data.code !== "Ok" || !data.routes?.length) throw new Error("no route");
    return { ...data.routes[0], approximate: false };
  } catch {
    const distance = metresBetween(from, to);
    return {
      distance, duration: distance / 6.5, approximate: true,
      legs: [{ steps: [] }],
      geometry: { coordinates: [[from[1], from[0]], [to[1], to[0]]] }
    };
  }
}

function stepInstruction(step) {
  const move = step.maneuver || {};
  const road = step.name?.trim() ? step.name : "the road";
  const way = { left: "left", right: "right", "slight left": "slightly left", "slight right": "slightly right",
                "sharp left": "sharp left", "sharp right": "sharp right", straight: "straight",
                uturn: "back around" }[move.modifier] || "";
  switch (move.type) {
    case "depart": return `Head out along ${road}`;
    case "turn": return `Turn ${way} onto ${road}`;
    case "new name": return `Continue onto ${road}`;
    case "roundabout":
    case "rotary": return `At the roundabout take exit ${move.exit || "—"} onto ${road}`;
    case "end of road": return `At the end of the road turn ${way} onto ${road}`;
    case "merge": return `Merge ${way} onto ${road}`;
    case "fork": return `Keep ${way} at the fork onto ${road}`;
    case "arrive": return "Arrive at the issue";
    default: return `Continue on ${road}`;
  }
}

/* Six independent residents confirming an issue is a different kind of fact from one
   person reporting it. Past that line the report is treated as established rather than
   claimed, and it is coloured differently everywhere it appears. */
const VERIFIED_AT = 6;

function communityStanding(issue) {
  const confirmed = Number(issue?.confirmations || 0);
  const disputed = Number(issue?.disputes || 0);
  const checks = confirmed + disputed;

  if (confirmed >= VERIFIED_AT && confirmed > disputed) {
    return {
      key: "verified", confirmed, disputed, checks,
      label: "Community verified",
      message: `Verified on the ground by ${confirmed} residents. This is no longer a single claim — the ward office can act on it.`
    };
  }
  if (checks >= 3 && disputed > confirmed) {
    return {
      key: "disputed", confirmed, disputed, checks,
      label: "Disputed",
      message: `${disputed} residents could not find this issue. It may already have been fixed, or reported in the wrong place.`
    };
  }
  if (checks > 0) {
    return {
      key: "checking", confirmed, disputed, checks,
      label: `${confirmed}/${VERIFIED_AT} confirmed`,
      message: `${confirmed} of the ${VERIFIED_AT} confirmations needed. ${VERIFIED_AT - confirmed} more and this becomes community verified.`
    };
  }
  return { key: "unchecked", confirmed, disputed, checks, label: "Not yet checked", message: null };
}

/* Leaflet measures its container once, at creation. On a phone the layout is often
   still settling at that moment — a drawer closing, the address bar collapsing, the
   keyboard dismissing — and the map ends up blank or half-drawn. Watching the element
   and re-measuring fixes it, and costs nothing when the size never changes. */
function useMapAutosize(mapRef, hostRef) {
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const resize = () => mapRef.current?.invalidateSize({ animate: false });
    const timers = [60, 250, 700].map((ms) => window.setTimeout(resize, ms));

    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    observer?.observe(host);
    window.addEventListener("resize", resize);
    window.addEventListener("orientationchange", resize);

    return () => {
      timers.forEach(window.clearTimeout);
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("orientationchange", resize);
    };
  }, []);
}

/* red above 65, amber from 40, grey below — unchanged thresholds, new class names */
function scoreTone(score) {
  if (score >= 65) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(date));
}

function formatShortDate(date) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(new Date(date));
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(date));
}

const issueRef = (issue) => `#${issue.id}`;

function locationLabel(issue) {
  const locations = {
    "CF-1048": "Infantry Road bus stop",
    "CF-1047": "Russell Market lane",
    "CF-1043": "Cubbon Park East gate",
    "CF-1039": "Queen’s Road crossing",
    "CF-1034": "Community Hall, 2nd Cross",
    "CF-1028": "Market Street entrance",
    "CF-1021": "4th Cross, ward park",
  };
  return locations[issue.id] || `${Number(issue.latitude).toFixed(4)}, ${Number(issue.longitude).toFixed(4)}`;
}

function useToast() {
  const [toast, setToast] = useState("");
  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  return [toast, setToast];
}

/* The signed-in account, fetched once and shared. Several screens need to know
   whose reports are whose, because a person may not back or verify their own. */
let mePromise = null;
function useMe() {
  const [me, setMe] = useState({ name: "", id: null, role: null });
  useEffect(() => {
    if (!mePromise) mePromise = getCurrentUser();
    mePromise.then(setMe).catch(() => { mePromise = null; });
  }, []);
  return me;
}

function useIssueFeed(myOnly = false) {
  const [issues, setIssues] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const refresh = async () => {
    setIsLoading(true);
    setError("");
    try {
      setIssues(myOnly ? await getMyReports() : await getIssues());
    } catch {
      setError("The local issue register could not be read.");
    } finally {
      setIsLoading(false);
    }
  };
  useEffect(() => { refresh(); }, [myOnly]);
  return { issues, isLoading, error, refresh };
}

/* ------------------------------------------------------------------ shell */
function Brand({ tagline = "Municipal issue priority system", href = "/map" }) {
  const inner = (
    <>
      <div className="brand-mark">C</div>
      <div>
        <strong>CivicFix <small>OFFICIAL</small></strong>
        <span>{tagline}</span>
      </div>
    </>
  );

  if (!href) return <div className="brand" data-testid="brand-civicfix">{inner}</div>;

  return (
    <Link href={href} className="brand" aria-label="CivicFix home" data-testid="brand-civicfix">
      {inner}
    </Link>
  );
}
const NAV_ITEMS = [
  { href: "/map", label: "Map & priority queue", icon: Globe2 },
  { href: "/my-reports", label: "My reports", icon: FileText },
  { href: "/admin", label: "Ward priority desk", icon: SlidersHorizontal, adminOnly: true },
];

function AppShell({ children }) {
  const [location] = useLocation();
  const user = useMe();
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => { setNavOpen(false); }, [location]);

  const initials = (user.name || "·").split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  const items = NAV_ITEMS.filter((item) => !item.adminOnly || user.role === "admin");

  return (
    <div className="app-shell civic-home-shell">
      <div className="main-shell">
        <header className="civic-topbar">
          <Brand />
          <button className="menu-button" onClick={() => setNavOpen(!navOpen)} aria-label="Open navigation" aria-expanded={navOpen} data-testid="button-open-navigation">
            <Menu size={20} />
          </button>
          <nav className={`top-nav${navOpen ? " open" : ""}`} aria-label="Primary navigation">
            {items.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={`top-nav-item${location === href ? " active" : ""}`}
                data-testid={`link-${label.toLowerCase().replaceAll(" ", "-").replaceAll("&", "and")}`}
              >
                <Icon size={16} /><span>{label}</span>
              </Link>
            ))}
            <Link href="/report" className="top-nav-item report-nav" data-testid="link-quick-report">
              <Plus size={16} /><span>Report issue</span>
            </Link>
          </nav>
          <div className="top-user" data-testid="profile-current-user">
            <span className="top-avatar">{initials}</span>
            <span>
              <strong>{user.name || "Signed in"}</strong>
              <small>{user.role === "admin" ? "Ward administrator" : "Resident account"}</small>
            </span>
            <Link href="/sign-out" className="top-signout" aria-label="Sign out" data-testid="link-sign-out">
              <LockKeyhole size={16} />
            </Link>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------- small components */

function Badge({ children, tone = "neutral" }) {
  return <span className={`badge ${tone}`} data-testid={`badge-${tone}`}>{children}</span>;
}

function StatusBadge({ status }) {
  return <span className={`badge ${status}`} data-testid={`status-${status}`}>{STATUS_LABELS[status]}</span>;
}

function Score({ score, small = false }) {
  return (
    <div className={`priority ${scoreTone(score)}${small ? " small" : ""}`} data-testid={`score-${score}`}>
      <strong>{score}</strong><span>priority</span>
    </div>
  );
}

function ScoreTag({ score }) {
  return (
    <div className={`score-tag ${scoreTone(score)}`} data-testid={`score-tag-${score}`}>
      {score}<small>SCORE</small>
    </div>
  );
}

function LoadingPanel({ rows = 4 }) {
  return (
    <div className="loading-stack" data-testid="state-loading">
      {Array.from({ length: rows }).map((_, index) => (
        <div className="skeleton" key={index} style={{ height: index === 0 ? 42 : 58, width: `${96 - index * 7}%` }} />
      ))}
    </div>
  );
}

function ErrorPanel({ onRetry }) {
  return (
    <div className="error-state" data-testid="state-error">
      <AlertTriangle size={24} />
      <strong>Register unavailable</strong>
      <span>Something interrupted the local register.</span>
      <button className="button secondary" onClick={onRetry} data-testid="button-retry">Try again</button>
    </div>
  );
}

function Thumb({ issue, className = "" }) {
  if (!issue.photo_url) {
    return <div className={`thumb-empty ${className}`} data-testid={`photo-thumb-empty-${issue.id}`}><CloudUpload size={14} /></div>;
  }
  if (issue.media_type === "video") {
    return <video className={className} src={issue.photo_url} muted data-testid={`video-thumb-${issue.id}`} />;
  }
  return <img className={className} src={issue.photo_url} alt={`Evidence for report ${issue.id}`} data-testid={`photo-thumb-${issue.id}`} />;
}

/* ------------------------------------------------------------ issue queue */

function IssueRow({ issue, onSelect }) {
  const standing = communityStanding(issue);
  return (
    <button className="issue-row" onClick={() => onSelect(issue)} data-testid={`card-issue-${issue.id}`}>
      <ScoreTag score={issue.priority_score} />
      <div className="issue-copy">
        <div className="row-top">
          <span>{issueRef(issue)}</span>
          <Badge tone={issue.status}>{STATUS_LABELS[issue.status]}</Badge>
        </div>
        <strong>{issue.description}</strong>
        <span className="issue-meta">
          {CATEGORY_LABELS[issue.category]} · {issue.upvotes} backing{issue.upvotes === 1 ? "" : "s"} ·{" "}
          <span className={standing.key === "disputed" ? "warn" : standing.key === "verified" ? "ok" : ""}>{standing.label}</span>
        </span>
      </div>
    </button>
  );
}

function CategoryChips({ issues, value, onChange }) {
  const options = [["all", "All"], ...Object.entries(CATEGORY_LABELS)];
  return (
    <div className="filter-row" role="group" aria-label="Filter by issue category">
      {options.map(([category, label]) => (
        <button
          key={category}
          className={`chip${value === category ? " selected" : ""}`}
          onClick={() => onChange(category)}
          data-testid={`button-filter-category-${category}`}
        >
          {label} <b>{category === "all" ? issues.length : issues.filter((issue) => issue.category === category).length}</b>
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- the maps */

function MapCanvas({ issues, onSelect }) {
  const mapNode = useRef(null);
  const mapRef = useRef(null);
  useMapAutosize(mapRef, mapNode);
  const markerLayerRef = useRef(null);
  const youLayerRef = useRef(null);
  const centredRef = useRef(false);
  const { position, accuracy } = useMyPosition();
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return undefined;
    const map = L.map(mapNode.current, { zoomControl: false, attributionControl: true }).setView([12.9719, 77.5945], 15);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors", maxZoom: 19 }).addTo(map);
    markerLayerRef.current = L.layerGroup().addTo(map);
    youLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    const sizeTimer = window.setTimeout(() => { if (mapRef.current === map) map.invalidateSize(); }, 100);
    return () => { window.clearTimeout(sizeTimer); map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    if (!markerLayerRef.current) return;
    markerLayerRef.current.clearLayers();
    issues.forEach((issue) => {
      const tone = scoreTone(issue.priority_score);
      const marker = L.marker([issue.latitude, issue.longitude], {
        icon: L.divIcon({
          className: `map-pin ${tone}${issue.status === "resolved" ? " resolved" : ""}`,
          html: `<span>${issue.priority_score}</span>`,
          iconSize: [38, 38], iconAnchor: [19, 19]
        })
      });
      marker.on("click", () => onSelectRef.current(issue));
      marker.bindTooltip(`${CATEGORY_LABELS[issue.category]} · ${issue.priority_score}`, { direction: "top", offset: [0, -22] });
      marker.addTo(markerLayerRef.current);
    });
  }, [issues]);

  /* drop a "you are here" dot, and centre on it the first time it arrives */
  useEffect(() => {
    if (!youLayerRef.current || !position) return;
    youLayerRef.current.clearLayers();
    L.marker(position, { icon: youIcon(), zIndexOffset: 700 })
      .bindTooltip("You are here").addTo(youLayerRef.current);
    if (accuracy && accuracy > 60) {
      L.circle(position, { radius: accuracy, color: "#397bb2", weight: 1, fillOpacity: .08, interactive: false })
        .addTo(youLayerRef.current);
    }
    if (!centredRef.current) { mapRef.current?.setView(position, 15); centredRef.current = true; }
  }, [position?.[0], position?.[1], accuracy]);

  const recentre = () => { if (position) mapRef.current?.flyTo(position, 16, { duration: .6 }); };

  return (
    <div className="map-canvas">
      <div ref={mapNode} className="leaflet-map" data-testid="map-issue-map" />
      {position && (
        <button type="button" className="recenter" onClick={recentre} title="Centre on my location" aria-label="Centre on my location" data-testid="button-recentre-map">
          <LocateFixed size={17} />
        </button>
      )}
      <div className="map-legend">
        <strong>Priority colour scale</strong>
        <span><i className="legend-dot high" />Urgent · 65 and above</span>
        <span><i className="legend-dot medium" />Watch · 40 to 64</span>
        <span><i className="legend-dot low" />Queued · under 40</span>
      </div>
    </div>
  );
}

function ReportLocationMap({ latitude, longitude, onChange }) {
  const youRef = useRef(null);
  const { position: myPosition } = useMyPosition();
  const mapNode = useRef(null);
  const mapRef = useRef(null);
  useMapAutosize(mapRef, mapNode);
  const markerRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return undefined;
    const initial = [Number(latitude) || 12.9719, Number(longitude) || 77.5945];
    const map = L.map(mapNode.current, { zoomControl: true, attributionControl: true }).setView(initial, 16);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors", maxZoom: 19 }).addTo(map);
    const marker = L.marker(initial, { draggable: true }).addTo(map);
    marker.bindTooltip("Drag or click to place", { direction: "top", offset: [0, -20] }).openTooltip();
    marker.on("dragend", () => {
      const point = marker.getLatLng();
      onChangeRef.current(point.lat, point.lng);
    });
    map.on("click", (event) => {
      marker.setLatLng(event.latlng);
      onChangeRef.current(event.latlng.lat, event.latlng.lng);
    });
    mapRef.current = map;
    markerRef.current = marker;
    const sizeTimer = window.setTimeout(() => { if (mapRef.current === map) map.invalidateSize(); }, 80);
    return () => { window.clearTimeout(sizeTimer); map.remove(); mapRef.current = null; markerRef.current = null; };
  }, []);

  useEffect(() => {
    if (!markerRef.current || !latitude || !longitude) return;
    const point = [Number(latitude), Number(longitude)];
    markerRef.current.setLatLng(point);
    mapRef.current?.panTo(point, { animate: true, duration: .25 });
  }, [latitude, longitude]);

  useEffect(() => {
    if (!mapRef.current || !myPosition) return;
    if (youRef.current) mapRef.current.removeLayer(youRef.current);
    youRef.current = L.marker(myPosition, { icon: youIcon(), zIndexOffset: 700 })
      .bindTooltip("You are here").addTo(mapRef.current);
  }, [myPosition?.[0], myPosition?.[1]]);

  return (
    <div className="report-map">
      <div ref={mapNode} data-testid="map-report-location" />
      {myPosition && (
        <button type="button" className="map-recentre" onClick={() => mapRef.current?.flyTo(myPosition, 17, { duration: .5 })} title="Centre on my location" data-testid="button-recentre-report">
          <LocateFixed size={16} />
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------- issue detail */

function VerificationPanel({ issue }) {
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState(issue.my_verdict || null);
  const [note, setNote] = useState("");
  const [counts, setCounts] = useState({
    confirmations: Number(issue.confirmations || 0),
    disputes: Number(issue.disputes || 0)
  });
  const confirmations = counts.confirmations;
  const disputes = counts.disputes;
  const standing = communityStanding({ confirmations, disputes });

  const cast = async (next) => {
    setBusy(true);
    setNote("");
    try {
      const updated = await verifyIssue(issue.id, next);
      setVerdict(next);
      setCounts({
        confirmations: Number(updated.confirmations || 0),
        disputes: Number(updated.disputes || 0)
      });
    } catch (error) {
      setNote(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`verification ${standing.key}`} data-testid={`panel-verify-${issue.id}`}>
      {standing.key === "verified" && (
        <div className="verified-banner" data-testid={`banner-standing-${issue.id}`}>
          <ShieldCheck size={16} />Community verified at {confirmations} confirmations
        </div>
      )}
      {standing.key === "disputed" && (
        <div className="verified-banner disputed" data-testid={`banner-standing-${issue.id}`}>
          <AlertTriangle size={16} />Disputed by {disputes} residents
        </div>
      )}
      <div className="verify-head">
        <div>
          <p className="eyebrow">Community signal</p>
          <strong>{standing.label}</strong>
        </div>
        <span>{confirmations}/{VERIFIED_AT} confirmations</span>
      </div>
      <div className={`progress ${standing.key === "disputed" ? "disputed" : ""}`}>
        <i style={{ width: `${Math.min((confirmations / VERIFIED_AT) * 100, 100)}%` }} />
      </div>
      {standing.message && <p className="verify-note">{standing.message}</p>}
      <div className="verify-actions" style={{ marginTop: 12 }}>
        <button type="button" className={verdict === "confirm" ? "chosen" : ""} disabled={busy} onClick={() => cast("confirm")} data-testid={`button-confirm-${issue.id}`}>
          <CheckCircle2 size={14} />{verdict === "confirm" ? "You confirmed" : "I can see it"} <b>{confirmations}</b>
        </button>
        <button type="button" className={verdict === "dispute" ? "chosen" : ""} disabled={busy} onClick={() => cast("dispute")} data-testid={`button-dispute-${issue.id}`}>
          <X size={14} />{verdict === "dispute" ? "You disputed" : "Not there any more"} <b>{disputes}</b>
        </button>
      </div>
      {note && <div className="help-text">{note}</div>}
    </div>
  );
}

function StatusTimeline({ issue }) {
  const order = ["pending", "in_progress", "resolved"];
  const reached = order.indexOf(issue.status);
  const steps = [
    ["Report submitted", formatDateTime(issue.created_at)],
    ["Ward office review", issue.status === "pending" ? "Waiting for review" : "Acknowledged by the ward office"],
    ["Resolved", issue.status === "resolved" ? "Marked fixed" : "Not completed"],
  ];
  return (
    <div className="timeline" data-testid="timeline-issue-status">
      <p className="eyebrow">Status timeline</p>
      {steps.map(([label, note], index) => (
        <div className={`timeline-item${index <= reached ? " done" : ""}`} key={label}>
          <i />
          <div><strong>{label}</strong><span>{note}</span></div>
        </div>
      ))}
    </div>
  );
}

function IssueDetailModal({ issue, onClose, onUpvote }) {
  const [isBacking, setIsBacking] = useState(false);
  const [backed, setBacked] = useState(issue?.backed_by_me);
  const [tab, setTab] = useState("detail");
  const me = useMe();
  if (!issue) return null;
  const isMine = me.id != null && issue.user_id === me.id;
  const standing = communityStanding(issue);

  const handleBack = async () => {
    if (backed || isBacking) return;
    setIsBacking(true);
    await onUpvote(issue.id);
    setBacked(true);
    setIsBacking(false);
  };

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="detail-modal" role="dialog" aria-modal="true" aria-labelledby="issue-detail-title" data-testid="modal-issue-detail">
        <button className="back-link" onClick={onClose} data-testid="button-close-issue-detail">
          <ArrowLeft size={17} /> Back to queue
        </button>
        <div className="detail-layout">
          <div className="detail-media" data-testid={`photo-issue-${issue.id}`}>
            {issue.photo_url ? (
              issue.media_type === "video"
                ? <video src={issue.photo_url} controls />
                : <img src={issue.photo_url} alt={`Street evidence for report ${issue.id}`} />
            ) : (
              <div className="thumb-empty">
                <CloudUpload size={22} />
                <strong>No photo attached</strong>
                <span>Residents add a street-level photo when filing.</span>
              </div>
            )}
            {issue.photo_url && (
              <div className="media-tag">
                <Camera size={14} /> {issue.media_type === "video" ? "Video evidence" : "Photo evidence"}
                {issue.geo_source === "exif" ? " · camera GPS" : ""}
              </div>
            )}
          </div>

          <div className="detail-body">
            <div className="detail-heading">
              <div>
                <div className="row-top" style={{ flexDirection: "row", justifyContent: "flex-start" }}>
                  <Badge tone={issue.status}>{STATUS_LABELS[issue.status]}</Badge>
                  <span>{issueRef(issue)}</span>
                </div>
                <h2 id="issue-detail-title">{CATEGORY_LABELS[issue.category]}</h2>
                <p className="issue-meta">Reported by {issue.reporter} · {formatDate(issue.created_at)} · {locationLabel(issue)}</p>
              </div>
              <Score score={issue.priority_score} />
            </div>

            <div className="detail-tabs">
              <button className={tab === "detail" ? "active" : ""} onClick={() => setTab("detail")} data-testid="tab-detail">Report details</button>
              <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")} data-testid="tab-activity">Activity</button>
            </div>

            {tab === "detail" ? (
              <>
                <p className="detail-body-copy">{issue.description}</p>
                <div className="score-breakdown">
                  <div><span>Severity</span><strong>{issue.severity} × 10</strong></div>
                  <div><span>Resident backing</span><strong>+ {issue.upvotes}</strong></div>
                  <div className="total"><span>Total priority</span><strong>{issue.priority_score}</strong></div>
                </div>
                <div className="detail-facts">
                  <div><span>Land classification</span><strong>{issue.land_class === "private" ? "Private" : issue.land_class === "public" ? "Public" : "Unknown"}</strong></div>
                  <div><span>Location source</span><strong>{issue.geo_source === "exif" ? "Photo GPS" : issue.geo_source === "manual" ? "Placed by hand" : "Device GPS"}</strong></div>
                  <div><span>Backed by</span><strong>{issue.upvotes} residents</strong></div>
                </div>
                {isMine
                  ? <div className="own-note"><ShieldCheck size={15} /><span>This is your report. Backing and verification come from other residents, so the priority score stays a measure of what the ward actually agrees on.</span></div>
                  : <VerificationPanel issue={issue} />}
              </>
            ) : (
              <>
                <StatusTimeline issue={issue} />
                {standing.key === "unchecked" && <div className="empty-activity">No resident has checked this report on the ground yet.</div>}
              </>
            )}

            <div className="detail-actions">
              <button className="button secondary" onClick={onClose} data-testid="button-dismiss-detail">Close</button>
              {!isMine && (
                <button className="button amber" disabled={backed || isBacking} onClick={handleBack} data-testid={`button-back-issue-${issue.id}`}>
                  <ThumbsUp size={15} />{backed ? "Backed by you" : isBacking ? "Recording…" : "Back this issue"}
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------- map page */

function MapPage() {
  const { issues, isLoading, error, refresh } = useIssueFeed();
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("priority");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [toast, setToast] = useToast();

  const filtered = useMemo(() => issues
    .filter((issue) =>
      (category === "all" || issue.category === category) &&
      (status === "all" || issue.status === status) &&
      `${issue.description} ${issue.category} ${issue.id} ${locationLabel(issue)}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sort === "recent"
      ? new Date(b.created_at) - new Date(a.created_at)
      : sort === "backing" ? b.upvotes - a.upvotes : b.priority_score - a.priority_score),
    [issues, category, status, sort, search]);

  const handleUpvote = async (id) => { await upvoteIssue(id); await refresh(); setToast("Your backing has been recorded."); };
  const open = issues.filter((issue) => issue.status !== "resolved").length;

  return (
    <AppShell>
      <main className="map-page">
        <div className="map-panel">
          {isLoading ? <LoadingPanel /> : error ? <ErrorPanel onRetry={refresh} /> : <MapCanvas issues={filtered} onSelect={setSelected} />}
          <div className="map-title">
            <div>
              <p className="eyebrow">Your ward</p>
              <strong>{open} active report{open === 1 ? "" : "s"}</strong>
            </div>
            <Link href="/report" className="button amber" data-testid="link-report-from-map">
              <Plus size={17} /> Report issue
            </Link>
          </div>
        </div>

        <section className="civic-queue">
          <div className="section-head">
            <div>
              <h1>Priority queue <b className="queue-count">{filtered.length} issues</b></h1>
              <p>Ranked by severity and resident backing</p>
            </div>
          </div>

          <div className="search-input queue-search">
            <Search size={17} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by description, place or ID" data-testid="input-search-issues" />
          </div>

          <CategoryChips issues={issues} value={category} onChange={setCategory} />

          <div className="select-row">
            <select value={status} onChange={(event) => setStatus(event.target.value)} data-testid="select-filter-status">
              <option value="all">All statuses</option>
              {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <select value={sort} onChange={(event) => setSort(event.target.value)} data-testid="select-sort">
              <option value="priority">Highest priority</option>
              <option value="recent">Most recent</option>
              <option value="backing">Most backed</option>
            </select>
          </div>

          {isLoading ? <LoadingPanel rows={5} /> : error ? <ErrorPanel onRetry={refresh} /> : filtered.length ? (
            <div className="queue-list">
              {filtered.map((issue) => <IssueRow key={issue.id} issue={issue} onSelect={setSelected} />)}
            </div>
          ) : (
            <div className="empty-state" data-testid="state-empty-map">
              <Filter size={27} />
              <strong>No matching reports</strong>
              <p>Clear a filter, or search another term.</p>
            </div>
          )}
        </section>
      </main>

      <IssueDetailModal issue={selected} onClose={() => setSelected(null)} onUpvote={handleUpvote} />
      {toast && <div className="toast" role="status" data-testid="toast-map">{toast}</div>}
    </AppShell>
  );
}

/* -------------------------------------------------------- duplicate check */

function DuplicateModal({ nearby, onClose, onSupport, onCreateNew }) {
  return (
    <div className="overlay nested" role="presentation">
      <section className="duplicate-modal" role="dialog" aria-modal="true" data-testid="modal-duplicate-warning">
        <div className="duplicate-icon"><Siren size={22} /></div>
        <p className="eyebrow">Possible duplicate</p>
        <h2>Someone may have already reported this.</h2>
        <p>
          We found {nearby.length === 1 ? "an existing report" : `${nearby.length} existing reports`} within 50 metres in
          the same category. Backing one shows the ward office the full scale of the problem instead of splitting it in two.
        </p>
        <div className="nearby-list">
          {nearby.map((issue) => (
            <div className="nearby" key={issue.id}>
              {issue.photo_url ? <img src={issue.photo_url} alt="" /> : <div className="thumb-empty" style={{ width: 58, height: 46, borderRadius: 3 }}><CloudUpload size={14} /></div>}
              <div>
                <strong>{issue.description}</strong>
                <span>{issueRef(issue)} · {Math.round(issue.distance_meters ?? 0)} m away · {issue.upvotes} backing{issue.upvotes === 1 ? "" : "s"}</span>
              </div>
              <button className="button secondary" onClick={() => onSupport(issue)} data-testid={`button-support-duplicate-${issue.id}`}>
                <ThumbsUp size={13} />Back this one
              </button>
            </div>
          ))}
        </div>
        <div className="duplicate-actions">
          <button className="button secondary" onClick={onClose} data-testid="button-cancel-report">Cancel</button>
          <button className="button amber" onClick={onCreateNew} data-testid="button-create-new-anyway">
            File as a separate issue <ArrowUpRight size={16} />
          </button>
        </div>
      </section>
    </div>
  );
}

/* ----------------------------------------------------------- report flow */

const WIZARD_STEPS = ["Evidence", "Category", "Severity", "Details", "Location"];

function ReportPage() {
  const [, setLocation] = useLocation();
  const [step, setStep] = useState(1);
  const [category, setCategory] = useState("pothole");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState(3);
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [accuracy, setAccuracy] = useState(null);
  const [geoState, setGeoState] = useState("locating");   // locating | ready | blocked | manual | exif
  const [photoName, setPhotoName] = useState("");
  const [photoPreview, setPhotoPreview] = useState("");
  const [mediaFile, setMediaFile] = useState(null);
  const [mediaKind, setMediaKind] = useState("photo");
  const [exifInfo, setExifInfo] = useState(null);
  const [videoFile, setVideoFile] = useState(null);
  const [videoName, setVideoName] = useState("");
  const [videoPreview, setVideoPreview] = useState("");
  const [land, setLand] = useState(null);
  const [acceptPrivate, setAcceptPrivate] = useState(false);
  const [policy, setPolicy] = useState({
    /* Permissive until the server answers. If /policy is unreachable the form would
       otherwise enforce rules the server may not have, and the submit button stays dead
       with nothing on screen explaining why. */
    require_geotag: false, require_video: false, require_public_land: false, max_photo_age_hours: 0
  });
  useEffect(() => { getPolicy().then(setPolicy).catch(() => {}); }, []);
  const [quota, setQuota] = useState(null);
  useEffect(() => { getReportQuota().then(setQuota).catch(() => {}); }, []);
  const [devicePos, setDevicePos] = useState(null);
  const [addressQuery, setAddressQuery] = useState("");
  const [lookupMessage, setLookupMessage] = useState("");
  const [nearby, setNearby] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [toast, setToast] = useToast();

  const setCoordinates = (nextLatitude, nextLongitude) => {
    setLatitude(Number(nextLatitude).toFixed(6));
    setLongitude(Number(nextLongitude).toFixed(6));
  };

  /* Capture the device's position the moment the form opens. */
  const locateMe = (announce = false) => {
    if (!navigator.geolocation) { setGeoState("blocked"); return; }
    setGeoState("locating");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCoordinates(position.coords.latitude, position.coords.longitude);
        setDevicePos([position.coords.latitude, position.coords.longitude]);
        setAccuracy(position.coords.accuracy);
        setGeoState("ready");
        if (announce) setToast("Pin moved to your current location.");
      },
      () => setGeoState("blocked"),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 }
    );
  };
  useEffect(() => { locateMe(); }, []);

  /* Photos may carry a GPS tag. We read it to show where the picture was actually
     taken, but never reject a file for lacking one. */
  const handleMedia = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const isVideo = file.type.startsWith("video/");
    setMediaFile(file);
    setMediaKind(isVideo ? "video" : "photo");
    setPhotoName(file.name);
    setPhotoPreview(URL.createObjectURL(file));
    setExifInfo(null);
    if (isVideo) return;
    try {
      /* Two calls on purpose: exifr's `pick` filters the whole result, so asking for
         the timestamp in the same call as gps silently drops the coordinates. */
      const gps = await exifr.gps(file).catch(() => null);
      const times = await exifr.parse(file, { pick: ["DateTimeOriginal", "CreateDate"] }).catch(() => null);
      const shot = times?.DateTimeOriginal || times?.CreateDate;
      const ageHours = shot ? (Date.now() - new Date(shot).getTime()) / 3600000 : null;
      if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
        const drift = latitude && longitude
          ? metresBetween([Number(latitude), Number(longitude)], [gps.latitude, gps.longitude])
          : null;
        const gap = devicePos ? metresBetween(devicePos, [gps.latitude, gps.longitude]) : null;
        setExifInfo({ hasGps: true, latitude: gps.latitude, longitude: gps.longitude, drift, gap, ageHours });
        setCoordinates(gps.latitude, gps.longitude);   // the camera knows best
        setGeoState("exif");
      } else {
        setExifInfo({ hasGps: false });
      }
    } catch { setExifInfo({ hasGps: false }); }
  };

  const handleVideo = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setVideoFile(file);
    setVideoName(file.name);
    setVideoPreview(URL.createObjectURL(file));
  };

  /* Land-use check, debounced so dragging the pin does not hammer the service. */
  useEffect(() => {
    if (!latitude || !longitude) return undefined;
    let cancelled = false;
    setLand(null);
    setAcceptPrivate(false);
    const timer = window.setTimeout(async () => {
      try {
        const result = await checkLand(Number(latitude), Number(longitude));
        if (!cancelled) setLand(result);
      } catch { /* the server decides at submit time anyway */ }
    }, 700);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [latitude, longitude]);

  const lookupAddress = async () => {
    const query = addressQuery.trim();
    if (query.length < 3) { setLookupMessage("Type at least three characters."); return; }
    setLookupMessage("Searching OpenStreetMap…");
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`
      );
      const results = await response.json();
      if (!results.length) { setLookupMessage("Nothing found. Add the city name and try again."); return; }
      setCoordinates(Number(results[0].lat), Number(results[0].lon));
      setGeoState("manual");
      setLookupMessage(`Located: ${results[0].display_name}`);
    } catch {
      setLookupMessage("Address lookup is unavailable. Drag the pin instead.");
    }
  };

  const submitReport = async (force = false) => {
    if (!description.trim() || submitting) return;
    if (!latitude || !longitude) { setToast("Set a location before filing."); return; }
    /* These mirror what the server enforces, which it tells us in /issues/policy.
       Hardcoding them meant that relaxing REQUIRE_GEOTAG for phone uploads left the
       submit button enabled while this guard silently refused the report. */
    if (!mediaFile) { setToast("A photo of the issue is required."); return; }
    if (!exifInfo?.hasGps) { setToast("This photo has no location tag. A geotagged photo is required."); return; }
    if (policy.require_video && !videoFile) { setToast("A short video is required."); return; }
    setSubmitting(true);
    const location = { latitude: Number(latitude), longitude: Number(longitude) };
    if (!force) {
      const matches = await findNearbyIssues(location.latitude, location.longitude, 50, category);
      if (matches.length) { setNearby(matches.map((issue) => ({ ...issue, distance_meters: distanceInMeters(location, issue) }))); setSubmitting(false); return; }
    }
    await createIssue({ category, description: description.trim(), severity, latitude: location.latitude, longitude: location.longitude, photo_url: photoPreview, photo_file: mediaFile, video_file: videoFile, pinned_by_hand: geoState === "manual", accept_private: acceptPrivate, device_lat: devicePos?.[0], device_lng: devicePos?.[1] });
    setSubmitting(false); setNearby([]); setSubmitted(true);
    window.setTimeout(() => setLocation("/my-reports"), 1800);
  };

  const supportAndGo = async (issue) => { await backIssue(issue.id); setNearby([]); setSubmitting(false); setToast(`You backed ${issueRef(issue)}. No duplicate was filed.`); window.setTimeout(() => setLocation("/map"), 700); };

  /* every rule the submit button enforces, named once so the checklist can show them */
  const photoOk = Boolean(mediaFile) && Boolean(exifInfo?.hasGps);
  const videoOk = !policy.require_video || Boolean(videoFile);
  const descriptionOk = description.trim().length >= 10;
  const landOk = !(land?.land_class === "private" && land?.enforced && !acceptPrivate);
  const driftOk = !(policy.require_geotag && exifInfo?.gap != null && exifInfo.gap > (policy.max_exif_drift_m || 2000));
  const freshOk = !(policy.max_photo_age_hours > 0 && exifInfo?.ageHours != null && exifInfo.ageHours > policy.max_photo_age_hours);
  const quotaOk = !quota || quota.remaining > 0;
  const blocked = !photoOk || !videoOk || !descriptionOk || !landOk || !driftOk || !freshOk || !latitude || !longitude || !quotaOk;

  /* A disabled button with no explanation is the worst possible state, so name the first
     unmet requirement. */
  const blocker =
    !mediaFile ? "Add a photo before filing."
    : !photoOk ? "That photo carries no location tag. Take it with your phone's camera app with location switched on."
    : !videoOk ? "A short video is required."
    : !descriptionOk ? `The description needs at least 10 characters — ${description.trim().length} so far.`
    : !latitude || !longitude ? "Set the location pin."
    : !landOk ? "Confirm that this private-looking location really is public right of way."
    : !driftOk ? "The photo was taken too far from where you are now."
    : !freshOk ? "The photo is older than the allowed limit."
    : !quotaOk ? "You have used your report allowance for today."
    : null;

  const checklist = [
    ["Photo evidence", photoOk, !mediaFile ? null : !photoOk],
    ["Video evidence", videoOk, !videoFile ? null : !videoOk],
    ["Issue category", Boolean(category), null],
    [`Severity rating (${severity}/5)`, Boolean(severity), null],
    [`Description (${description.trim().length}/10)`, descriptionOk, null],
    ["Location pin set", Boolean(latitude && longitude), null],
    ["Photo is recent", freshOk, exifInfo?.ageHours == null ? null : !freshOk],
    ["Public right of way", landOk, land?.land_class !== "private" ? null : !landOk],
    [quota ? `Daily allowance (${quota.remaining}/${quota.limit} left)` : "Daily allowance", quotaOk, !quotaOk],
  ];

  if (submitted) {
    return (
      <AppShell>
        <main className="report-page" data-testid="state-report-submitted">
          <div className="success-state">
            <Check size={38} />
            <h2>Report filed</h2>
            <p>It is on the ward register now, and open for residents to confirm on the ground.</p>
            <Link href="/my-reports" className="button amber">Go to my reports</Link>
          </div>
        </main>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <main className="report-page">
        <div className="report-head">
          <div>
            <p className="eyebrow">New register entry</p>
            <h1>Report a civic issue</h1>
            <p>
              Step {step} of 5 · a geotagged photo and a short clip are both required
              {quota && ` · ${quota.remaining} of ${quota.limit} reports left today`}
            </p>
          </div>
          <Link href="/map" className="report-close" aria-label="Close the report form" data-testid="link-cancel-report">
            <X size={24} />
          </Link>
        </div>

        <div className="stepper">
          {WIZARD_STEPS.map((name, index) => {
            const number = index + 1;
            return (
              <button
                key={name}
                className={step === number ? "active" : step > number ? "complete" : ""}
                onClick={() => setStep(number)}
                data-testid={`button-step-${number}`}
              >
                <b>{step > number ? <Check size={13} /> : number}</b><small>{name}</small>
              </button>
            );
          })}
        </div>

        <div className="report-layout">
          <div className="form-card wizard-card">
            {quota && quota.remaining <= 0 && (
              <div className="quota-note" data-testid="notice-quota-spent">
                <AlertTriangle size={16} />
                <span>
                  <strong>You have used all {quota.limit} reports for today.</strong> The allowance frees up
                  as your earlier reports pass 24 hours old
                  {quota.resets_at ? `, the first at about ${new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit" }).format(new Date(quota.resets_at))}` : ""}.
                  If something needs attention before then, back an existing report on the map instead.
                </span>
              </div>
            )}

            {step === 1 && (
              <section className="wizard-section">
                <h3>Capture photo and video evidence</h3>
                <p>Both are required. A moving clip is far harder to fake than a still, and the photo carries the GPS tag that fixes the location.</p>
                <div className="evidence-grid">
                  <div>
                    <label htmlFor="issue-photo">
                      Photo evidence
                      <em className={mediaFile ? "" : "missing"}>{mediaFile ? "Attached" : "Required"}</em>
                    </label>
                    <div className={`evidence-drop${photoPreview ? " filled" : ""}`}>
                      {photoPreview ? (
                        <>
                          {mediaKind === "video" ? <video src={photoPreview} controls /> : <img src={photoPreview} alt="Selected street evidence preview" />}
                          <span className="evidence-caption">{photoName}</span>
                        </>
                      ) : (
                        <>
                          <ImagePlus size={25} />
                          <strong>Add a photo</strong>
                          <small>Use the phone camera app with location on</small>
                        </>
                      )}
                      <input id="issue-photo" type="file" accept="image/*" onChange={handleMedia} data-testid="input-report-photo" />
                    </div>
                  </div>

                  <div>
                    <label htmlFor="issue-video">
                      Video evidence
                      <em className={videoFile ? "" : policy.require_video ? "missing" : ""}>{videoFile ? "Attached" : policy.require_video ? "Required" : "Optional"}</em>
                    </label>
                    <div className={`evidence-drop${videoPreview ? " filled" : ""}`}>
                      {videoPreview ? (
                        <>
                          <video src={videoPreview} controls />
                          <span className="evidence-caption">{videoName}</span>
                        </>
                      ) : (
                        <>
                          <Video size={25} />
                          <strong>Add a clip</strong>
                          <small>A few seconds is enough</small>
                        </>
                      )}
                      <input id="issue-video" type="file" accept="video/*" onChange={handleVideo} data-testid="input-report-video" />
                    </div>
                  </div>
                </div>

                {exifInfo && (
                  <div className={`geo-tag-note ${exifInfo.hasGps ? "geo-ok" : "geo-bad"}`} data-testid="text-exif-status">
                    {exifInfo.hasGps ? (
                      <>
                        <strong>Location tag found.</strong> The camera recorded{" "}
                        <span className="mono">{exifInfo.latitude.toFixed(5)}, {exifInfo.longitude.toFixed(5)}</span>, and the
                        pin has been moved there. That coordinate is what gets filed.
                        {exifInfo.ageHours !== null && exifInfo.ageHours > 24 && (
                          <div className="mismatch-alert" data-testid="text-photo-stale">
                            <AlertTriangle size={14} />
                            <span>
                              <strong>This photo is {exifInfo.ageHours >= 48 ? `${Math.floor(exifInfo.ageHours / 24)} days` : `${Math.round(exifInfo.ageHours)} hours`} old.</strong>{" "}
                              Reports need a recent picture — the ward office cannot act on something that may
                              already have been fixed. Take a fresh photo of the issue.
                            </span>
                          </div>
                        )}
                        {exifInfo.gap !== null && exifInfo.gap > 2000 && (
                          <div className="mismatch-alert" data-testid="text-exif-mismatch">
                            <AlertTriangle size={14} />
                            <span>
                              <strong>The issue location is not where this photo was taken.</strong> The camera was
                              {" "}{formatKm(exifInfo.gap)} from where you are now. Filing later from home is fine, but
                              the photo has to be from the same area as the report — this one will be refused.
                            </span>
                          </div>
                        )}
                      </>
                    ) : (
                      policy.require_geotag ? (
                        <>
                          <strong>This photo has no location tag, so it cannot be used.</strong> Android strips
                          location from photos picked through a browser, so this often fails on a phone even when
                          the picture does have one. Upload from a computer, or ask an administrator to relax the
                          rule.
                        </>
                      ) : (
                        <>
                          <strong>No location tag on this photo.</strong> That is fine — the report will be filed
                          at the pin on step 5, which came from your device's GPS. Check it is on the right spot
                          before you submit.
                        </>
                      )
                    )}
                  </div>
                )}
              </section>
            )}

            {step === 2 && (
              <section className="wizard-section">
                <h3>Which department should get this?</h3>
                <p>The category decides the squad the ward office dispatches, and it is what the duplicate check compares against.</p>
                <div className="category-grid">
                  {Object.entries(CATEGORY_LABELS).map(([value, label]) => {
                    const Icon = CATEGORY_ICONS[value] || Flag;
                    return (
                      <button
                        key={value}
                        className={`category-choice${category === value ? " selected" : ""}`}
                        onClick={() => setCategory(value)}
                        data-testid={`button-category-${value}`}
                      >
                        <i><Icon size={20} /></i>
                        <span><strong>{label}</strong><small>{CATEGORY_DESK[value]}</small></span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {step === 3 && (
              <section className="wizard-section">
                <h3>How severe is it?</h3>
                <p>Severity contributes ten points per level to the priority score the server calculates. Resident backing adds the rest.</p>
                <div className="severity-options">
                  {SEVERITY_SCALE.map(([value, title, note]) => (
                    <button
                      key={value}
                      className={`severity-choice${severity === value ? " selected" : ""}`}
                      onClick={() => setSeverity(value)}
                      data-testid={`button-severity-${value}`}
                    >
                      <span><strong>Level {value} · {title}</strong><small>{note}</small></span>
                      <b>+{value * 10} pts</b>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {step === 4 && (
              <section className="wizard-section">
                <h3>Describe what you can see</h3>
                <p>Name the landmark, say what is unsafe, and say how long it has been there.</p>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Example: a deep pothole opens across the left lane, about 20 m after the bus stop, and two-wheelers are swerving into traffic to avoid it."
                  data-testid="input-report-description"
                />
                <div className="char-row">
                  <span>Between 10 and 1000 characters</span>
                  <b>{description.trim().length}/1000</b>
                </div>
                <h4>Quick details to append</h4>
                <div className="cue-row">
                  {DESCRIPTION_CUES.map((cue) => (
                    <button key={cue} onClick={() => setDescription(`${description} ${cue}`.trim())} data-testid={`button-cue-${cue.split(" ")[0]}`}>
                      + {cue}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {step === 5 && (
              <section className="wizard-section">
                <h3>Confirm the exact spot</h3>
                <p>The pin comes from your device, or from the photo's own GPS tag. Drag it onto the defect before filing.</p>

                <div className="location-row">
                  <input
                    value={addressQuery}
                    onChange={(event) => setAddressQuery(event.target.value)}
                    placeholder="Search a street or landmark to jump the pin"
                    data-testid="input-report-address-search"
                  />
                  <button type="button" className="button secondary" onClick={lookupAddress} data-testid="button-lookup-address">
                    <Search size={14} />Find
                  </button>
                  <button type="button" className="button secondary" onClick={() => locateMe(true)} data-testid="button-use-my-location">
                    <LocateFixed size={14} />{geoState === "locating" ? "Locating…" : "Use my location"}
                  </button>
                </div>
                <div className="help-text">{lookupMessage || "Searches OpenStreetMap for a street or landmark."}</div>

                <ReportLocationMap
                  latitude={latitude}
                  longitude={longitude}
                  onChange={(nextLat, nextLng) => { setCoordinates(nextLat, nextLng); setGeoState("manual"); }}
                />

                <div className="coordinates">
                  <div>
                    <span>Latitude / longitude</span>
                    <b>
                      <input value={latitude} onChange={(event) => setLatitude(event.target.value)} aria-label="Latitude" data-testid="input-report-latitude" />
                      <input value={longitude} onChange={(event) => setLongitude(event.target.value)} aria-label="Longitude" data-testid="input-report-longitude" />
                    </b>
                  </div>
                  <div>
                    <span>Source and accuracy</span>
                    <b>
                      {geoState === "locating" && "asking the device…"}
                      {geoState === "ready" && `device gps${accuracy ? ` (±${Math.round(accuracy)} m)` : ""}`}
                      {geoState === "exif" && "photo gps tag"}
                      {geoState === "manual" && "placed by hand"}
                      {geoState === "blocked" && "unavailable — drag the pin"}
                    </b>
                  </div>
                  <div>
                    <span>Land classification</span>
                    <b>{land ? (land.land_class || "unknown").replace("_", " ") : "checking…"}</b>
                  </div>
                </div>

                {geoState === "ready" && accuracy > 100 && (
                  <div className="help-text">
                    That is a rough fix — laptops guess from WiFi and IP. Drag the pin onto the real spot before filing.
                  </div>
                )}

                {land && (
                  <div className={`land-note land-${land.land_class}`} data-testid="text-land-class">
                    {land.land_class === "public" && <><ShieldCheck size={14} /><span><strong>Public land.</strong> {land.land_note}</span></>}
                    {land.land_class === "private" && (
                      <>
                        <AlertTriangle size={14} />
                        <span>
                          <strong>This looks like private property.</strong> {land.land_note}{" "}
                          The register covers roads, footpaths, drains and public spaces. Map data is not
                          perfect though — if this really is a public spot, you can file it anyway and the
                          ward office will see that you confirmed it.
                          {acceptPrivate ? (
                            <span className="private-ack" data-testid="text-private-confirmed">
                              <Check size={13} /> Filing anyway. This will be flagged for the ward office.{" "}
                              <button type="button" className="quiet-button" onClick={() => setAcceptPrivate(false)} data-testid="button-undo-private">Undo</button>
                            </span>
                          ) : (
                            <span className="private-choice">
                              <button type="button" className="button secondary" onClick={() => setAcceptPrivate(true)} data-testid="button-continue-private">
                                Yes, continue anyway
                              </button>
                              <button type="button" className="quiet-button" onClick={() => { setGeoState("manual"); setToast("Drag the pin to the public road or footpath."); }} data-testid="button-move-pin">
                                Move the pin instead
                              </button>
                            </span>
                          )}
                        </span>
                      </>
                    )}
                    {land.land_class === "unknown" && <><CircleHelp size={14} /><span>{land.land_note}</span></>}
                  </div>
                )}
              </section>
            )}

            <div className="wizard-actions">
              {step > 1
                ? <button className="button secondary" onClick={() => setStep(step - 1)} data-testid="button-wizard-back">Back</button>
                : <Link href="/map" className="button secondary">Cancel</Link>}
              {step < 5 ? (
                <button className="button amber" onClick={() => setStep(step + 1)} data-testid="button-wizard-next">
                  Next <ArrowRight size={15} />
                </button>
              ) : (
                <button className="button amber" disabled={blocked || submitting} onClick={() => submitReport(false)} data-testid="button-submit-report">
                  {submitting ? "Checking nearby reports…" : "File this report"} <ArrowUpRight size={15} />
                </button>
              )}
            </div>
          </div>

          <aside className="checklist" data-testid="list-evidence-checklist">
            <h3>Filing checklist</h3>
            <ul>
              {checklist.map(([item, done, isBlocked]) => (
                <li key={item} className={done ? "done" : isBlocked ? "blocked" : ""}>
                  <i>{done ? "✓" : isBlocked ? "!" : "•"}</i>{item}
                </li>
              ))}
            </ul>
            <div className="estimated">
              <span>Estimated score</span>
              <strong>{severity * 10}</strong>
              <small>({severity} × 10, before any backing)</small>
            </div>
            <div className="privacy-note">
              <LockKeyhole size={16} />
              <span>Your report is visible to residents in this ward. Your email address is not.</span>
            </div>
          </aside>
        </div>
      </main>

      {nearby.length > 0 && <DuplicateModal nearby={nearby} onClose={() => { setNearby([]); setSubmitting(false); }} onSupport={supportAndGo} onCreateNew={() => submitReport(true)} />}
      {toast && <div className="toast" role="status" data-testid="toast-report">{toast}</div>}
    </AppShell>
  );
}

/* --------------------------------------------------------- my reports */

function ReportCard({ issue, onSelect, testid }) {
  return (
    <button className="report-card" onClick={() => onSelect(issue)} data-testid={testid}>
      <Thumb issue={issue} />
      <div>
        <div className="row-top" style={{ flexDirection: "row", justifyContent: "flex-start" }}>
          <Badge tone={issue.status}>{STATUS_LABELS[issue.status]}</Badge>
          <span>{issueRef(issue)} · {formatShortDate(issue.created_at)}</span>
        </div>
        <h3>{issue.description}</h3>
        <p>{CATEGORY_LABELS[issue.category]} · {issue.upvotes} backing{issue.upvotes === 1 ? "" : "s"} · {communityStanding(issue).label}</p>
      </div>
      <Score score={issue.priority_score} small />
    </button>
  );
}

function MyReportsPage() {
  const { issues, isLoading, error, refresh } = useIssueFeed(true);
  const { issues: allIssues, refresh: refreshAll } = useIssueFeed();
  const [selected, setSelected] = useState(null);
  const [toast, setToast] = useToast();
  const me = useMe();
  const backedIssues = allIssues.filter((issue) => issue.backed_by_me && issue.user_id !== me.id);
  const handleUpvote = async (id) => { await upvoteIssue(id); await Promise.all([refresh(), refreshAll()]); setToast("Your backing has been recorded."); };

  return (
    <AppShell>
      <main className="content-page">
        <div className="page-intro">
          <div>
            <p className="eyebrow">Your activity</p>
            <h1>My reports</h1>
            <p>What you have filed, and what you have backed for other residents.</p>
          </div>
          <Link href="/report" className="button amber" data-testid="link-report-from-my-reports">
            <Plus size={17} /> Report issue
          </Link>
        </div>

        <div className="stat-strip">
          <div><span>Filed by you</span><strong>{issues.length}</strong><small>on the ward register</small></div>
          <div><span>Backed by you</span><strong>{backedIssues.length}</strong><small>other residents' reports</small></div>
          <div><span>Receiving action</span><strong>{issues.filter((issue) => issue.status === "in_progress").length}</strong><small>work is underway</small></div>
          <div><span>Resolved</span><strong className="green">{issues.filter((issue) => issue.status === "resolved").length}</strong><small>closed by the ward office</small></div>
        </div>

        <div className="section-head" style={{ marginBottom: 12 }}>
          <div>
            <h1 style={{ fontSize: 18 }}>Filed by {me.name || "you"}</h1>
            <p className="help-text">Most recent entries first</p>
          </div>
          <button className="filter-button" onClick={() => { refresh(); refreshAll(); }} data-testid="button-refresh-my-reports">
            <Activity size={14} />Refresh
          </button>
        </div>

        {isLoading ? <LoadingPanel rows={3} /> : error ? <ErrorPanel onRetry={refresh} /> : issues.length ? (
          <div className="reports-list">
            {issues.map((issue) => <ReportCard key={issue.id} issue={issue} onSelect={setSelected} testid={`card-my-report-${issue.id}`} />)}
          </div>
        ) : (
          <div className="empty-state" data-testid="state-empty-my-reports">
            <Flag size={28} />
            <strong>No reports yet</strong>
            <p>When you spot something that needs action, it will appear here.</p>
            <Link href="/report" className="button amber" data-testid="link-first-report">File your first report</Link>
          </div>
        )}

        <div className="section-head" style={{ margin: "30px 0 12px" }}>
          <div>
            <h1 style={{ fontSize: 18 }}>Backed by you</h1>
            <p className="help-text">Existing reports you have supported</p>
          </div>
        </div>

        {backedIssues.length ? (
          <div className="reports-list">
            {backedIssues.map((issue) => <ReportCard key={issue.id} issue={issue} onSelect={setSelected} testid={`card-backed-report-${issue.id}`} />)}
          </div>
        ) : (
          <div className="empty-state">
            <ThumbsUp size={26} />
            <strong>No backed reports yet</strong>
            <p>Back a nearby issue from the map to keep it visible here.</p>
            <Link href="/map" className="button secondary">Browse the ward map</Link>
          </div>
        )}
      </main>

      <IssueDetailModal issue={selected} onClose={() => setSelected(null)} onUpvote={handleUpvote} />
      {toast && <div className="toast" role="status" data-testid="toast-my-reports">{toast}</div>}
    </AppShell>
  );
}

/* --------------------------------------------------------- directions */

function DirectionsView({ issue, onClose, onStatus, canSignOff = true }) {
  const mapNode = useRef(null);
  const mapRef = useRef(null);
  useMapAutosize(mapRef, mapNode);
  const lineRef = useRef(null);
  const youRef = useRef(null);
  const lastRoutedRef = useRef(null);
  const [route, setRoute] = useState(null);
  const [state, setState] = useState("locating");   // locating | ready | blocked
  const [follow, setFollow] = useState(false);
  const { position } = useMyPosition(follow);
  const [origin, setOrigin] = useState(null);

  const destination = [Number(issue.latitude), Number(issue.longitude)];

  useEffect(() => {
    if (!navigator.geolocation) { setState("blocked"); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => setOrigin([p.coords.latitude, p.coords.longitude]),
      () => setState("blocked"),
      { enableHighAccuracy: true, timeout: 12000 }
    );
  }, []);

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return undefined;
    const map = L.map(mapNode.current, { zoomControl: false }).setView(destination, 14);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap · routing by OSRM", maxZoom: 19
    }).addTo(map);
    L.marker(destination, { icon: L.divIcon({
      className: `map-pin ${scoreTone(issue.priority_score)}`,
      html: `<span>${issue.priority_score}</span>`,
      iconSize: [38, 38], iconAnchor: [19, 19] }) }).addTo(map).bindTooltip(CATEGORY_LABELS[issue.category]);
    mapRef.current = map;
    const timer = window.setTimeout(() => map.invalidateSize(), 90);
    return () => { window.clearTimeout(timer); map.remove(); mapRef.current = null; };
  }, []);

  /* work out the route, and redo it once we have drifted far enough to matter */
  useEffect(() => {
    const start = follow && position ? position : origin;
    if (!start) return;
    const drift = lastRoutedRef.current ? metresBetween(start, lastRoutedRef.current) : Infinity;
    if (drift < 80 && route) return;
    lastRoutedRef.current = start;
    let cancelled = false;
    routeBetween(start, destination).then((result) => {
      if (cancelled) return;
      setRoute(result);
      setState("ready");
      const map = mapRef.current;
      if (!map) return;
      if (lineRef.current) map.removeLayer(lineRef.current);
      lineRef.current = L.polyline(result.geometry.coordinates.map((c) => [c[1], c[0]]), {
        color: "#10243e", weight: 5, opacity: .85, dashArray: result.approximate ? "8 8" : null
      }).addTo(map);
      map.fitBounds(lineRef.current.getBounds(), { padding: [45, 45] });
    });
    return () => { cancelled = true; };
  }, [origin?.[0], origin?.[1], follow, position?.[0], position?.[1]]);

  useEffect(() => {
    const here = follow ? position : origin;
    if (!mapRef.current || !here) return;
    if (youRef.current) mapRef.current.removeLayer(youRef.current);
    youRef.current = L.marker(here, { icon: youIcon(), zIndexOffset: 700 })
      .bindTooltip("You are here").addTo(mapRef.current);
  }, [origin?.[0], origin?.[1], position?.[0], position?.[1], follow]);

  const steps = route?.legs?.[0]?.steps || [];
  const here = follow && position ? position : origin;
  const remaining = here ? metresBetween(here, destination) : null;
  const mapsUrl = `https://www.google.com/maps/dir/?api=1${here ? `&origin=${here[0]},${here[1]}` : ""}`
    + `&destination=${destination[0]},${destination[1]}&travelmode=driving`;

  return (
    <div className="directions-overlay" role="dialog" aria-modal="true" data-testid="modal-directions">
      <div className="directions-map">
        <div ref={mapNode} data-testid="map-directions" />
        <button className="back-floating" onClick={onClose} data-testid="button-close-directions">
          <ArrowLeft size={17} /> Back to the desk
        </button>
        {route && (
          <div className="route-summary" data-testid="text-route-summary">
            <div>
              <p className="eyebrow">Route to {issueRef(issue)}</p>
              <h2>{formatMins(route.duration)} <span>·</span> {formatKm(route.distance)}</h2>
              <p>Arriving about {new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit" }).format(new Date(Date.now() + route.duration * 1000))}</p>
            </div>
            <div className="route-icon"><Navigation size={20} /></div>
          </div>
        )}
      </div>

      <aside className="directions-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Ward response</p>
            <h2>{CATEGORY_LABELS[issue.category]}</h2>
            <p className="help-text">{issueRef(issue)} · {locationLabel(issue)}</p>
          </div>
          <Score score={issue.priority_score} />
        </div>

        {state === "blocked" && <div className="route-note">Your browser would not share a location, so a route cannot be drawn. Open the issue in a maps app instead.</div>}
        {state === "locating" && <div className="route-note">Finding your position…</div>}
        {route?.approximate && <div className="route-note">Road routing is unreachable, so this is a straight-line estimate at 25 km/h. The distance and bearing are still right.</div>}
        {remaining !== null && remaining < 60 && <div className="route-note arrived"><strong>You have arrived</strong> — within {Math.round(remaining)} m of the reported spot.</div>}

        <div className="route-actions">
          <button type="button" className="button secondary" onClick={() => setFollow(!follow)} data-testid="button-follow-location">
            <Navigation size={14} />{follow ? "Stop following" : "Follow my location"}
          </button>
          <a className="button secondary" href={mapsUrl} target="_blank" rel="noopener noreferrer" data-testid="link-open-maps">
            <ArrowUpRight size={14} />Open in Maps
          </a>
        </div>

        {steps.length > 0 && (
          <ol className="route-steps" data-testid="list-route-steps">
            {steps.map((step, index) => (
              <li key={index}>
                <b>{index + 1}</b>
                <span>
                  <strong>{stepInstruction(step)}</strong>
                  {step.distance > 5 && <small>{formatKm(step.distance)}</small>}
                </span>
              </li>
            ))}
          </ol>
        )}

        <div className="panel-footer">
          {!canSignOff && (
            <div className="route-note">You filed this report, so another administrator has to update its status.</div>
          )}
          {canSignOff && issue.status !== "in_progress" && (
            <button type="button" className="button secondary" onClick={() => onStatus(issue.id, "in_progress")} data-testid="button-route-in-progress">
              Mark in progress
            </button>
          )}
          {canSignOff && issue.status !== "resolved" && (
            <button type="button" className="button amber" onClick={() => onStatus(issue.id, "resolved")} data-testid="button-route-resolved">
              <Check size={16} />Mark resolved
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

/* -------------------------------------------------------------- ward desk */

function AdminPage() {
  const { issues, isLoading, error, refresh } = useIssueFeed();
  const me = useMe();
  const [toast, setToast] = useToast();
  const [adminSearch, setAdminSearch] = useState("");
  const [routing, setRouting] = useState(null);
  const [adminCategory, setAdminCategory] = useState("all");
  const [adminStatus, setAdminStatus] = useState("all");

  const handleStatus = async (id, status) => {
    try {
      await updateIssueStatus(id, status);
      await refresh();
      setToast(`Status updated to ${STATUS_LABELS[status].toLowerCase()}.`);
    } catch (err) {
      setToast(err.message);
    }
  };
  const counts = Object.keys(CATEGORY_LABELS).map((category) => ({ category, count: issues.filter((issue) => issue.category === category).length }));
  const maxCount = Math.max(...counts.map((item) => item.count), 1);
  const filteredIssues = useMemo(() => issues
    .filter((issue) =>
      (adminCategory === "all" || issue.category === adminCategory) &&
      (adminStatus === "all" || issue.status === adminStatus) &&
      `${issue.id} ${issue.description} ${issue.reporter} ${locationLabel(issue)}`.toLowerCase().includes(adminSearch.toLowerCase()))
    .sort((a, b) => b.priority_score - a.priority_score),
    [issues, adminCategory, adminStatus, adminSearch]);

  return (
    <AppShell>
      <main className="content-page admin-page">
        <div className="page-intro">
          <div>
            <p className="eyebrow">Operations</p>
            <h1>Ward priority desk</h1>
            <p>Triage the resident register by priority, then leave a status trail the reporter can see.</p>
          </div>
          <button className="button secondary" onClick={refresh} data-testid="button-refresh-admin">
            <Activity size={15} />Refresh register
          </button>
        </div>

        <div className="stat-strip">
          <div><span>Open workload</span><strong>{issues.filter((issue) => issue.status !== "resolved").length}</strong><small>needing ward attention</small></div>
          <div><span>Pending review</span><strong>{issues.filter((issue) => issue.status === "pending").length}</strong><small>new resident entries</small></div>
          <div><span>In progress</span><strong>{issues.filter((issue) => issue.status === "in_progress").length}</strong><small>with an active action</small></div>
          <div><span>Resolved</span><strong className="green">{issues.filter((issue) => issue.status === "resolved").length}</strong><small>closed on the register</small></div>
        </div>

        <div className="admin-grid">
          <div className="table-card">
            <div className="table-toolbar">
              <div className="search-input">
                <Search size={17} />
                <input value={adminSearch} onChange={(event) => setAdminSearch(event.target.value)} placeholder="Search ID, reporter or place" data-testid="input-admin-search" />
              </div>
              <select className="filter-select" value={adminCategory} onChange={(event) => setAdminCategory(event.target.value)} data-testid="select-admin-category">
                <option value="all">All categories</option>
                {Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select className="filter-select" value={adminStatus} onChange={(event) => setAdminStatus(event.target.value)} data-testid="select-admin-status">
                <option value="all">All statuses</option>
                {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>

            {isLoading ? <LoadingPanel rows={5} /> : error ? <ErrorPanel onRetry={refresh} /> : filteredIssues.length ? (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Report</th><th>Category</th><th>Priority</th><th>Filed</th>
                      <th>Evidence</th><th>Verification</th><th>Status</th><th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredIssues.map((issue) => {
                      const standing = communityStanding(issue);
                      return (
                        <tr key={issue.id} data-testid={`row-issue-${issue.id}`}>
                          <td>
                            <div className="table-report">
                              <Thumb issue={issue} />
                              <div>
                                <strong>{issueRef(issue)}</strong>
                                <span>{issue.description}</span>
                              </div>
                            </div>
                          </td>
                          <td>{CATEGORY_LABELS[issue.category]}<br /><span className="help-text">{locationLabel(issue)}</span></td>
                          <td><Score score={issue.priority_score} small /></td>
                          <td>{formatDate(issue.created_at)}<br /><span className="help-text">{issue.reporter}</span></td>
                          <td>
                            {issue.geo_source === "exif" && <div className="prov-tag prov-good" data-testid={`prov-exif-${issue.id}`}>photo GPS</div>}
                            {issue.land_class === "private" && <div className="prov-tag prov-bad" title={issue.private_ack ? "The reporter was warned and filed anyway" : ""}>private land{issue.private_ack ? " · confirmed" : ""}</div>}
                            {issue.land_class === "public" && <div className="prov-tag prov-good">public land</div>}
                            {issue.video_url && <div className="prov-tag">video</div>}
                          </td>
                          <td>
                            {standing.key === "unchecked" ? <span className="help-text">not checked yet</span> : (
                              <div className={`trust-inline trust-${standing.key}`} data-testid={`trust-cell-${issue.id}`}>
                                <strong>{standing.key === "verified" ? "✓ Verified" : standing.key === "disputed" ? "Disputed" : `${standing.confirmed}/${VERIFIED_AT}`}</strong>
                                <span>{standing.confirmed} yes · {standing.disputed} no</span>
                              </div>
                            )}
                          </td>
                          <td>
                            <select
                              value={issue.status}
                              disabled={me.id != null && issue.user_id === me.id}
                              title={me.id != null && issue.user_id === me.id ? "You filed this report, so another administrator has to update its status." : undefined}
                              onChange={(event) => handleStatus(issue.id, event.target.value)}
                              data-testid={`select-status-${issue.id}`}
                            >
                              <option value="pending">Pending review</option>
                              <option value="in_progress">In progress</option>
                              <option value="resolved">Resolved</option>
                            </select>
                            {me.id != null && issue.user_id === me.id && <span className="help-text">your report</span>}
                          </td>
                          <td>
                            <button type="button" className="action-link" onClick={() => setRouting(issue)} data-testid={`button-route-${issue.id}`}>
                              <Navigation size={15} />Directions
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-state" data-testid="state-empty-admin">
                <Search size={26} />
                <strong>No matching register entries</strong>
                <p>Adjust the search or filters to widen the triage view.</p>
              </div>
            )}
          </div>

          <aside className="side-card">
            <div className="panel-heading">
              <div><p className="eyebrow">Register shape</p><h2>Reports by category</h2></div>
              <SlidersHorizontal size={16} color="var(--muted)" />
            </div>
            <div className="bar-list">
              {counts.map(({ category, count }) => (
                <div className="bar-item" key={category}>
                  <span>{CATEGORY_LABELS[category]}</span>
                  <div className="bar-track"><div className="bar-fill" style={{ width: `${(count / maxCount) * 100}%` }} /></div>
                  <strong>{count}</strong>
                </div>
              ))}
            </div>
            <div style={{ borderTop: "1px solid var(--line)", padding: "14px 0" }}>
              <p className="eyebrow" style={{ padding: "0 20px" }}>Service signal</p>
              <div className="metric-row"><span>Average priority</span><strong>{issues.length ? Math.round(issues.reduce((sum, issue) => sum + issue.priority_score, 0) / issues.length) : 0}</strong></div>
              <div className="metric-row"><span>Resident backing</span><strong>{issues.reduce((sum, issue) => sum + issue.upvotes, 0)}</strong></div>
              <div className="metric-row"><span>Resolution rate</span><strong>{issues.length ? `${Math.round((issues.filter((issue) => issue.status === "resolved").length / issues.length) * 100)}%` : "0%"}</strong></div>
            </div>
          </aside>
        </div>
      </main>

      {toast && <div className="toast" role="status" data-testid="toast-admin">{toast}</div>}
      {routing && (
        <DirectionsView
          issue={routing}
          canSignOff={!(me.id != null && routing.user_id === me.id)}
          onClose={() => setRouting(null)}
          onStatus={async (id, status) => { await handleStatus(id, status); setRouting(null); }}
        />
      )}
    </AppShell>
  );
}

/* -------------------------------------------------------------- sign in */

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

/* Google renders this button itself, from a script we load once. Without a client
   id configured the whole thing is skipped, so nothing breaks on a fresh clone. */
function GoogleButton({ onCredential, onError }) {
  const holder = useRef(null);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || !holder.current) return undefined;
    let cancelled = false;

    const render = () => {
      if (cancelled || !window.google?.accounts?.id) return;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (response) => onCredential(response.credential)
      });
      window.google.accounts.id.renderButton(holder.current, {
        theme: "outline", size: "large", width: 320, text: "continue_with", shape: "rectangular"
      });
    };

    if (window.google?.accounts?.id) { render(); return undefined; }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = render;
    script.onerror = () => onError?.("Google sign-in could not load. Use an email and password.");
    document.head.appendChild(script);
    return () => { cancelled = true; };
  }, []);

  if (!GOOGLE_CLIENT_ID) return null;
  return (
    <div className="google-block">
      <div ref={holder} className="google-button" data-testid="button-google-signin" />
      <div className="auth-divider"><span>or use an email address</span></div>
    </div>
  );
}

function AuthPage() {
  const [, setLocation] = useLocation();
  const [mode, setMode] = useState("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    if (!email || !password || (mode === "register" && !name)) { setError("Fill in the fields above to continue."); return; }
    setBusy(true); setError("");
    try {
      await (mode === "signin"
        ? signIn({ email, password })
        : register({ name, email, password }));
      setLocation("/map");
    } catch (err) {
      setError(err.message || "Could not sign you in.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <section className="auth-aside">
        <Brand tagline="Ward action register" href={null} />
        <div className="auth-kicker">Public infrastructure, made legible</div>
        <h1>Small reports.<br /><em>Visible action.</em></h1>
        <p>CivicFix connects a resident’s street view to the ward office responsible for fixing it, and keeps the status trail in the open.</p>
        <div className="auth-footer">A shared register of street-level issues</div>
      </section>

      <section className="auth-form-side">
        <div className="auth-card">
          <p className="eyebrow">Resident access</p>
          <GoogleButton
            onError={setError}
            onCredential={async (credential) => {
              setBusy(true); setError("");
              try { await signInWithGoogle(credential); setLocation("/map"); }
              catch (err) { setError(err.message || "Google sign-in failed."); }
              finally { setBusy(false); }
            }}
          />
          <h2>{mode === "signin" ? "Welcome back." : "Create your account."}</h2>
          <p>{mode === "signin"
            ? "Sign in to follow reports and back the issues your street needs fixed."
            : "Create a local account to file reports and keep a visible record of action."}</p>

          <div className="auth-tabs">
            <button className={`auth-tab${mode === "signin" ? " active" : ""}`} onClick={() => { setMode("signin"); setError(""); }} data-testid="button-auth-signin">Sign in</button>
            <button className={`auth-tab${mode === "register" ? " active" : ""}`} onClick={() => { setMode("register"); setError(""); }} data-testid="button-auth-register">Create account</button>
          </div>

          <form className="auth-form" onSubmit={submit}>
            {mode === "register" && (
              <div className="field">
                <label htmlFor="auth-name">Full name</label>
                <input id="auth-name" className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Your full name" data-testid="input-auth-name" />
              </div>
            )}
            <div className="field">
              <label htmlFor="auth-email">Email address</label>
              <input id="auth-email" className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" data-testid="input-auth-email" />
            </div>
            <div className="field">
              <label htmlFor="auth-password">Password</label>
              <input id="auth-password" className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" data-testid="input-auth-password" />
            </div>
            {error && <div className="auth-note" role="alert" data-testid="status-auth-error">{error}</div>}
            <button type="submit" className="button amber" disabled={busy} data-testid="button-submit-auth">
              {busy ? "Opening your register…" : mode === "signin" ? "Sign in to CivicFix" : "Create resident account"}
              <ArrowRight size={15} />
            </button>
          </form>

          <p className="auth-legal">By continuing, you agree that reports are visible to other residents nearby.</p>
        </div>
      </section>
    </div>
  );
}

/* --------------------------------------------------------------- routing */

function RedirectMap() {
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation("/map"); }, [setLocation]);
  return (
    <div className="loading-stack" style={{ minHeight: "100dvh" }}>
      <div className="skeleton" style={{ width: 170, height: 28 }} />
      <div className="skeleton" style={{ width: "70%", height: 100 }} />
    </div>
  );
}

function NotFoundPage() {
  return (
    <div className="empty-state" style={{ minHeight: "100dvh" }}>
      <CircleHelp size={32} />
      <strong>That page is not in the register.</strong>
      <p>Return to the issue map to continue.</p>
      <Link href="/map" className="button amber" data-testid="link-not-found-map">Open issue map</Link>
    </div>
  );
}

function Protected({ component: Component }) {
  const [, setLocation] = useLocation();
  const [allowed, setAllowed] = useState(isAuthed());

  useEffect(() => { if (!allowed) setLocation("/auth"); }, [allowed, setLocation]);

  /* api.js fires this the moment the server rejects a token, so an expired session
     lands on the sign-in page instead of leaving blank panels behind. */
  useEffect(() => {
    const onSignedOut = () => { setAllowed(false); setLocation("/auth"); };
    window.addEventListener("civicfix:signed-out", onSignedOut);
    return () => window.removeEventListener("civicfix:signed-out", onSignedOut);
  }, [setLocation]);

  if (!allowed) return null;
  return <Component />;
}

function SignOutPage() {
  const [, setLocation] = useLocation();
  useEffect(() => { signOut(); setLocation("/auth"); }, [setLocation]);
  return null;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={RedirectMap} />
      <Route path="/auth" component={AuthPage} />
      <Route path="/sign-out" component={SignOutPage} />
      <Route path="/map">{() => <Protected component={MapPage} />}</Route>
      <Route path="/report">{() => <Protected component={ReportPage} />}</Route>
      <Route path="/my-reports">{() => <Protected component={MyReportsPage} />}</Route>
      <Route path="/admin">{() => <Protected component={AdminPage} />}</Route>
      <Route component={NotFoundPage} />
    </Switch>
  );
}

export default function App() {
  return <Router />;
}
