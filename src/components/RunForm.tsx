import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';

import type { ModelOption, RunFormValues } from '../lib/types';
import { ModelPicker } from './ModelPicker';

type RunFormProps = {
  models: ModelOption[];
  cachedModelCount: number;
  modelsLastSync: number | null;
  modelsLoadError: string | null;
  isRunning: boolean;
  apiKeyMissing: boolean;
  onRun: (values: RunFormValues) => Promise<void>;
  onClear: () => void;
};

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_TOKENS = 512;
const AUTO_MODEL_ID = 'openrouter/auto';

function parseNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatLastSync(lastSync: number | null): string {
  if (!lastSync) {
    return 'never';
  }

  return new Date(lastSync).toLocaleString();
}

export function RunForm({
  models,
  cachedModelCount,
  modelsLastSync,
  modelsLoadError,
  isRunning,
  apiKeyMissing,
  onRun,
  onClear,
}: RunFormProps) {
  const fallbackModelOptions = useMemo(() => models.filter((option) => option.id !== AUTO_MODEL_ID), [models]);
  const [model, setModel] = useState(models[0]?.id ?? '');
  const [fallbackModel, setFallbackModel] = useState(fallbackModelOptions[0]?.id ?? '');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [userPrompt, setUserPrompt] = useState('');
  const [temperature, setTemperature] = useState(DEFAULT_TEMPERATURE);
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS);
  const [localError, setLocalError] = useState<string | null>(null);

  const selectedModel = models.some((option) => option.id === model) ? model : models[0]?.id ?? '';
  const selectedFallbackModel = fallbackModelOptions.some((option) => option.id === fallbackModel)
    ? fallbackModel
    : fallbackModelOptions[0]?.id ?? '';

  const submitRun = async () => {
    if (!userPrompt.trim()) {
      setLocalError('User prompt is required.');
      return;
    }

    setLocalError(null);
    await onRun({
      model: selectedModel,
      fallbackModel: selectedModel === AUTO_MODEL_ID ? selectedFallbackModel : null,
      systemPrompt,
      userPrompt,
      temperature,
      maxTokens,
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await submitRun();
  };

  const handleClear = () => {
    setSystemPrompt('');
    setUserPrompt('');
    setTemperature(DEFAULT_TEMPERATURE);
    setMaxTokens(DEFAULT_MAX_TOKENS);
    setLocalError(null);
    onClear();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void submitRun();
    }
  };

  return (
    <form className="panel run-form" onSubmit={handleSubmit} onKeyDown={handleKeyDown}>
      <h2>Run</h2>
      <ModelPicker models={models} value={selectedModel} onChange={setModel} />
      <p className="model-cache-status">
        Models: {cachedModelCount} cached | Last sync: {formatLastSync(modelsLastSync)}
      </p>
      {cachedModelCount === 0 && <p className="inline-warning">No models cached. Go to Settings and Sync Models.</p>}
      {modelsLoadError && <p className="inline-warning">{modelsLoadError}</p>}
      {selectedModel === AUTO_MODEL_ID && fallbackModelOptions.length > 0 && (
        <label className="field">
          <span>Auto Fallback Model</span>
          <select value={selectedFallbackModel} onChange={(event) => setFallbackModel(event.target.value)}>
            {fallbackModelOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="field">
        <span>System Prompt (optional)</span>
        <textarea
          value={systemPrompt}
          onChange={(event) => setSystemPrompt(event.target.value)}
          rows={4}
          placeholder="You are an expert assistant..."
        />
      </label>

      <label className="field">
        <span>User Prompt</span>
        <textarea
          value={userPrompt}
          onChange={(event) => setUserPrompt(event.target.value)}
          rows={6}
          placeholder="Ask something..."
          required
        />
      </label>

      <div className="inline-grid">
        <label className="field">
          <span>Temperature</span>
          <input
            type="number"
            value={temperature}
            min={0}
            max={2}
            step={0.1}
            onChange={(event) => setTemperature(parseNumber(event.target.value, DEFAULT_TEMPERATURE))}
          />
        </label>

        <label className="field">
          <span>Max Tokens</span>
          <input
            type="number"
            value={maxTokens}
            min={1}
            step={1}
            onChange={(event) => setMaxTokens(parseNumber(event.target.value, DEFAULT_MAX_TOKENS))}
          />
        </label>
      </div>

      {(localError || apiKeyMissing) && (
        <p className="inline-warning">{localError ?? 'OpenRouter API key is missing. Set it in Settings.'}</p>
      )}

      <div className="button-row">
        <button type="submit" disabled={isRunning}>
          {isRunning ? 'Running...' : 'Run'}
        </button>
        <button type="button" className="secondary" onClick={handleClear} disabled={isRunning}>
          Clear
        </button>
      </div>

      <p className="hint">Shortcut: Cmd/Ctrl + Enter</p>
    </form>
  );
}
