/**
 * ProjectCard.jsx
 *
 * Displays a single project's summary.
 * Props:
 *   project    – project object { id, name, fileName, status, lastEdited, counts }
 *   formatDate – date formatting helper from ProjectsPage
 *   onOpen     – called with (project) when Open is clicked
 *   onDelete   – called with (project.id) when Delete is clicked
 */

import "./ProjectsPage.css";

// Status badge colour mapping
const STATUS_STYLES = {
  Draft:       { bg: "#1a2035", color: "#5a7a9a", border: "#2a3a55" },
  "In Progress": { bg: "#0f2a1a", color: "#3a9a6a", border: "#1a4a2a" },
  Complete:    { bg: "#0f1e3a", color: "#4a8adf", border: "#1a3060" },
};

// Count icons
const COUNT_META = [
  { key: "zones",   label: "Zones",   icon: "⬡" },
  { key: "walls",   label: "Walls",   icon: "▭" },
  { key: "doors",   label: "Doors",   icon: "▯" },
  { key: "windows", label: "Windows", icon: "◫" },
];

export default function ProjectCard({ project, formatDate, onOpen, onDelete }) {
  const { name, fileName, status, lastEdited, counts } = project;
  const statusStyle = STATUS_STYLES[status] || STATUS_STYLES["Draft"];

  return (
    <div className="pc-card">
      {/* ── Top row: name + status ── */}
      <div className="pc-top">
        <div className="pc-name-wrap">
          <div className="pc-icon">📐</div>
          <div>
            <p className="pc-name">{name}</p>
            <p className="pc-filename">{fileName}</p>
          </div>
        </div>
        <span
          className="pc-status"
          style={{
            background: statusStyle.bg,
            color: statusStyle.color,
            border: `1px solid ${statusStyle.border}`,
          }}
        >
          {status}
        </span>
      </div>

      {/* ── Counts (optional) ── */}
      {counts ? (
        <div className="pc-counts">
          {COUNT_META.map(({ key, label, icon }) => (
            <div key={key} className="pc-count-chip">
              <span className="pc-count-icon">{icon}</span>
              <span className="pc-count-num">{counts[key]}</span>
              <span className="pc-count-label">{label}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="pc-no-counts">No analysis run yet</div>
      )}

      {/* ── Footer: delete (left) · date (centre) · open (right) ── */}
      <div className="pc-footer">
        <button
          className="pc-btn-delete"
          onClick={() => onDelete(project.id)}
          title="Delete project"
        >
          🗑
        </button>
        <span className="pc-date">
          Edited {formatDate(lastEdited)}
        </span>
        <button
          className="pc-btn-open"
          onClick={() => onOpen(project)}
        >
          Open →
        </button>
      </div>
    </div>
  );
}
