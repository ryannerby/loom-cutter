import "./ProjectTabs.css";

interface Props {
  projects: { id: string }[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void; // back to empty state for fresh drop
}

export default function ProjectTabs({ projects, activeId, onSelect, onNew }: Props) {
  if (projects.length === 0) return null;
  return (
    <div className="project-tabs" role="tablist">
      {projects.map((p) => (
        <button
          key={p.id}
          role="tab"
          aria-selected={p.id === activeId}
          className={`project-tab ${p.id === activeId ? "active" : ""}`}
          onClick={() => onSelect(p.id)}
          title={p.id}
        >
          {p.id}
        </button>
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
