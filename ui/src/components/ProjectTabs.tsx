import "./ProjectTabs.css";

interface Props {
  projects: { id: string }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

export default function ProjectTabs({ projects, activeId, onSelect, onNew, onDelete }: Props) {
  if (projects.length === 0) return null;
  return (
    <div className="project-tabs" role="tablist">
      {projects.map((p) => (
        <div
          key={p.id}
          role="tab"
          aria-selected={p.id === activeId}
          className={`project-tab ${p.id === activeId ? "active" : ""}`}
          title={p.id}
        >
          <button
            type="button"
            className="project-tab-label"
            onClick={() => onSelect(p.id)}
          >
            {p.id}
          </button>
          <button
            type="button"
            className="project-tab-close"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(p.id);
            }}
            title={`delete ${p.id}`}
            aria-label={`delete project ${p.id}`}
          >
            ×
          </button>
        </div>
      ))}
      <button
        className="project-tab-new"
        onClick={onNew}
        title="open empty state / drop a new Loom"
        aria-label="new project"
      >
        +
      </button>
    </div>
  );
}
