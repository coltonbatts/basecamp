import type { CampSummary } from '../../lib/types';

type CampCardProps = {
  camp: CampSummary;
  promptPreview: string;
  onOpen: () => void;
  onDelete?: () => void;
};

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diffMs = now - ts;

  if (diffMs < 60_000) {
    return 'just now';
  }

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }

  return new Date(ts).toLocaleDateString();
}

export function CampCard(props: CampCardProps) {
  return (
    <article className="camp-card">
      {props.onDelete && (
        <button
          type="button"
          className="delete-action camp-card-delete"
          onClick={props.onDelete}
          aria-label={`Delete ${props.camp.name}`}
        >
          Delete
        </button>
      )}

      <button type="button" className="camp-card-open" onClick={props.onOpen} aria-label={`Open ${props.camp.name}`}>
        <header className="camp-card-header">
          <div className="camp-card-title">
            <h3>{props.camp.name}</h3>
            <p>{props.camp.model}</p>
          </div>
          <time dateTime={new Date(props.camp.updated_at).toISOString()}>{formatRelativeTime(props.camp.updated_at)}</time>
        </header>

        <p className="camp-card-prompt">{props.promptPreview}</p>

        <footer className="camp-card-footer">
          <span>{new Date(props.camp.updated_at).toLocaleString()}</span>
          <span>{props.camp.id}</span>
        </footer>
      </button>
    </article>
  );
}
