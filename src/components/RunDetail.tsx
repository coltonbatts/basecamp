import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { getRunById, listToolCallsForRun, updateRunRatingAndTags } from '../lib/db';
import type { Run, ToolCallRow } from '../lib/types';

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function formatJson(jsonText: string): string {
  try {
    return JSON.stringify(JSON.parse(jsonText), null, 2);
  } catch {
    return jsonText;
  }
}

export function RunDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [run, setRun] = useState<Run | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCallRow[]>([]);
  const [rating, setRating] = useState<number | ''>('');
  const [tags, setTags] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setError('Missing run id.');
      setLoading(false);
      return;
    }

    const loadRun = async () => {
      setLoading(true);
      setError(null);

      try {
        const [fetchedRun, fetchedToolCalls] = await Promise.all([getRunById(id), listToolCallsForRun(id)]);
        if (!fetchedRun) {
          setError('Run not found.');
          return;
        }

        setRun(fetchedRun);
        setToolCalls(fetchedToolCalls);
        setRating(fetchedRun.rating ?? '');
        setTags(fetchedRun.tags ?? '');
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load run.');
      } finally {
        setLoading(false);
      }
    };

    void loadRun();
  }, [id]);

  const handleSave = async () => {
    if (!run) {
      return;
    }

    setSaving(true);
    setError(null);
    setStatus(null);

    try {
      const normalizedTags = tags.trim();
      await updateRunRatingAndTags({
        id: run.id,
        rating: rating === '' ? null : rating,
        tags: normalizedTags ? normalizedTags : null,
      });
      setStatus('Saved.');
      setRun({
        ...run,
        rating: rating === '' ? null : rating,
        tags: normalizedTags ? normalizedTags : null,
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save changes.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel detail-panel">
      <div className="panel-header">
        <h2>Run Detail</h2>
        <button type="button" className="secondary" onClick={() => navigate('/history')}>
          Back to History
        </button>
      </div>

      {loading && <p className="inline-status">Loading run...</p>}
      {!loading && error && <p className="inline-error">{error}</p>}

      {!loading && run && (
        <div className="detail-grid">
          <div className="detail-meta">
            <p>
              <strong>Timestamp:</strong> {formatTimestamp(run.timestamp)}
            </p>
            <p>
              <strong>Requested Model:</strong> {run.requested_model}
            </p>
            <p>
              <strong>Routed Model:</strong> {run.resolved_model ?? '-'}
            </p>
            <p>
              <strong>Temperature:</strong> {run.temperature}
            </p>
            <p>
              <strong>Max Tokens:</strong> {run.max_tokens}
            </p>
            <p>
              <strong>Latency:</strong> {run.latency_ms} ms
            </p>
            <p>
              <strong>Prompt Tokens:</strong> {run.prompt_tokens ?? '-'}
            </p>
            <p>
              <strong>Completion Tokens:</strong> {run.completion_tokens ?? '-'}
            </p>
            <p>
              <strong>Total Tokens:</strong> {run.total_tokens ?? '-'}
            </p>
            <p>
              <strong>Error:</strong> {run.error ?? '-'}
            </p>
          </div>

          <label className="field">
            <span>System Prompt</span>
            <textarea value={run.system_prompt} rows={5} readOnly />
          </label>

          <label className="field">
            <span>User Prompt</span>
            <textarea value={run.user_prompt} rows={6} readOnly />
          </label>

          <div className="field">
            <span>Output</span>
            <pre className="output-text output-scroll-box">{run.output_text || '[No output]'}</pre>
          </div>

          <div className="field">
            <span>Tool Calls</span>
            {toolCalls.length === 0 ? (
              <p className="inline-status">No tool calls were logged for this run.</p>
            ) : (
              <div className="tool-calls-list">
                {toolCalls.map((toolCall) => (
                  <div key={toolCall.id} className="tool-call-item">
                    <p>
                      <strong>Step:</strong> {toolCall.step_index} | <strong>Tool:</strong> {toolCall.tool_name}
                    </p>
                    <p>
                      <strong>Started:</strong> {formatTimestamp(toolCall.started_at)}
                    </p>
                    <p>
                      <strong>Finished:</strong>{' '}
                      {toolCall.finished_at !== null ? formatTimestamp(toolCall.finished_at) : '-'}
                    </p>
                    <details>
                      <summary>Args</summary>
                      <pre className="output-text output-scroll-box">{formatJson(toolCall.args_json)}</pre>
                    </details>
                    <details>
                      <summary>{toolCall.error ? 'Error' : 'Result'}</summary>
                      <pre className="output-text output-scroll-box">
                        {toolCall.error ?? formatJson(toolCall.result_json ?? '{}')}
                      </pre>
                    </details>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="inline-grid">
            <label className="field">
              <span>Rating (1-5)</span>
              <select value={rating === '' ? '' : String(rating)} onChange={(event) => setRating(event.target.value ? Number(event.target.value) : '')}>
                <option value="">None</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
                <option value="5">5</option>
              </select>
            </label>

            <label className="field">
              <span>Tags (comma separated)</span>
              <input
                type="text"
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="creative, fast, concise"
              />
            </label>
          </div>

          <div className="button-row">
            <button type="button" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>

          {status && <p className="inline-status">{status}</p>}
        </div>
      )}
    </section>
  );
}
