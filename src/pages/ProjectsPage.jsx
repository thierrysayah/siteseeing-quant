import { useState } from "react";
import ProjectCard from "./ProjectCard";
import NewProjectModal from "./NewProjectModal";
import "./ProjectsPage.css";

const MOCK_PROJECTS = [
  {
    id: "proj_001",
    name: "Tower Block — Level 3",
    fileName: "tower_block_l3_rev4.pdf",
    status: "In Progress",
    lastEdited: "2026-03-25T14:32:00Z",
    counts: { zones: 12, doors: 8, windows: 24, walls: 47 },
  },
  {
    id: "proj_002",
    name: "Villa Renovation — Ground Floor",
    fileName: "villa_gf_arch_drawings.pdf",
    status: "Complete",
    lastEdited: "2026-03-20T09:10:00Z",
    counts: { zones: 6, doors: 5, windows: 11, walls: 28 },
  },
  {
    id: "proj_003",
    name: "Office Fit-Out — Zone A",
    fileName: "office_zone_a_v2.pdf",
    status: "Draft",
    lastEdited: "2026-03-18T17:55:00Z",
    counts: { zones: 3, doors: 2, windows: 6, walls: 15 },
  },
  {
    id: "proj_004",
    name: "Residential Complex — Block B",
    fileName: "res_complex_B_arch.pdf",
    status: "In Progress",
    lastEdited: "2026-03-10T11:20:00Z",
    counts: null,
  },
];

function formatDate(isoString) {
  const d = new Date(isoString);
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function generateId() {
  return "proj_" + Math.random().toString(36).slice(2, 9);
}

export default function ProjectsPage({ onOpenProject, user }) {
  const [projects, setProjects] = useState(MOCK_PROJECTS);
  const [showModal, setShowModal] = useState(false);

  const handleOpen = (project) => {
    if (onOpenProject) {
      onOpenProject(project);
    }
  };

  const handleDelete = (projectId) => {
    if (!window.confirm("Delete this project? This cannot be undone.")) return;
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
  };

  const handleCreate = ({ name }) => {
      const newProject = {
        id: generateId(),
        name,
        fileName: null,   // 🔥 no file yet
        file: null,
        status: "Draft",
        lastEdited: new Date().toISOString(),
        counts: null,
        owner: user?.username || user?.userId || "local-user",
        ratio: null,
      };
    
      setProjects((prev) => [newProject, ...prev]);
      setShowModal(false);
    
      if (onOpenProject) {
        onOpenProject(newProject);
      }
    };

  return (
    <div className="pp-root">
      <header className="pp-header">
        <div className="pp-header-left">
          <span className="pp-logo">⬡ QUANT</span>
          <span className="pp-header-divider" />
          <h1 className="pp-title">Projects</h1>
        </div>
        <div className="pp-header-right">
          <span className="pp-project-count">
            {projects.length} project{projects.length !== 1 ? "s" : ""}
          </span>
          <button className="pp-btn-primary" onClick={() => setShowModal(true)}>
            + New Project
          </button>
        </div>
      </header>

      <main className="pp-main">
        {projects.length === 0 ? (
          <EmptyState onNew={() => setShowModal(true)} />
        ) : (
          <div className="pp-grid">
            {projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                formatDate={formatDate}
                onOpen={handleOpen}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </main>

      {showModal && (
        <NewProjectModal
          onCreate={handleCreate}
          onCancel={() => setShowModal(false)}
        />
      )}
    </div>
  );
}

function EmptyState({ onNew }) {
  return (
    <div className="pp-empty">
      <div className="pp-empty-icon">⬡</div>
      <p className="pp-empty-title">No projects yet</p>
      <p className="pp-empty-sub">
        Create a project to start working on a drawing.
      </p>
      <button className="pp-btn-primary" onClick={onNew}>
        + New Project
      </button>
    </div>
  );
}