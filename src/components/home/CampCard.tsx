import type { KeyboardEvent } from 'react';

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
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      props.onOpen();
    }
  };

  return (
    <article
      className="camp-card"
      role="button"
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={handleKeyDown}
      aria-label={`Open ${props.camp.name}`}
    >
      <header className="camp-card-header">
        <div className="camp-card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%' }}>
          <div>
            <h3>{props.camp.name}</h3>
            <p>{props.camp.model}</p>
          </div>
          {props.onDelete && (
            <button
              type="button"
              className="delete-action"
              style={{ fontSize: 'var(--text-xs)', padding: 'var(--space-1) var(--space-2)' }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                props.onDelete?.();
              }}
              aria-label={`Delete ${props.camp.name}`}
            >
              Delete
            </button>
          )}
        </div>
        <time dateTime={new Date(props.camp.updated_at).toISOString()}>{formatRelativeTime(props.camp.updated_at)}</time>
      </header>

      <p className="camp-card-prompt">{props.promptPreview}</p>

      <footer className="camp-card-footer">
        <span>{new Date(props.camp.updated_at).toLocaleString()}</span>
        <span>{props.camp.id}</span>
      </footer>
    </article>
  );
}
