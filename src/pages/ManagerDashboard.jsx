import { useState, useEffect, useMemo, useRef } from "react";
import { loadRateCard, saveRateCard, loadManagerMeta, saveManagerMeta } from "../services/projectStorage";
import { jsPDF } from "jspdf";
import * as XLSX from "xlsx";

// ─── Constants ────────────────────────────────────────────────────────────────
const BUILTIN_CLASSES = ["Internal_Wall", "External_Wall", "zone", "door", "window"];
const BUILTIN_COLORS = {
  Internal_Wall: "#00B050", External_Wall: "#0070C0",
  zone: "#C00000", door: "#7030A0", window: "#ED7D31",
};
const DEFAULT_COST_TYPES = {
  Internal_Wall: "$/m", External_Wall: "$/m",
  zone: "$/m²", door: "$/unit", window: "$/unit",
};
const COST_TYPES = ["$/m", "$/m²", "$/unit"];
const CHART_COLORS = [
  "#1e6fff","#00c07a","#ff5a5a","#c0a840","#a060e0",
  "#00b8d0","#ff8a30","#60d060","#e060a0","#40a0e0",
  "#d08000","#7040c0","#00d0a0","#ff6060","#80b020",
];
const STATUS_COLORS = {
  Draft:         { bg: "#111827", color: "#5a7a9a", border: "#1c2540" },
  "In Progress": { bg: "#0a2015", color: "#3aaa6a", border: "#0f3a25" },
  Complete:      { bg: "#0f2010", color: "#5acc70", border: "#1a4020" },
  Reviewed:      { bg: "#1a1030", color: "#9a70e0", border: "#2a1850" },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n == null || isNaN(n)) return "—";
  return n.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtCost(n) {
  if (n == null || isNaN(n) || n === 0) return "—";
  return "$" + n.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// Merge org rates with per-project overrides, return effective rate map
function effectiveRates(orgRates, projectOverrides) {
  if (!orgRates) return null;
  const merged = {};
  for (const cls of Object.keys(orgRates)) {
    merged[cls] = projectOverrides?.[cls] || orgRates[cls];
  }
  // Also include any classes only in overrides
  if (projectOverrides) {
    for (const cls of Object.keys(projectOverrides)) {
      if (!merged[cls]) merged[cls] = projectOverrides[cls];
    }
  }
  return merged;
}

function calcProjectCost(project, orgRates, projectOverrides) {
  const rates = effectiveRates(orgRates, projectOverrides);
  if (!rates) return null;
  let total = 0; let hasAny = false;
  const c = project.counts;
  // Use actual measurements when available, fall back to counts
  const wallLen = project.totalWallLengthM;
  const zoneArea = project.totalZoneAreaM2;
  if (wallLen != null) {
    // Split evenly between internal/external
    ["Internal_Wall", "External_Wall"].forEach(cls => {
      if (rates[cls]?.rate > 0) { total += (wallLen / 2) * rates[cls].rate; hasAny = true; }
    });
  } else if (c?.walls != null) {
    ["Internal_Wall", "External_Wall"].forEach(cls => {
      if (rates[cls]?.rate > 0) { total += (c.walls / 2) * rates[cls].rate; hasAny = true; }
    });
  }
  if (zoneArea != null && rates.zone?.rate > 0)   { total += zoneArea * rates.zone.rate;   hasAny = true; }
  else if (c?.zones != null && rates.zone?.rate > 0) { total += c.zones * rates.zone.rate; hasAny = true; }
  if (c?.doors != null && rates.door?.rate > 0)   { total += c.doors   * rates.door.rate;   hasAny = true; }
  if (c?.windows != null && rates.window?.rate > 0) { total += c.windows * rates.window.rate; hasAny = true; }
  // Custom classes — use stored measurements keyed by class name
  const cm = project.customMeasurements || {};
  for (const [cls, val] of Object.entries(cm)) {
    if (rates[cls]?.rate > 0 && val > 0) { total += val * rates[cls].rate; hasAny = true; }
  }
  return hasAny ? total : null;
}

// ─── Donut Chart ──────────────────────────────────────────────────────────────
function polarToCartesian(cx, cy, r, angle) {
  return { x: cx + r * Math.cos(angle - Math.PI / 2), y: cy + r * Math.sin(angle - Math.PI / 2) };
}
function arcPath(cx, cy, R, r, a0, a1) {
  const s0 = polarToCartesian(cx, cy, R, a0), e0 = polarToCartesian(cx, cy, R, a1);
  const s1 = polarToCartesian(cx, cy, r, a0), e1 = polarToCartesian(cx, cy, r, a1);
  const lg = a1 - a0 > Math.PI ? 1 : 0;
  return `M${s0.x} ${s0.y} A${R} ${R} 0 ${lg} 1 ${e0.x} ${e0.y} L${e1.x} ${e1.y} A${r} ${r} 0 ${lg} 0 ${s1.x} ${s1.y}Z`;
}

function DonutChart({ projects, orgRates, projectOverrides }) {
  const [hovered, setHovered] = useState(null);
  const data = useMemo(() => {
    return projects
      .map((p, i) => ({
        id: p.id, name: p.name,
        cost: calcProjectCost(p, orgRates, projectOverrides?.[p.id]),
        color: CHART_COLORS[i % CHART_COLORS.length],
      }))
      .filter(d => d.cost != null && d.cost > 0);
  }, [projects, orgRates, projectOverrides]);

  const total = data.reduce((s, d) => s + d.cost, 0);
  if (!total || data.length === 0) return (
    <div style={{ width: 220, height: 220, display: "flex", alignItems: "center", justifyContent: "center", color: "#3a4a6a", fontSize: 12, fontStyle: "italic", textAlign: "center" }}>
      Set rate card to<br />see cost breakdown
    </div>
  );

  // Build arcs
  let cumAngle = 0;
  const slices = data.map(d => {
    const start = cumAngle;
    const span = (d.cost / total) * 2 * Math.PI;
    cumAngle += span;
    return { ...d, start, end: cumAngle, span };
  });

  const cx = 110, cy = 110, R = 90, r = 58;

  return (
    <div style={{ display: "flex", gap: 24, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ position: "relative", flexShrink: 0 }}>
        <svg width={220} height={220} viewBox="0 0 220 220">
          {slices.map((s, i) => (
            <path
              key={s.id}
              d={arcPath(cx, cy, R, r, s.start, s.end)}
              fill={s.color}
              opacity={hovered === null || hovered === i ? 1 : 0.35}
              style={{ cursor: "pointer", transition: "opacity 0.15s" }}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            />
          ))}
          {/* Center text */}
          <text x={cx} y={cy - 8} textAnchor="middle" fill="#c8d0e0" fontSize={11} fontFamily="IBM Plex Mono, monospace">TOTAL</text>
          <text x={cx} y={cy + 10} textAnchor="middle" fill="#c0a840" fontSize={14} fontWeight="bold" fontFamily="IBM Plex Mono, monospace">
            {fmtCost(total)}
          </text>
          {hovered !== null && slices[hovered] && (
            <>
              <text x={cx} y={cy + 30} textAnchor="middle" fill="#a0b0c0" fontSize={9} fontFamily="IBM Plex Sans, sans-serif">
                {slices[hovered].name.length > 18 ? slices[hovered].name.slice(0, 16) + "…" : slices[hovered].name}
              </text>
              <text x={cx} y={cy + 44} textAnchor="middle" fill={slices[hovered].color} fontSize={11} fontWeight="bold" fontFamily="IBM Plex Mono, monospace">
                {fmtCost(slices[hovered].cost)}
              </text>
            </>
          )}
        </svg>
      </div>
      {/* Legend */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 200, overflowY: "auto", flexShrink: 0, maxWidth: 200 }}>
        {slices.map((s, i) => (
          <div
            key={s.id}
            style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", opacity: hovered === null || hovered === i ? 1 : 0.4, transition: "opacity 0.15s" }}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          >
            <div style={{ width: 10, height: 10, borderRadius: 2, background: s.color, flexShrink: 0 }} />
            <span style={{ fontSize: 10, color: "#8a9aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 120 }}>{s.name}</span>
            <span style={{ fontSize: 10, color: s.color, fontFamily: "IBM Plex Mono, monospace", marginLeft: "auto", flexShrink: 0 }}>
              {((s.cost / total) * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────
function KpiCard({ icon, label, value, accent, sub }) {
  return (
    <div style={{
      flex: 1, minWidth: 150,
      background: "linear-gradient(135deg, #0e1422 0%, #111827 100%)",
      border: `1px solid #1c2540`, borderLeft: `3px solid ${accent}`,
      borderRadius: 8, padding: "16px 18px",
      display: "flex", flexDirection: "column", gap: 4,
      transition: "transform 0.15s, box-shadow 0.15s", cursor: "default",
    }}
    onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 6px 24px rgba(0,0,0,0.4)"; }}
    onMouseLeave={e => { e.currentTarget.style.transform = ""; e.currentTarget.style.boxShadow = ""; }}
    >
      <div style={{ fontSize: 18 }}>{icon}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: "#c8d0e0", fontFamily: "IBM Plex Mono, monospace", lineHeight: 1.2 }}>{value}</div>
      <div style={{ fontSize: 10, color: "#6a7a9a", letterSpacing: 1, textTransform: "uppercase" }}>{label}</div>
      {sub && <div style={{ fontSize: 9, color: "#3a4a6a", marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// ─── Rate Card / Override Panel (shared) ─────────────────────────────────────
function RatePanel({ open, onClose, title, subtitle, allClasses, baseRates, initialOverrides, onSave, saving }) {
  const [local, setLocal] = useState({});

  useEffect(() => {
    if (!open) return;
    const init = {};
    allClasses.forEach(({ name }) => {
      // Override panel: pre-fill with override if set, else empty (show placeholder = org rate)
      // Rate card panel: pre-fill with saved org rate
      init[name] = {
        costType: initialOverrides?.[name]?.costType || baseRates?.[name]?.costType || DEFAULT_COST_TYPES[name] || "$/unit",
        rate: initialOverrides?.[name]?.rate ?? (title === "RATE CARD" ? (baseRates?.[name]?.rate ?? 0) : ""),
        overridden: !!initialOverrides?.[name],
      };
    });
    setLocal(init);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (cls, field, val) =>
    setLocal(prev => ({ ...prev, [cls]: { ...prev[cls], [field]: val, overridden: true } }));

  const clearOverride = (cls) =>
    setLocal(prev => ({ ...prev, [cls]: { ...prev[cls], rate: "", overridden: false } }));

  const isOverride = title !== "RATE CARD";

  return (
    <>
      {open && <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 200 }} />}
      <div style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: 380,
        background: "#0e1422", borderLeft: "1px solid #1c2540",
        zIndex: 201, display: "flex", flexDirection: "column",
        transform: open ? "translateX(0)" : "translateX(100%)",
        transition: "transform 0.25s cubic-bezier(0.4,0,0.2,1)",
        boxShadow: open ? "-8px 0 40px rgba(0,0,0,0.5)" : "none",
      }}>
        <div style={{ padding: "20px 24px 14px", borderBottom: "1px solid #1c2540", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontFamily: "IBM Plex Mono, monospace", fontWeight: 700, fontSize: 12, letterSpacing: 2, color: "#c8a840" }}>{title}</div>
            {subtitle && <div style={{ fontSize: 10, color: "#4a6a7a", marginTop: 4, maxWidth: 270 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#6a7a9a", fontSize: 18, cursor: "pointer", padding: "2px 6px" }}>✕</button>
        </div>

        <div style={{ display: "flex", gap: 8, padding: "8px 24px 6px", borderBottom: "1px solid #0d1220" }}>
          <div style={{ flex: 1, fontSize: 10, color: "#3a4a6a", letterSpacing: 1, textTransform: "uppercase" }}>Class</div>
          <div style={{ width: 86, fontSize: 10, color: "#3a4a6a", letterSpacing: 1, textTransform: "uppercase" }}>Type</div>
          <div style={{ width: 72, fontSize: 10, color: "#3a4a6a", letterSpacing: 1, textTransform: "uppercase", textAlign: "right" }}>Rate ($)</div>
          {isOverride && <div style={{ width: 24 }} />}
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
          {allClasses.map(({ name, color, isCustom }) => {
            const row = local[name] || {};
            const orgRate = baseRates?.[name]?.rate;
            const hasOverride = isOverride && row.overridden && row.rate !== "";
            return (
              <div key={name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 24px", borderBottom: "1px solid #0a1018", background: hasOverride ? "rgba(200,168,64,0.05)" : "transparent" }}>
                <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                  <div style={{ width: 9, height: 9, borderRadius: 2, background: color, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: hasOverride ? "#c8a840" : "#9aaabb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                  {isCustom && <span style={{ fontSize: 9, color: "#3a5a6a", border: "1px solid #1a3a4a", borderRadius: 3, padding: "0 3px", flexShrink: 0 }}>{allClasses.find(c=>c.name===name)?.measureType || "unit"}</span>}
                </div>
                <select
                  value={row.costType || "$/unit"}
                  onChange={e => set(name, "costType", e.target.value)}
                  style={{ width: 86, background: "#0d1220", border: `1px solid ${hasOverride ? "#6a5820" : "#1a2540"}`, color: "#7a9aaa", fontSize: 11, padding: "3px 4px", borderRadius: 4, fontFamily: "IBM Plex Mono, monospace" }}
                >
                  {COST_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <input
                  type="number" min="0" step="0.01"
                  value={row.rate ?? ""}
                  placeholder={isOverride && orgRate != null ? String(orgRate) : "0"}
                  onChange={e => set(name, "rate", e.target.value === "" ? "" : parseFloat(e.target.value) || 0)}
                  style={{ width: 72, background: "#0d1220", border: `1px solid ${hasOverride ? "#6a5820" : "#1a2540"}`, color: hasOverride ? "#c8a840" : "#c8d0e0", fontSize: 11, padding: "3px 6px", borderRadius: 4, fontFamily: "IBM Plex Mono, monospace", textAlign: "right" }}
                />
                {isOverride && (
                  <button
                    onClick={() => clearOverride(name)}
                    title="Reset to org rate"
                    style={{ width: 20, height: 20, background: "none", border: "none", color: hasOverride ? "#c8a840" : "#2a3a5a", cursor: "pointer", fontSize: 12, padding: 0, lineHeight: 1 }}
                  >✕</button>
                )}
              </div>
            );
          })}
        </div>

        {isOverride && (
          <div style={{ padding: "8px 24px 2px", fontSize: 10, color: "#3a5a6a", fontStyle: "italic" }}>
            Leave rate empty to use org default. Highlighted rows are overridden.
          </div>
        )}

        <div style={{ padding: "14px 24px", borderTop: "1px solid #1c2540", display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ background: "none", border: "1px solid #1c2540", color: "#6a7a9a", padding: "7px 16px", borderRadius: 5, cursor: "pointer", fontSize: 12 }}>Cancel</button>
          <button
            onClick={() => {
              // Collect only overridden entries for override panel; all entries for rate card
              const result = {};
              allClasses.forEach(({ name }) => {
                const row = local[name] || {};
                if (!isOverride || (row.overridden && row.rate !== "")) {
                  result[name] = { costType: row.costType || "$/unit", rate: parseFloat(row.rate) || 0 };
                }
              });
              onSave(result);
            }}
            disabled={saving}
            style={{ background: saving ? "#0a1e3a" : "#1e3a8a", border: "1px solid #2a5aaa", color: saving ? "#4a7abb" : "#90c0ff", padding: "7px 20px", borderRadius: 5, cursor: saving ? "default" : "pointer", fontSize: 12, fontWeight: 600 }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Projects Table ───────────────────────────────────────────────────────────
function ProjectsTable({ projects, orgRates, projectOverrides, projectStatuses, onOpen, onToggleComplete, onOpenOverride, sortKey, sortDir, onSort }) {
  const thS = (key) => ({
    padding: "10px 12px", textAlign: "left", fontSize: 10, fontWeight: 700,
    color: sortKey === key ? "#4aaeff" : "#4a5a7a", letterSpacing: 1,
    textTransform: "uppercase", cursor: "pointer", userSelect: "none",
    background: "#0c1018", borderBottom: "1px solid #1c2540", whiteSpace: "nowrap",
  });
  const arrow = key => sortKey === key ? (sortDir === -1 ? " ↓" : " ↑") : "";

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={thS("name")} onClick={() => onSort("name")}>Project{arrow("name")}</th>
            <th style={{ ...thS(null), cursor: "default" }}>Owner</th>
            <th style={{ ...thS(null), cursor: "default", textAlign: "center" }}>Pgs</th>
            <th style={thS("walls")} onClick={() => onSort("walls")}>Wall Len (m){arrow("walls")}</th>
            <th style={thS("zones")} onClick={() => onSort("zones")}>Zone Area (m²){arrow("zones")}</th>
            <th style={{ ...thS(null), cursor: "default", textAlign: "center" }}>Doors</th>
            <th style={{ ...thS(null), cursor: "default", textAlign: "center" }}>Win</th>
            <th style={thS("cost")} onClick={() => onSort("cost")}>Est. Cost{arrow("cost")}</th>
            <th style={thS("lastEdited")} onClick={() => onSort("lastEdited")}>Edited{arrow("lastEdited")}</th>
            <th style={{ ...thS(null), cursor: "default" }}>Status</th>
            <th style={{ ...thS(null), cursor: "default", textAlign: "center" }}>⚙</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project, i) => {
            const cost = calcProjectCost(project, orgRates, projectOverrides?.[project.id]);
            const hasOverride = !!(projectOverrides?.[project.id] && Object.keys(projectOverrides[project.id]).length > 0);
            const status = projectStatuses?.[project.id] || project.status || "Draft";
            const statusStyle = STATUS_COLORS[status] || STATUS_COLORS.Draft;
            const isComplete = status === "Complete";
            return (
              <tr
                key={project.id}
                style={{ background: i % 2 === 0 ? "#0b0f1a" : "#0d1220", transition: "background 0.1s" }}
                onMouseEnter={e => e.currentTarget.style.background = "#111827"}
                onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? "#0b0f1a" : "#0d1220"}
              >
                <td style={{ padding: "10px 12px", fontSize: 13, color: "#c8d0e0", fontWeight: 500, borderBottom: "1px solid #0d1220", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {project.name}
                </td>
                <td style={{ padding: "10px 12px", fontSize: 11, color: "#5a7a8a", borderBottom: "1px solid #0d1220", maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {project.owner || "—"}
                </td>
                <td style={{ padding: "10px 12px", fontSize: 11, color: "#4a6a8a", borderBottom: "1px solid #0d1220", textAlign: "center" }}>
                  {project.pageCount || 1}
                </td>
                <td style={{ padding: "10px 12px", fontSize: 12, color: "#50a070", borderBottom: "1px solid #0d1220", textAlign: "center", fontFamily: "IBM Plex Mono, monospace" }}>
                  {project.totalWallLengthM != null ? `${project.totalWallLengthM.toFixed(1)} m` : (project.counts?.walls != null ? `${project.counts.walls} ✕` : "—")}
                </td>
                <td style={{ padding: "10px 12px", fontSize: 12, color: "#cc5555", borderBottom: "1px solid #0d1220", textAlign: "center", fontFamily: "IBM Plex Mono, monospace" }}>
                  {project.totalZoneAreaM2 != null ? `${project.totalZoneAreaM2.toFixed(1)} m²` : (project.counts?.zones != null ? `${project.counts.zones} ✕` : "—")}
                </td>
                <td style={{ padding: "10px 12px", fontSize: 12, color: "#8050bb", borderBottom: "1px solid #0d1220", textAlign: "center", fontFamily: "IBM Plex Mono, monospace" }}>
                  {project.counts?.doors ?? "—"}
                </td>
                <td style={{ padding: "10px 12px", fontSize: 12, color: "#c06820", borderBottom: "1px solid #0d1220", textAlign: "center", fontFamily: "IBM Plex Mono, monospace" }}>
                  {project.counts?.windows ?? "—"}
                </td>
                <td style={{ padding: "10px 12px", fontSize: 13, color: cost != null ? "#c0a840" : "#2a3a5a", borderBottom: "1px solid #0d1220", fontFamily: "IBM Plex Mono, monospace", fontWeight: cost ? 600 : 400, whiteSpace: "nowrap" }}>
                  {fmtCost(cost)}
                  {hasOverride && <span title="Custom rates applied" style={{ marginLeft: 5, fontSize: 9, color: "#c8a840", verticalAlign: "middle" }}>★</span>}
                </td>
                <td style={{ padding: "10px 12px", fontSize: 11, color: "#4a6a7a", borderBottom: "1px solid #0d1220", whiteSpace: "nowrap" }}>
                  {fmtDate(project.lastEdited)}
                </td>
                <td style={{ padding: "10px 12px", borderBottom: "1px solid #0d1220" }}>
                  <span style={{ fontSize: 10, fontWeight: 600, padding: "3px 7px", borderRadius: 4, background: statusStyle.bg, color: statusStyle.color, border: `1px solid ${statusStyle.border}`, whiteSpace: "nowrap" }}>
                    {status}
                  </span>
                </td>
                <td style={{ padding: "10px 8px", borderBottom: "1px solid #0d1220", whiteSpace: "nowrap" }}>
                  <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                    <button onClick={() => onOpen(project)} style={{ background: "#0f1e3a", border: "1px solid #1e3a6a", color: "#5090c0", padding: "4px 10px", borderRadius: 4, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>Open</button>
                    <button onClick={() => onOpenOverride(project)} title="Override rates for this project" style={{ background: hasOverride ? "#1a1500" : "#0a0f18", border: `1px solid ${hasOverride ? "#5a4010" : "#1a2030"}`, color: hasOverride ? "#c8a840" : "#3a5a7a", padding: "4px 7px", borderRadius: 4, cursor: "pointer", fontSize: 11 }}>⚙</button>
                    <button
                      onClick={() => onToggleComplete(project.id, isComplete)}
                      title={isComplete ? "Mark as active" : "Mark as complete"}
                      style={{ background: isComplete ? "#0f2010" : "#0a0f18", border: `1px solid ${isComplete ? "#2a5a30" : "#1a2030"}`, color: isComplete ? "#5acc70" : "#3a5a7a", padding: "4px 7px", borderRadius: 4, cursor: "pointer", fontSize: 11 }}
                    >{isComplete ? "✓" : "○"}</button>
                  </div>
                </td>
              </tr>
            );
          })}
          {projects.length === 0 && (
            <tr><td colSpan={11} style={{ padding: 40, textAlign: "center", color: "#2a3a5a", fontSize: 13, fontStyle: "italic" }}>No projects</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function ManagerDashboard({ projects, onOpenProject, user }) {
  const [rates, setRates] = useState(null);
  const [rateUpdatedAt, setRateUpdatedAt] = useState(null);
  const [managerMeta, setManagerMeta] = useState({ projectStatuses: {}, projectOverrides: {} });
  const [showRateCard, setShowRateCard] = useState(false);
  const [overrideProject, setOverrideProject] = useState(null); // project object
  const [saving, setSaving] = useState(false);
  const [savingOverride, setSavingOverride] = useState(false);
  const [sortKey, setSortKey] = useState("lastEdited");
  const [sortDir, setSortDir] = useState(-1);
  const [activeTab, setActiveTab] = useState("active"); // "active" | "complete"
  const [showExportMenu, setShowExportMenu] = useState(false);
  const exportBtnRef = useRef(null);

  useEffect(() => {
    loadRateCard().then(d => { if (d) { setRates(d.rates); setRateUpdatedAt(d.updatedAt); } });
    loadManagerMeta().then(d => { if (d) setManagerMeta({ projectStatuses: d.projectStatuses || {}, projectOverrides: d.projectOverrides || {} }); });
  }, []);

  // Close export menu on outside click
  useEffect(() => {
    if (!showExportMenu) return;
    const handler = (e) => { if (!exportBtnRef.current?.contains(e.target)) setShowExportMenu(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showExportMenu]);

  // Collect all unique classes from project metadata
  const allClasses = useMemo(() => {
    const seen = new Set(BUILTIN_CLASSES);
    const list = BUILTIN_CLASSES.map(n => ({ name: n, color: BUILTIN_COLORS[n] || "#888", isCustom: false }));
    for (const p of projects) {
      for (const cc of (p.customClasses || [])) {
        if (!seen.has(cc.name)) { seen.add(cc.name); list.push({ name: cc.name, color: cc.color || "#FFAA00", isCustom: true, measureType: cc.measureType || "unit" }); }
      }
    }
    return list;
  }, [projects]);

  // Partition into active / complete
  const { activeProjects, completedProjects } = useMemo(() => {
    const active = [], complete = [];
    for (const p of projects) {
      const status = managerMeta.projectStatuses?.[p.id] || p.status || "Draft";
      if (status === "Complete") complete.push(p);
      else active.push(p);
    }
    return { activeProjects: active, completedProjects: complete };
  }, [projects, managerMeta.projectStatuses]);

  // Sort helper
  const sortProjects = (arr) => [...arr].sort((a, b) => {
    let av, bv;
    const ovA = managerMeta.projectOverrides?.[a.id], ovB = managerMeta.projectOverrides?.[b.id];
    if (sortKey === "name")        { av = a.name?.toLowerCase(); bv = b.name?.toLowerCase(); }
    else if (sortKey === "cost")   { av = calcProjectCost(a, rates, ovA) ?? -1; bv = calcProjectCost(b, rates, ovB) ?? -1; }
    else if (sortKey === "lastEdited") { av = a.lastEdited; bv = b.lastEdited; }
    else if (sortKey === "walls")  { av = a.totalWallLengthM ?? a.counts?.walls ?? -1; bv = b.totalWallLengthM ?? b.counts?.walls ?? -1; }
    else if (sortKey === "zones")  { av = a.totalZoneAreaM2 ?? a.counts?.zones ?? -1; bv = b.totalZoneAreaM2 ?? b.counts?.zones ?? -1; }
    else return 0;
    if (av < bv) return -sortDir; if (av > bv) return sortDir; return 0;
  });

  const toggleSort = key => { if (sortKey === key) setSortDir(d => -d); else { setSortKey(key); setSortDir(-1); } };

  // KPI totals (active only)
  const totals = useMemo(() => {
    let totalCost = 0; let hasCost = false;
    let wallLength = 0, zoneArea = 0, doors = 0, windows = 0;
    let hasWallLength = false, hasZoneArea = false;
    for (const p of activeProjects) {
      if (p.totalWallLengthM != null) { wallLength += p.totalWallLengthM; hasWallLength = true; }
      else if (p.counts?.walls) wallLength += p.counts.walls; // count fallback
      if (p.totalZoneAreaM2 != null) { zoneArea += p.totalZoneAreaM2; hasZoneArea = true; }
      else if (p.counts?.zones) zoneArea += p.counts.zones;   // count fallback
      doors   += p.counts?.doors   || 0;
      windows += p.counts?.windows || 0;
      const c = calcProjectCost(p, rates, managerMeta.projectOverrides?.[p.id]);
      if (c != null) { totalCost += c; hasCost = true; }
    }
    return { totalCost: hasCost ? totalCost : null, wallLength, zoneArea, doors, windows, hasWallLength, hasZoneArea };
  }, [activeProjects, rates, managerMeta.projectOverrides]);

  // Save rate card
  const handleSaveRates = async (newRates) => {
    setSaving(true);
    try {
      await saveRateCard(newRates);
      setRates(newRates); setRateUpdatedAt(new Date().toISOString());
      setShowRateCard(false);
    } catch (e) { console.error(e); } finally { setSaving(false); }
  };

  // Save per-project override
  const handleSaveOverride = async (newOverrides) => {
    if (!overrideProject) return;
    setSavingOverride(true);
    try {
      const nextMeta = {
        ...managerMeta,
        projectOverrides: { ...managerMeta.projectOverrides, [overrideProject.id]: newOverrides },
      };
      await saveManagerMeta(nextMeta);
      setManagerMeta(nextMeta);
      setOverrideProject(null);
    } catch (e) { console.error(e); } finally { setSavingOverride(false); }
  };

  // Toggle complete
  const handleToggleComplete = async (projectId, isCurrentlyComplete) => {
    const newStatus = isCurrentlyComplete ? "In Progress" : "Complete";
    const nextMeta = {
      ...managerMeta,
      projectStatuses: { ...managerMeta.projectStatuses, [projectId]: newStatus },
    };
    setManagerMeta(nextMeta);
    try { await saveManagerMeta(nextMeta); } catch (e) { console.error(e); }
  };

  // ── Export helpers ────────────────────────────────────────────────────────
  const buildExportRows = (projs) => projs.map(p => {
    const cost = calcProjectCost(p, rates, managerMeta.projectOverrides?.[p.id]);
    const status = managerMeta.projectStatuses?.[p.id] || p.status || "Draft";
    return {
      name: p.name, owner: p.owner || "—", pages: p.pageCount || 1,
      walls: p.totalWallLengthM != null ? +p.totalWallLengthM.toFixed(2) : (p.counts?.walls ?? ""),
      zones: p.totalZoneAreaM2  != null ? +p.totalZoneAreaM2.toFixed(2)  : (p.counts?.zones  ?? ""),
      doors: p.counts?.doors ?? 0, windows: p.counts?.windows ?? 0,
      cost: cost != null ? cost : 0, status,
      lastEdited: fmtDate(p.lastEdited),
    };
  });

  const exportExcel = () => {
    const rows = buildExportRows(projects);
    const headers = ["Project", "Owner", "Pages", "Wall Length (m)", "Zone Area (m²)", "Doors", "Windows", "Est. Cost ($)", "Status", "Last Edited"];
    const data = rows.map(r => [r.name, r.owner, r.pages, r.walls, r.zones, r.doors, r.windows, r.cost || "", r.status, r.lastEdited]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
    ws["!cols"] = [20,22,6,8,8,8,8,14,14,14].map(w => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Projects");
    XLSX.writeFile(wb, "manager_cost_report.xlsx");
    setShowExportMenu(false);
  };

  const exportPDF = () => {
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
    const W = 210, H = 297, M = 14, COL = W - M * 2;
    const DARK = [15, 23, 40], ACCENT = [30, 80, 160], MUTED = [100, 120, 150], LIGHT = [200, 208, 224];

    // Cover
    doc.setFillColor(...DARK); doc.rect(0, 0, W, H, "F");
    doc.setFillColor(...ACCENT); doc.rect(0, 70, W, 2, "F"); doc.rect(0, 145, W, 2, "F");
    try {
      // logo attempt (may not load in PDF context but try)
    } catch { /* skip */ }
    doc.setTextColor(100, 210, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(14);
    doc.text("QUANT", M, 32);
    doc.setTextColor(200, 240, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(24);
    doc.text("Cost Report", W / 2, 92, { align: "center" });
    doc.setTextColor(180, 200, 220); doc.setFont("helvetica", "normal"); doc.setFontSize(14);
    doc.text("Manager Dashboard", W / 2, 108, { align: "center" });
    doc.setFontSize(10); doc.setTextColor(...MUTED);
    const mgr = user?.signInDetails?.loginId || user?.username || "Manager";
    doc.text(`Prepared by: ${mgr}`, W / 2, 157, { align: "center" });
    doc.text(`Generated: ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`, W / 2, 167, { align: "center" });
    doc.text(`Projects: ${activeProjects.length} active, ${completedProjects.length} complete`, W / 2, 177, { align: "center" });
    if (totals.totalCost != null) doc.text(`Total Est. Cost: ${fmtCost(totals.totalCost)}`, W / 2, 187, { align: "center" });

    // Active projects table
    doc.addPage();
    doc.setFillColor(...ACCENT); doc.rect(0, 0, W, 12, "F");
    doc.setTextColor(255,255,255); doc.setFont("helvetica","bold"); doc.setFontSize(9);
    doc.text("COST REPORT — ACTIVE PROJECTS", M, 8);
    let y = 22;
    doc.setTextColor(...DARK); doc.setFont("helvetica","bold"); doc.setFontSize(13);
    doc.text("Active Projects", M, y); y += 3;
    doc.setDrawColor(...ACCENT); doc.setLineWidth(0.4); doc.line(M, y, W-M, y); y += 6;

    const cols = [M, M+52, M+90, M+110, M+122, M+134, M+148, M+168];
    const ROW_H = 7;

    // Header
    doc.setFillColor(...ACCENT); doc.rect(M, y, COL, ROW_H, "F");
    doc.setTextColor(255,255,255); doc.setFont("helvetica","bold"); doc.setFontSize(7.5);
    ["Project","Owner","Pages","Wall Len (m)","Zone Area (m²)","Doors","Win","Est. Cost"].forEach((h,i) => doc.text(h, cols[i]+1, y+5));
    y += ROW_H;

    buildExportRows(activeProjects).forEach((r, i) => {
      if (y + ROW_H > H - 20) {
        doc.addPage();
        doc.setFillColor(...ACCENT); doc.rect(0,0,W,12,"F");
        doc.setTextColor(255,255,255); doc.setFont("helvetica","bold"); doc.setFontSize(9);
        doc.text("COST REPORT — ACTIVE PROJECTS (cont.)", M, 8);
        y = 20;
        doc.setFillColor(...ACCENT); doc.rect(M, y, COL, ROW_H, "F");
        doc.setTextColor(255,255,255); doc.setFont("helvetica","bold"); doc.setFontSize(7.5);
        ["Project","Owner","Pages","Wall Len (m)","Zone Area (m²)","Doors","Win","Est. Cost"].forEach((h,ci) => doc.text(h, cols[ci]+1, y+5));
        y += ROW_H;
      }
      doc.setFillColor(i%2===0?240:250, i%2===0?244:250, i%2===0?252:255);
      doc.rect(M, y, COL, ROW_H, "F");
      doc.setTextColor(...DARK); doc.setFont("helvetica","normal"); doc.setFontSize(7.5);
      const trunc = (s, maxC) => { const t = String(s||""); return t.length > maxC ? t.slice(0,maxC-1)+"…" : t; };
      doc.text(trunc(r.name, 18), cols[0]+1, y+5);
      doc.text(trunc(r.owner, 16), cols[1]+1, y+5);
      doc.text(String(r.pages), cols[2]+1, y+5);
      doc.text(String(r.walls||0), cols[3]+1, y+5);
      doc.text(String(r.zones||0), cols[4]+1, y+5);
      doc.text(String(r.doors||0), cols[5]+1, y+5);
      doc.text(String(r.windows||0), cols[6]+1, y+5);
      doc.text(r.cost ? fmtCost(r.cost) : "—", cols[7]+1, y+5);
      y += ROW_H;
    });

    // Total row
    const totalCost = buildExportRows(activeProjects).reduce((s,r) => s + (r.cost||0), 0);
    doc.setFillColor(30, 50, 100); doc.rect(M, y, COL, ROW_H, "F");
    doc.setTextColor(200,230,255); doc.setFont("helvetica","bold"); doc.setFontSize(8);
    doc.text("TOTAL", cols[0]+1, y+5);
    doc.text(fmtCost(totalCost), cols[7]+1, y+5);
    y += ROW_H + 2;
    doc.setDrawColor(...ACCENT); doc.setLineWidth(0.3); doc.rect(M, y - (ROW_H*(buildExportRows(activeProjects).length+2)), COL, ROW_H*(buildExportRows(activeProjects).length+2));

    doc.save("manager_cost_report.pdf");
    setShowExportMenu(false);
  };

  const displayedProjects = sortProjects(activeTab === "active" ? activeProjects : completedProjects);

  return (
    <div style={{ background: "#0b0f1a", minHeight: "calc(100vh - 60px)", color: "#c8d0e0", fontFamily: "IBM Plex Sans, system-ui, sans-serif" }}>

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 32px 16px", borderBottom: "1px solid #1c2540", background: "#0e1422" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#c8d0e0", fontFamily: "IBM Plex Mono, monospace", letterSpacing: 1 }}>Manager Dashboard</h2>
          <div style={{ fontSize: 11, color: "#4a6a7a", marginTop: 4 }}>
            {projects.length} project{projects.length !== 1 ? "s" : ""}
            {rateUpdatedAt && <span style={{ marginLeft: 14, color: "#3a5a3a" }}>Rate card saved {fmtDate(rateUpdatedAt)}</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {/* Export dropdown */}
          <div style={{ position: "relative" }} ref={exportBtnRef}>
            <button
              onClick={() => setShowExportMenu(v => !v)}
              style={{ background: "linear-gradient(135deg, #0f1e3a, #0a1530)", border: "1px solid #1e3a5a", color: "#60a0c0", padding: "9px 16px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}
            >
              Export ▾
            </button>
            {showExportMenu && (
              <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", background: "#0e1422", border: "1px solid #1c2540", borderRadius: 6, boxShadow: "0 8px 32px rgba(0,0,0,0.5)", zIndex: 300, minWidth: 160, overflow: "hidden" }}>
                <button onClick={exportPDF} style={{ display: "block", width: "100%", padding: "10px 16px", textAlign: "left", background: "none", border: "none", color: "#c8d0e0", fontSize: 12, cursor: "pointer" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#111827"}
                  onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  📄 PDF Report
                </button>
                <button onClick={exportExcel} style={{ display: "block", width: "100%", padding: "10px 16px", textAlign: "left", background: "none", border: "none", color: "#c8d0e0", fontSize: 12, cursor: "pointer" }}
                  onMouseEnter={e => e.currentTarget.style.background = "#111827"}
                  onMouseLeave={e => e.currentTarget.style.background = "none"}>
                  📊 Excel (.xlsx)
                </button>
              </div>
            )}
          </div>
          <button
            onClick={() => setShowRateCard(true)}
            style={{ background: "linear-gradient(135deg, #1a2a4a, #0f1e3a)", border: "1px solid #2a4a7a", color: "#7ab0e0", padding: "9px 18px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}
          >
            ⚙ Rate Card
          </button>
        </div>
      </div>

      <div style={{ padding: "24px 32px" }}>

        {/* KPI Cards */}
        <div style={{ display: "flex", gap: 14, marginBottom: 28, flexWrap: "wrap" }}>
          <KpiCard icon="📁" label="Active Projects" value={activeProjects.length} accent="#1e6fff" />
          <KpiCard icon="💰" label="Total Est. Cost" value={fmtCost(totals.totalCost)} accent="#c0a840" sub={!rates ? "Set rate card to calculate" : undefined} />
          <KpiCard icon="▭" label="Wall Length" value={totals.hasWallLength ? `${totals.wallLength.toFixed(1)} m` : fmt(totals.wallLength)} accent="#00B050" sub={totals.hasWallLength ? undefined : "Save project to get length"} />
          <KpiCard icon="⬡" label="Zone Area" value={totals.hasZoneArea ? `${totals.zoneArea.toFixed(1)} m²` : fmt(totals.zoneArea)} accent="#C00000" sub={totals.hasZoneArea ? undefined : "Save project to get area"} />
          <KpiCard icon="▯" label="Doors" value={fmt(totals.doors)} accent="#7030A0" />
          <KpiCard icon="◫" label="Windows" value={fmt(totals.windows)} accent="#ED7D31" />
        </div>

        {/* Donut chart + table layout */}
        <div style={{ display: "flex", gap: 24, marginBottom: 24, flexWrap: "wrap", alignItems: "flex-start" }}>

          {/* Donut chart card */}
          <div style={{ background: "#0e1422", border: "1px solid #1c2540", borderRadius: 8, padding: "20px 24px", flexShrink: 0 }}>
            <div style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 11, fontWeight: 700, color: "#4a6a8a", letterSpacing: 2, textTransform: "uppercase", marginBottom: 16 }}>Cost Breakdown</div>
            <DonutChart
              projects={activeProjects}
              orgRates={rates}
              projectOverrides={managerMeta.projectOverrides}
            />
          </div>

          {/* Projects table */}
          <div style={{ flex: 1, minWidth: 0, background: "#0e1422", border: "1px solid #1c2540", borderRadius: 8, overflow: "hidden" }}>
            {/* Tabs */}
            <div style={{ display: "flex", borderBottom: "1px solid #1c2540" }}>
              {[["active", `Active (${activeProjects.length})`], ["complete", `Completed (${completedProjects.length})`]].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  style={{ padding: "12px 20px", background: activeTab === key ? "#111827" : "none", border: "none", borderBottom: activeTab === key ? "2px solid #1e6fff" : "2px solid transparent", color: activeTab === key ? "#c8d0e0" : "#4a6a8a", cursor: "pointer", fontSize: 12, fontWeight: activeTab === key ? 600 : 400, fontFamily: "IBM Plex Mono, monospace", letterSpacing: 0.5 }}
                >
                  {label}
                </button>
              ))}
            </div>
            <ProjectsTable
              projects={displayedProjects}
              orgRates={rates}
              projectOverrides={managerMeta.projectOverrides}
              projectStatuses={managerMeta.projectStatuses}
              onOpen={onOpenProject}
              onToggleComplete={handleToggleComplete}
              onOpenOverride={setOverrideProject}
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={toggleSort}
            />
          </div>
        </div>
      </div>

      {/* Rate Card panel */}
      <RatePanel
        open={showRateCard}
        onClose={() => setShowRateCard(false)}
        title="RATE CARD"
        subtitle="Org-wide unit rates. Override per-project with the ⚙ button on each row."
        allClasses={allClasses}
        baseRates={rates}
        initialOverrides={null}
        onSave={handleSaveRates}
        saving={saving}
      />

      {/* Per-project override panel */}
      <RatePanel
        open={!!overrideProject}
        onClose={() => setOverrideProject(null)}
        title="RATE OVERRIDE"
        subtitle={overrideProject ? `Custom rates for: ${overrideProject.name}. Leave rate empty to use org default.` : ""}
        allClasses={allClasses}
        baseRates={rates}
        initialOverrides={overrideProject ? (managerMeta.projectOverrides?.[overrideProject.id] || {}) : {}}
        onSave={handleSaveOverride}
        saving={savingOverride}
      />
    </div>
  );
}
