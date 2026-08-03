import { useState, useEffect } from "react";
import ProjectCard from "./ProjectCard";
import NewProjectModal from "./NewProjectModal";
import ManagerDashboard from "./ManagerDashboard";
import { listProjects, listManagerProjects, createProject, deleteProject } from "../services/projectStorage";
import { getLimits, fetchUserProfile } from "../services/userService";
import "./ProjectsPage.css";

function formatDate(isoString) {
  const d = new Date(isoString);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function generateId(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${slug}-${suffix}`;
}

export default function ProjectsPage({ onOpenProject, user, refreshKey, userTierInfo = { tier: 'individual', role: null } }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showModal, setShowModal] = useState(false);

  const isManager = userTierInfo.role === 'manager';
  const limits = getLimits(userTierInfo.tier, userTierInfo.role);
  const atLimit = !isManager && limits.maxProjects !== Infinity && projects.length >= limits.maxProjects;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const load = async () => {
      try {
        let data;
        if (isManager) {
          // Managers: fetch their granted project list from the Lambda, then load each from S3
          const profile = await fetchUserProfile();
          const grants = profile?.projectGrants || [];
          data = await listManagerProjects(grants);
        } else {
          data = await listProjects();
        }
        if (!cancelled) setProjects(data);
      } catch {
        if (!cancelled) setError("Failed to load projects.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [refreshKey, isManager]);

  const handleOpen = (project) => {
    if (onOpenProject) onOpenProject(project);
  };

  const handleDelete = async (projectId) => {
    if (isManager) return; // managers cannot delete
    if (!window.confirm("Delete this project? This cannot be undone.")) return;
    setProjects(prev => prev.filter(p => p.id !== projectId));
    try {
      await deleteProject(projectId);
    } catch {
      listProjects().then(setProjects).catch(() => {});
    }
  };

  const handleCreate = async ({ name }) => {
    const newProject = {
      id: generateId(name),
      name,
      fileName: null,
      file: null,
      status: "Draft",
      lastEdited: new Date().toISOString(),
      counts: null,
      owner: user?.username || user?.userId || "unknown",
      ratio: null,
    };
    setShowModal(false);
    try {
      await createProject(newProject.id, newProject.name, newProject.owner);
    } catch (err) {
      console.error("Failed to persist new project:", err);
    }
    if (onOpenProject) onOpenProject(newProject);
  };

  // Managers get the full dashboard — no header chrome needed, it's inside the dashboard
  if (isManager) {
    return (
      <div className="pp-root">
        <header className="pp-header">
          <div className="pp-header-left">
            <span className="pp-logo">⬡ QUANT</span>
            <span className="pp-header-divider" />
            <h1 className="pp-title">Dashboard</h1>
          </div>
        </header>
        {loading && <div className="pp-feedback pp-loading">Loading projects…</div>}
        {!loading && error && <div className="pp-feedback pp-error">{error}</div>}
        {!loading && !error && (
          <ManagerDashboard
            projects={projects}
            onOpenProject={handleOpen}
            user={user}
            userTierInfo={userTierInfo}
          />
        )}
      </div>
    );
  }

  return (
    <div className="pp-root">
      <header className="pp-header">
        <div className="pp-header-left">
          <span className="pp-logo">⬡ QUANT</span>
          <span className="pp-header-divider" />
          <h1 className="pp-title">Projects</h1>
        </div>
        <div className="pp-header-right">
          {!loading && (
            <span className="pp-project-count">
              {projects.length}
              {limits.maxProjects !== Infinity ? ` / ${limits.maxProjects}` : ""} project{projects.length !== 1 ? "s" : ""}
            </span>
          )}
          <button
            className="pp-btn-primary"
            onClick={() => atLimit ? null : setShowModal(true)}
            disabled={atLimit}
            title={atLimit ? `Upgrade your plan to create more than ${limits.maxProjects} project${limits.maxProjects !== 1 ? 's' : ''}` : ''}
          >
            + New Project
          </button>
          {atLimit && (
            <span className="pp-upgrade-hint">↑ Upgrade to add more</span>
          )}
        </div>
      </header>

      <main className="pp-main">
        {loading && <div className="pp-feedback pp-loading">Loading projects…</div>}
        {!loading && error && <div className="pp-feedback pp-error">{error}</div>}
        {!loading && !error && projects.length === 0 && (
          <EmptyState onNew={() => setShowModal(true)} />
        )}
        {!loading && !error && projects.length > 0 && (
          <div className="pp-grid">
            {projects.map(project => (
              <ProjectCard
                key={project.id}
                project={project}
                formatDate={formatDate}
                onOpen={handleOpen}
                onDelete={handleDelete}
                isReadOnly={false}
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
      <p className="pp-empty-sub">Create a project to start working on a drawing.</p>
      <button className="pp-btn-primary" onClick={onNew}>+ New Project</button>
    </div>
  );
}

function EmptyManagerState() {
  return (
    <div className="pp-empty">
      <div className="pp-empty-icon">⬡</div>
      <p className="pp-empty-title">No shared projects yet</p>
      <p className="pp-empty-sub">A Quantity Surveyor will share projects with you from the editor.</p>
    </div>
  );
}
