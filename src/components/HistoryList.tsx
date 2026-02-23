import type { Run } from '../lib/types';

type HistoryListProps = {
  runs: Run[];
  loading: boolean;
  error: string | null;
  selectedRunIds: string[];
  onToggleSelect: (runId: string) => void;
  onOpenRun: (runId: string) => void;
  onCompare: () => void;
};

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function previewPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
}

function isReroutedModel(requestedModel: string, resolvedModel: string | null): boolean {
  if (!resolvedModel) {
    return false;
  }

  return requestedModel !== resolvedModel;
}

export function HistoryList({
  runs,
  loading,
  error,
  selectedRunIds,
  onToggleSelect,
  onOpenRun,
  onCompare,
}: HistoryListProps) {
  const compareDisabled = selectedRunIds.length !== 2;

  return (
    <section className="panel history-panel">
      <div className="panel-header">
        <h2>History</h2>
        <button type="button" disabled={compareDisabled} onClick={onCompare}>
          Compare 2 Runs
        </button>
      </div>

      {loading && <p className="inline-status">Loading runs...</p>}
      {!loading && error && <p className="inline-error">{error}</p>}

      {!loading && !error && (
        <div className="history-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th>Select</th>
                <th>Timestamp</th>
                <th>Requested Model</th>
                <th>Routed Model</th>
                <th>User Prompt</th>
                <th>Latency</th>
                <th>Total Tokens</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} onClick={() => onOpenRun(run.id)}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedRunIds.includes(run.id)}
                      onChange={() => onToggleSelect(run.id)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`Select run ${run.id} for compare`}
                    />
                  </td>
                  <td>{formatTimestamp(run.timestamp)}</td>
                  <td>{run.requested_model}</td>
                  <td className="history-model-cell">
                    <span>{run.resolved_model ?? '-'}</span>
                    {isReroutedModel(run.requested_model, run.resolved_model) && (
                      <span className="model-route-badge">Rerouted</span>
                    )}
                  </td>
                  <td>{previewPrompt(run.user_prompt)}</td>
                  <td>{run.latency_ms} ms</td>
                  <td>{run.total_tokens ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {runs.length === 0 && <p className="inline-status">No runs yet.</p>}
        </div>
      )}
    </section>
  );
}
