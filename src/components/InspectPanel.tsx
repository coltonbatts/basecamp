import { useMemo, useState } from 'react';

import type { InspectCampFileMeta, InspectEventRecord } from '../lib/inspect';
import { TabsList, TabsPanel, TabsRoot, TabsTrigger } from './ui/Tabs';

type InspectFileWrite = {
  path: string;
  before: InspectCampFileMeta | null;
  after: InspectCampFileMeta | null;
};

export type InspectTurnData = {
  correlationId: string;
  events: InspectEventRecord[];
  requestPayload: unknown;
  responsePayload: unknown;
  filesWritten: InspectFileWrite[];
  composedInputBreakdown: unknown;
  exportPath: string | null;
};

type InspectPanelProps = {
  enabled: boolean;
  turn: InspectTurnData | null;
  exporting: boolean;
  exportError: string | null;
  onExport: () => void;
};

type InspectTab = 'timeline' | 'request' | 'response' | 'files' | 'errors';

function isInspectTab(value: string): value is InspectTab {
  return value === 'timeline' || value === 'request' || value === 'response' || value === 'files' || value === 'errors';
}

function formatTs(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString();
}

function toPrettyJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'No data captured yet.';
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function fileStatSummary(meta: InspectCampFileMeta | null): string {
  if (!meta || !meta.exists) {
    return 'missing';
  }

  const size = typeof meta.size_bytes === 'number' ? `${meta.size_bytes} bytes` : 'size unknown';
  const modified =
    typeof meta.modified_at_ms === 'number'
      ? new Date(meta.modified_at_ms).toLocaleTimeString()
      : 'mtime unknown';

  return `${size} @ ${modified}`;
}

export function InspectPanel({ enabled, turn, exporting, exportError, onExport }: InspectPanelProps) {
  const [tab, setTab] = useState<InspectTab>('timeline');

  const tabs: Array<{ id: InspectTab; label: string }> = [
    { id: 'timeline', label: 'Timeline' },
    { id: 'request', label: 'Request Payload' },
    { id: 'response', label: 'Response Payload' },
    { id: 'files', label: 'Files Written' },
    { id: 'errors', label: 'Errors' },
  ];

  const errorEvents = useMemo(
    () => (turn?.events ?? []).filter((event) => event.event_type === 'error'),
    [turn?.events],
  );

  if (!enabled) {
    return null;
  }

  return (
    <section className="inspect-panel">
      <details>
        <summary>Inspect</summary>
        <div className="inspect-shell">
          <div className="inspect-toolbar">
            <p className="hint">
              Correlation ID: {turn?.correlationId ?? 'No active turn'}
            </p>
            <button type="button" onClick={onExport} disabled={!turn || exporting}>
              {exporting ? 'Exporting...' : 'Export Turn Bundle'}
            </button>
          </div>

          {turn?.exportPath ? <p className="hint">Bundle: {turn.exportPath}</p> : null}
          {exportError ? <p className="tool-queue-error">{exportError}</p> : null}

          <TabsRoot
            value={tab}
            onValueChange={(nextValue) => {
              if (isInspectTab(nextValue)) {
                setTab(nextValue);
              }
            }}
          >
            <TabsList className="inspect-tabs" aria-label="Inspect tabs">
              {tabs.map((entry) => (
                <TabsTrigger key={entry.id} value={entry.id}>
                  {entry.label}
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsPanel value="timeline" className="inspect-tab-panel">
              <div className="inspect-list">
                {turn?.events.length ? (
                  turn.events.map((event, index) => (
                    <article key={`${event.timestamp_ms}-${event.event_type}-${index}`} className="inspect-item">
                      <header>
                        <strong>{event.event_type}</strong>
                        <span>{formatTs(event.timestamp_ms)}</span>
                      </header>
                      <p className="hint">{event.summary}</p>
                      <p className="hint">
                        correlation_id: {event.correlation_id}
                        {typeof event.duration_ms === 'number' ? ` · ${event.duration_ms}ms` : ''}
                      </p>
                    </article>
                  ))
                ) : (
                  <p className="hint">No events for this turn yet.</p>
                )}
              </div>
            </TabsPanel>

            <TabsPanel value="request" className="inspect-tab-panel">
              <pre className="inspect-json">{toPrettyJson({
                composed_input_breakdown: turn?.composedInputBreakdown ?? null,
                openrouter_request_json: turn?.requestPayload ?? null,
              })}</pre>
            </TabsPanel>

            <TabsPanel value="response" className="inspect-tab-panel">
              <pre className="inspect-json">{toPrettyJson(turn?.responsePayload ?? null)}</pre>
            </TabsPanel>

            <TabsPanel value="files" className="inspect-tab-panel">
              <div className="inspect-list">
                {turn?.filesWritten.length ? (
                  turn.filesWritten.map((entry) => (
                    <article key={entry.path} className="inspect-item">
                      <header>
                        <strong>{entry.path}</strong>
                      </header>
                      <p className="hint">Before: {fileStatSummary(entry.before)}</p>
                      <p className="hint">After: {fileStatSummary(entry.after)}</p>
                    </article>
                  ))
                ) : (
                  <p className="hint">No file writes recorded for this turn yet.</p>
                )}
              </div>
            </TabsPanel>

            <TabsPanel value="errors" className="inspect-tab-panel">
              <div className="inspect-list">
                {errorEvents.length > 0 ? (
                  errorEvents.map((event, index) => (
                    <article key={`${event.timestamp_ms}-${index}`} className="inspect-item">
                      <header>
                        <strong>{event.summary}</strong>
                        <span>{formatTs(event.timestamp_ms)}</span>
                      </header>
                      <pre className="inspect-json">{toPrettyJson(event.payload ?? null)}</pre>
                    </article>
                  ))
                ) : (
                  <p className="hint">No errors recorded for this turn.</p>
                )}
              </div>
            </TabsPanel>
          </TabsRoot>
        </div>
      </details>
    </section>
  );
}

export type { InspectFileWrite };
