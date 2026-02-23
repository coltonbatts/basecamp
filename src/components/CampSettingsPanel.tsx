import type { CampArtifactMetadata } from '../lib/types';

type ModelOptionWithLabel = {
  id: string;
  label: string;
};

type CampSettingsPanelProps = {
  draftName: string;
  onDraftNameChange: (value: string) => void;
  draftModelQuery: string;
  onDraftModelQueryChange: (value: string) => void;
  draftModel: string;
  onDraftModelChange: (value: string) => void;
  filteredDraftModelOptions: ModelOptionWithLabel[];
  modelOptionsWithLabels: ModelOptionWithLabel[];
  draftToolsEnabled: boolean;
  onDraftToolsEnabledChange: (enabled: boolean) => void;
  draftSystemPrompt: string;
  onDraftSystemPromptChange: (value: string) => void;
  draftMemory: string;
  onDraftMemoryChange: (value: string) => void;
  selectedDraftModelContextLength: number | null;
  activeCampPath: string | null;
  selectedArtifactIds: string[];
  artifactQuery: string;
  onArtifactQueryChange: (value: string) => void;
  visibleArtifacts: CampArtifactMetadata[];
  onToggleArtifactSelection: (artifactId: string) => void;
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function CampSettingsPanel(props: CampSettingsPanelProps) {
  return (
    <>
      <details className="camp-settings">
        <summary>Settings</summary>
        <div className="settings-grid">
          <label>
            <span>Name</span>
            <input value={props.draftName} onChange={(event) => props.onDraftNameChange(event.target.value)} />
          </label>

          <label>
            <span>Find Model</span>
            <input
              value={props.draftModelQuery}
              onChange={(event) => props.onDraftModelQueryChange(event.target.value)}
              placeholder="Search model"
            />
          </label>

          <label>
            <span>Model</span>
            <select value={props.draftModel} onChange={(event) => props.onDraftModelChange(event.target.value)}>
              {(props.filteredDraftModelOptions.length > 0
                ? props.filteredDraftModelOptions
                : props.modelOptionsWithLabels
              ).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="settings-full settings-toggle">
            <span>Enable Filesystem Tools (`context/` only)</span>
            <input
              type="checkbox"
              checked={props.draftToolsEnabled}
              onChange={(event) => props.onDraftToolsEnabledChange(event.target.checked)}
            />
          </label>

          <label className="settings-full">
            <span>System Prompt</span>
            <textarea
              value={props.draftSystemPrompt}
              onChange={(event) => props.onDraftSystemPromptChange(event.target.value)}
              rows={4}
            />
          </label>

          <label className="settings-full">
            <span>Memory JSON</span>
            <textarea value={props.draftMemory} onChange={(event) => props.onDraftMemoryChange(event.target.value)} rows={4} />
          </label>
        </div>

        <p className="hint">
          {props.selectedDraftModelContextLength ? `Context ${props.selectedDraftModelContextLength} • ` : ''}
          {props.activeCampPath ?? '-'}
        </p>
      </details>

      <details className="artifact-drawer" open={props.selectedArtifactIds.length > 0}>
        <summary>Supplies ({props.visibleArtifacts.length})</summary>
        <label>
          <span>Search</span>
          <input
            value={props.artifactQuery}
            onChange={(event) => props.onArtifactQueryChange(event.target.value)}
            placeholder="title or tag"
          />
        </label>

        <div className="artifact-scroll">
          {props.visibleArtifacts.map((artifact) => (
            <article key={artifact.id} className="artifact-item">
              <header>
                <label>
                  <input
                    type="checkbox"
                    checked={props.selectedArtifactIds.includes(artifact.id)}
                    onChange={() => props.onToggleArtifactSelection(artifact.id)}
                  />
                  <strong>{artifact.title}</strong>
                </label>
                <time>{formatDate(artifact.updated_at)}</time>
              </header>
              <p>{artifact.tags.join(', ')}</p>
            </article>
          ))}
          {props.visibleArtifacts.length === 0 ? <p className="hint">No artifacts yet.</p> : null}
        </div>
      </details>
    </>
  );
}

