import type { Camp, CampArtifactMetadata, CampMessage } from '../lib/types';

type TranscriptViewProps = {
  selectedCamp: Camp | null;
  streamingText: string;
  artifactById: Map<string, CampArtifactMetadata>;
  isSending: boolean;
  promotingMessageId: string | null;
  onPromoteMessageToArtifact: (message: CampMessage) => void;
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

function roleLabel(role: CampMessage['role']): string {
  if (role === 'user') {
    return 'You';
  }

  if (role === 'tool') {
    return 'Tool';
  }

  return 'Assistant';
}

export function TranscriptView(props: TranscriptViewProps) {
  return (
    <div className="transcript-scroll">
      {props.selectedCamp?.transcript.map((message) => (
        <article key={message.id} className={`message message-${message.role}`}>
          <header>
            <span>{roleLabel(message.role)}</span>
            <div className="message-actions">
              <time>{formatDate(message.created_at)}</time>
              {message.role !== 'tool' ? (
                <button
                  type="button"
                  onClick={() => props.onPromoteMessageToArtifact(message)}
                  disabled={!props.selectedCamp || props.isSending || props.promotingMessageId === message.id}
                >
                  {props.promotingMessageId === message.id ? 'Saving...' : 'Save Artifact'}
                </button>
              ) : null}
            </div>
          </header>
          <p>{message.content}</p>
          {message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0 ? (
            <p className="hint">Tool calls: {message.tool_calls.map((toolCall) => toolCall.function.name).join(', ')}</p>
          ) : null}
          {message.role === 'tool' ? (
            <p className="hint">
              {message.name ?? 'tool'} {message.tool_call_id ? `(${message.tool_call_id})` : ''}
            </p>
          ) : null}
          {message.included_artifact_ids && message.included_artifact_ids.length > 0 ? (
            <div className="artifact-chip-row">
              {message.included_artifact_ids.map((artifactId) => {
                const artifact = props.artifactById.get(artifactId);
                return (
                  <span key={`${message.id}-${artifactId}`} className="artifact-chip">
                    {artifact?.title ?? artifactId}
                  </span>
                );
              })}
            </div>
          ) : null}
        </article>
      ))}

      {props.streamingText ? (
        <article className="message message-assistant streaming">
          <header>
            <span>Assistant</span>
            <time>streaming...</time>
          </header>
          <p>{props.streamingText}</p>
        </article>
      ) : null}

      {!props.selectedCamp ? <p className="hint">Pick a camp and send your first message.</p> : null}
      {props.selectedCamp && !props.selectedCamp.transcript.length && !props.streamingText ? (
        <p className="hint">No messages yet.</p>
      ) : null}
    </div>
  );
}
