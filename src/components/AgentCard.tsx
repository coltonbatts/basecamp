import type { TeamAgentStatus } from '../lib/types';

type AgentCardProps = {
  agent: TeamAgentStatus;
  onRemove?: (agentId: string) => void;
};

function statusLabel(status: TeamAgentStatus['status']): string {
  if (status === 'working') {
    return 'Working';
  }
  if (status === 'reflecting') {
    return 'Reflecting';
  }
  return 'Idle';
}

export function AgentCard({ agent, onRemove }: AgentCardProps) {
  const initials = agent.role
    .split(/\s+/)
    .filter(Boolean)
    .map((segment) => segment[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2) || agent.id.slice(0, 2).toUpperCase();

  return (
    <article className="team-agent-card">
      <div className="team-agent-avatar" aria-hidden>
        {initials}
      </div>
      <div className="team-agent-content">
        <header>
          <strong>{agent.role}</strong>
          <span>{agent.model}</span>
        </header>
        <p className="team-agent-tools">
          Tools: {agent.tool_subset.length > 0 ? agent.tool_subset.join(', ') : 'none'}
        </p>
        <p className="team-agent-status">{statusLabel(agent.status)}</p>
        <p className="team-agent-preview">{agent.last_output_preview ?? 'No output yet.'}</p>
        <p className="team-agent-tokens">
          In: {agent.token_usage.input.toLocaleString()} · Out: {agent.token_usage.output.toLocaleString()}
        </p>
      </div>
      {onRemove && (
        <button type="button" onClick={() => onRemove(agent.id)}>
          Remove
        </button>
      )}
    </article>
  );
}
