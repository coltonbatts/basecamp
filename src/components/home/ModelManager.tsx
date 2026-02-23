import type { ModelRow } from '../../lib/types';

type ModelManagerProps = {
  models: ModelRow[];
  defaultModel: string;
  draftDefaultModel: string;
  isRefreshing: boolean;
  isSavingDefault: boolean;
  onRefreshModels: () => void;
  onDraftDefaultModelChange: (modelId: string) => void;
  onSaveDefaultModel: () => void;
};

function modelLabel(model: ModelRow): string {
  if (model.name && model.name.trim()) {
    return model.name;
  }

  return model.id;
}

export function ModelManager(props: ModelManagerProps) {
  return (
    <section className="command-panel model-manager" aria-label="Model manager">
      <header className="command-panel-header">
        <h2>Models</h2>
        <div className="panel-actions">
          <button type="button" onClick={props.onRefreshModels} disabled={props.isRefreshing}>
            {props.isRefreshing ? 'Refreshing' : 'Refresh'}
          </button>
          <button
            type="button"
            className="primary-action"
            onClick={props.onSaveDefaultModel}
            disabled={props.isSavingDefault || !props.draftDefaultModel}
          >
            {props.isSavingDefault ? 'Saving' : 'Set Default'}
          </button>
        </div>
      </header>

      <p className="panel-meta">Default: {props.defaultModel || 'openrouter/auto'}</p>

      <div className="model-list" role="list">
        {props.models.map((model) => {
          const isDefault = model.id === props.defaultModel;
          const isDraft = model.id === props.draftDefaultModel;

          return (
            <button
              type="button"
              key={model.id}
              role="listitem"
              className={`model-row ${isDefault ? 'is-default' : ''} ${isDraft ? 'is-draft' : ''}`}
              onClick={() => props.onDraftDefaultModelChange(model.id)}
            >
              <span className="model-row-name">{modelLabel(model)}</span>
              <span className="model-row-id">{model.id}</span>
              <span className="model-row-context">{model.context_length ?? '-'} ctx</span>
            </button>
          );
        })}
      </div>

      {props.models.length === 0 ? <p className="empty-state">No models cached. Refresh to fetch from OpenRouter.</p> : null}
    </section>
  );
}
