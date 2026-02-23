import type { KeyboardEvent } from 'react';

import type { CampSummary } from '../../lib/types';

type CampCardProps = {
  camp: CampSummary;
  promptPreview: string;
  artifactCount?: number;
  isActive: boolean;
  onPreview: () => void;
  onOpen: () => void;
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
      className={`camp-card ${props.isActive ? 'camp-card-active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={handleKeyDown}
      aria-label={`Open ${props.camp.name}`}
    >
      <header className="camp-card-header">
        <h3>{props.camp.name}</h3>
        <time dateTime={new Date(props.camp.updated_at).toISOString()}>{formatRelativeTime(props.camp.updated_at)}</time>
      </header>

      <p className="camp-card-model">{props.camp.model}</p>
      <p className="camp-card-prompt">{props.promptPreview}</p>

      <footer className="camp-card-footer">
        <span>{props.artifactCount ?? 0} artifacts</span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            props.onPreview();
          }}
        >
          Preview
        </button>
      </footer>
    </article>
  );
}
