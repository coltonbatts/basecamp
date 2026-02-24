import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { CampCard } from '../components/home/CampCard';
import {
  campCreate,
  campList,
  campLoad,
  dbListModels,
  ensureDefaultWorkspace,
  getApiKey,
  getDefaultModel,
} from '../lib/db';
import { syncModelsToDb } from '../lib/models';
import type { Camp, CampSummary, ModelRow } from '../lib/types';
import './HomeView.css';

const FALLBACK_MODEL = 'openrouter/auto';

type HomeCampMeta = {
  promptPreview: string;
};

function firstNonEmptyLine(value: string): string | null {
  const line = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);

  return line ?? null;
}

function oneLinePreview(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (!singleLine) {
    return 'No context yet.';
  }

  if (singleLine.length <= 120) {
    return singleLine;
  }

  return `${singleLine.slice(0, 117)}...`;
}

function campPreview(camp: Camp): string {
  const fromPrompt = firstNonEmptyLine(camp.system_prompt);
  if (fromPrompt) {
    return oneLinePreview(fromPrompt);
  }

  const fromTranscript = [...camp.transcript]
    .reverse()
    .find((message) => message.role !== 'tool' && message.content.trim().length > 0)?.content;

  if (fromTranscript) {
    return oneLinePreview(fromTranscript);
  }

  return 'No context yet.';
}

function modelDisplayLabel(model: ModelRow): string {
  const ctx = model.context_length ? ` · ${(model.context_length / 1000).toFixed(0)}k ctx` : '';
  const name = model.name?.trim() ? model.name : model.id;
  return `${name}${ctx}`;
}

