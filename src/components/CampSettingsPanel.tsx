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
};

export function CampSettingsPanel(props: CampSettingsPanelProps) {
  return (
    <details className="camp-settings">
      <summary>Camp Settings</summary>
      <div className="settings-grid">
        <label>
          <span>Name</span>
          <input value={props.draftName} onChange={(event) => props.onDraftNameChange(event.target.value)} />
        </label>

        <label>
          <span>Search Model</span>
          <input
            value={props.draftModelQuery}
            onChange={(event) => props.onDraftModelQueryChange(event.target.value)}
            placeholder="Search models"
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

        <label className="settings-full">
          <span>System Prompt</span>
          <textarea
            value={props.draftSystemPrompt}
            onChange={(event) => props.onDraftSystemPromptChange(event.target.value)}
            rows={6}
          />
        </label>
      </div>

      <details className="camp-settings-advanced">
        <summary>Advanced</summary>
        <div className="settings-grid">
          <label className="settings-full settings-toggle">
            <span>Enable filesystem tools (`context/` only)</span>
            <input
              type="checkbox"
              checked={props.draftToolsEnabled}
              onChange={(event) => props.onDraftToolsEnabledChange(event.target.checked)}
            />
          </label>

          <label className="settings-full">
            <span>Memory JSON</span>
            <textarea value={props.draftMemory} onChange={(event) => props.onDraftMemoryChange(event.target.value)} rows={5} />
          </label>
        </div>
      </details>

      <p className="hint">
        {props.selectedDraftModelContextLength ? `Context ${props.selectedDraftModelContextLength} • ` : ''}
        {props.activeCampPath ?? '-'}
      </p>
    </details>
  );
}
