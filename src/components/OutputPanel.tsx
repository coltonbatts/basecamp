import type { TokenUsage } from '../lib/types';

type OutputPanelProps = {
  isRunning: boolean;
  outputText: string;
  errorMessage: string | null;
  latencyMs: number | null;
  tokenUsage: TokenUsage | null;
  requestedModel: string | null;
  resolvedModel: string | null;
  retryNotice: string | null;
  toolStepCount: number;
};

export function OutputPanel({
  isRunning,
  outputText,
  errorMessage,
  latencyMs,
  tokenUsage,
  requestedModel,
  resolvedModel,
  retryNotice,
  toolStepCount,
}: OutputPanelProps) {
  return (
    <section className="panel output-panel">
      <div className="panel-header">
        <h2>Output</h2>
        <div className="metrics">
          {latencyMs !== null && <span>{latencyMs} ms</span>}
          {tokenUsage?.total_tokens !== null && tokenUsage?.total_tokens !== undefined && (
            <span>{tokenUsage.total_tokens} tokens</span>
          )}
          {toolStepCount > 0 && <span>Tool steps: {toolStepCount}</span>}
        </div>
      </div>
      {requestedModel && (
        <p className="output-model-info">
          <strong>Requested model:</strong> {requestedModel} | <strong>Routed model used:</strong>{' '}
          {resolvedModel ?? '-'}
        </p>
      )}
      {retryNotice && <p className="output-retry-notice">{retryNotice}</p>}

      <div className="output-scroll">
        {isRunning && <p className="inline-status">Running request...</p>}
        {!isRunning && errorMessage && <p className="inline-error">{errorMessage}</p>}
        {!isRunning && !errorMessage && !outputText && (
          <p className="inline-status">Run a prompt to see model output.</p>
        )}
        {!isRunning && outputText && <pre className="output-text">{outputText}</pre>}
      </div>
    </section>
  );
}