export function HomeView() {
  const navigate = useNavigate();

  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [camps, setCamps] = useState<CampSummary[]>([]);
  const [campMetaById, setCampMetaById] = useState<Record<string, HomeCampMeta>>({});

  const [models, setModels] = useState<ModelRow[]>([]);
  const [defaultModel, setDefaultModel] = useState(FALLBACK_MODEL);

  const [newCampName, setNewCampName] = useState('New Camp');
  const [newCampModel, setNewCampModel] = useState(FALLBACK_MODEL);
  const [campQuery, setCampQuery] = useState('');

  const [isBooting, setIsBooting] = useState(true);
  const [isCreatingCamp, setIsCreatingCamp] = useState(false);
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const modelOptions = useMemo(() => {
    const options = new Map<string, string>();

    options.set(FALLBACK_MODEL, FALLBACK_MODEL);
    for (const model of models) {
      options.set(model.id, modelDisplayLabel(model));
    }

    const normalizedDefault = defaultModel.trim();
    if (normalizedDefault && !options.has(normalizedDefault)) {
      options.set(normalizedDefault, normalizedDefault);
    }

    return Array.from(options.entries()).map(([id, label]) => ({ id, label }));
  }, [defaultModel, models]);

  const visibleCamps = useMemo(() => {
    const normalizedQuery = campQuery.trim().toLowerCase();

    const sorted = [...camps].sort((left, right) => right.updated_at - left.updated_at);
    if (!normalizedQuery) {
      return sorted;
    }

    return sorted.filter((camp) => {
      const preview = campMetaById[camp.id]?.promptPreview ?? '';
      return (
        camp.name.toLowerCase().includes(normalizedQuery) ||
        camp.model.toLowerCase().includes(normalizedQuery) ||
        preview.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [campMetaById, campQuery, camps]);

  const resetFeedback = () => {
    setError(null);
    setStatus(null);
  };

  const loadModels = useCallback(async () => {
    const rows = await dbListModels();
    setModels(rows);
  }, []);

  const loadDefaultModel = useCallback(async () => {
    const value = (await getDefaultModel()) ?? FALLBACK_MODEL;
    const normalized = value.trim() || FALLBACK_MODEL;

    setDefaultModel(normalized);
    setNewCampModel(normalized);
  }, []);

  const loadCamps = useCallback(async () => {
    const rows = await campList();
    setCamps(rows);

    const metadataEntries = await Promise.all(
      rows.map(async (camp) => {
        try {
          const fullCamp = await campLoad(camp.id);
          return [camp.id, { promptPreview: campPreview(fullCamp) }] as const;
        } catch {
          return [camp.id, { promptPreview: 'Unable to read camp preview.' }] as const;
        }
      }),
    );

    setCampMetaById(Object.fromEntries(metadataEntries));
  }, []);

  useEffect(() => {
    const boot = async () => {
      setIsBooting(true);
      resetFeedback();

      try {
        const defaultWorkspacePath = await ensureDefaultWorkspace();
        setWorkspacePath(defaultWorkspacePath);

        await Promise.all([loadModels(), loadDefaultModel(), loadCamps()]);
      } catch (bootError) {
        setError(bootError instanceof Error ? bootError.message : 'Unable to load home view.');
      } finally {
        setIsBooting(false);
      }
    };

    void boot();
  }, [loadCamps, loadDefaultModel, loadModels]);

  const handleCreateCamp = async () => {
    if (!workspacePath) {
      setError('Workspace folder is not ready yet.');
      return;
    }

    setIsCreatingCamp(true);
    resetFeedback();

    try {
      const created = await campCreate({
        name: newCampName.trim() || 'New Camp',
        model: newCampModel.trim() || defaultModel,
        system_prompt: '',
        memory: {},
        tools_enabled: false,
      });

      setNewCampName('New Camp');
      await loadCamps();
      navigate(`/camp/${created.config.id}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create camp.');
    } finally {
      setIsCreatingCamp(false);
    }
  };

  const handleRefreshModels = async () => {
    setIsRefreshingModels(true);
    resetFeedback();

    try {
      const apiKey = await getApiKey();
      if (!apiKey) {
        throw new Error('OpenRouter API key is missing. Configure it in Settings first.');
      }

      const { count } = await syncModelsToDb(apiKey);
      await loadModels();
      setStatus(`Refreshed ${count} models from OpenRouter.`);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Unable to refresh models.');
    } finally {
      setIsRefreshingModels(false);
    }
  };

  return (
    <div className="home-dashboard" aria-busy={isBooting}>
      <header className="home-dashboard-header">
        <div>
          <h1>Basecamp</h1>
          <p>{workspacePath ?? 'Loading workspace...'}</p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button type="button" onClick={() => navigate('/arena')}>
            Arena
          </button>
          <button type="button" onClick={handleRefreshModels} disabled={isRefreshingModels || isBooting}>
            {isRefreshingModels ? 'Refreshing Models' : 'Refresh Models'}
          </button>
        </div>
      </header>

      {status ? <p className="status-line">{status}</p> : null}
      {error ? <p className="error-line">{error}</p> : null}

      <section className="home-create-camp" aria-label="Create camp">
        <label>
          <span>Camp Name</span>
          <input
            value={newCampName}
            onChange={(event) => setNewCampName(event.target.value)}
            placeholder="New Camp"
            aria-label="New camp name"
          />
        </label>

        <label>
          <span>Model</span>
          <select value={newCampModel} onChange={(event) => setNewCampModel(event.target.value)}>
            {modelOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <button type="button" className="primary-action" onClick={handleCreateCamp} disabled={isCreatingCamp || isBooting}>
          {isCreatingCamp ? 'Creating Camp' : 'Create Camp'}
        </button>
      </section>

      <section className="home-camp-list" aria-label="Camp list">
        <header>
          <h2>Camps</h2>
          <div>
            <span>{visibleCamps.length} shown</span>
            <label>
              <span>Search</span>
              <input
                value={campQuery}
                onChange={(event) => setCampQuery(event.target.value)}
                placeholder="Search camps"
                aria-label="Search camps"
              />
            </label>
          </div>
        </header>

        <div className="home-camp-grid" role="list">
          {visibleCamps.map((camp) => (
            <CampCard
              key={camp.id}
              camp={camp}
              promptPreview={campMetaById[camp.id]?.promptPreview ?? 'No context yet.'}
              onOpen={() => navigate(`/camp/${camp.id}`)}
            />
          ))}
          {visibleCamps.length === 0 ? <p className="empty-state">No camps match this search.</p> : null}
        </div>
      </section>
    </div>
  );
}
