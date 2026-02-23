import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { getRunById } from '../lib/db';
import type { Run } from '../lib/types';

function formatModelLabel(run: Run): string {
  if (run.resolved_model && run.resolved_model !== run.requested_model) {
    return `${run.requested_model} -> ${run.resolved_model}`;
  }

  return run.requested_model;
}

export function CompareView() {
  const { leftId, rightId } = useParams();
  const navigate = useNavigate();

  const [leftRun, setLeftRun] = useState<Run | null>(null);
  const [rightRun, setRightRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!leftId || !rightId) {
      setError('Missing run ids for comparison.');
      setLoading(false);
      return;
    }

    const loadRuns = async () => {
      setLoading(true);
      setError(null);

      try {
        const [left, right] = await Promise.all([getRunById(leftId), getRunById(rightId)]);

        if (!left || !right) {
          setError('One or both selected runs were not found.');
          return;
        }

        setLeftRun(left);
        setRightRun(right);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load comparison.');
      } finally {
        setLoading(false);
      }
    };

    void loadRuns();
  }, [leftId, rightId]);

  return (
    <section className="panel compare-panel">
      <div className="panel-header">
        <h2>Compare</h2>
        <button type="button" className="secondary" onClick={() => navigate('/history')}>
          Back to History
        </button>
      </div>

      {loading && <p className="inline-status">Loading compare view...</p>}
      {!loading && error && <p className="inline-error">{error}</p>}

      {!loading && !error && leftRun && rightRun && (
        <>
          <div className="compare-meta">
            <div>
              <strong>{formatModelLabel(leftRun)}</strong>
              <span>{leftRun.latency_ms} ms</span>
            </div>
            <div>
              <strong>{formatModelLabel(rightRun)}</strong>
              <span>{rightRun.latency_ms} ms</span>
            </div>
          </div>

          <div className="compare-columns">
            <div className="compare-column">
              <h3>Output A</h3>
              <pre className="output-text output-scroll-box">{leftRun.output_text || '[No output]'}</pre>
            </div>

            <div className="compare-column">
              <h3>Output B</h3>
              <pre className="output-text output-scroll-box">{rightRun.output_text || '[No output]'}</pre>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
