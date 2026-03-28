import { useState, useRef, useEffect } from "react";
import "./ProjectsPage.css";

export default function NewProjectModal({ onCreate, onCancel }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const nameRef = useRef(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const handleSubmit = () => {
    if (!name.trim()) {
      setError("Please enter a project name.");
      return;
    }

    setError("");
    onCreate({ name: name.trim() });
  };

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-box">
        <div className="modal-header">
          <h2 className="modal-title">New Project</h2>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>

        <div className="modal-body">
          <label className="modal-label">
            Project Name <span className="modal-required">*</span>
          </label>

          <input
            ref={nameRef}
            className="modal-input"
            type="text"
            placeholder="e.g. Tower Block — Level 3"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
          />

          {error && <p className="modal-error">{error}</p>}
        </div>

        <div className="modal-footer">
          <button className="pp-btn-ghost" onClick={onCancel}>
            Cancel
          </button>

          <button
            className="pp-btn-primary"
            onClick={handleSubmit}
            disabled={!name.trim()}
          >
            Create Project
          </button>
        </div>
      </div>
    </div>
  );
}
