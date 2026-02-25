import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { CampCard } from '../components/home/CampCard';
import { Field } from '../components/ui/Field';
import {
  campCreate,
  campList,
  campLoad,
  campDelete,
  dbListModels,
  ensureDefaultWorkspace,
  getDefaultModel,
  providersList,
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
  // Previously this was `[${model.provider_kind}] ${name}`
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
  const [newCampProviderFilter, setNewCampProviderFilter] = useState('all');
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
      if (newCampProviderFilter !== 'all' && model.provider_kind !== newCampProviderFilter) {
        continue;
      }
      options.set(model.id, modelDisplayLabel(model));
    }

    const normalizedDefault = defaultModel.trim();
    if (normalizedDefault && !options.has(normalizedDefault)) {
      options.set(normalizedDefault, normalizedDefault);
    }

    return Array.from(options.entries()).map(([id, label]) => ({ id, label }));
  }, [defaultModel, models, newCampProviderFilter]);

  const providerOptions = useMemo(
    () => Array.from(new Set(models.map((model) => model.provider_kind))).sort((a, b) => a.localeCompare(b)),
    [models],
  );

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

  const loadProviders = useCallback(async () => {
    // Only invoke providersList to cache internally/fire any side effects,
    // since we removed the visual representation from the Home UI.
    await providersList();
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

        await Promise.all([loadModels(), loadDefaultModel(), loadCamps(), loadProviders()]);
      } catch (bootError) {
        setError(bootError instanceof Error ? bootError.message : 'Unable to load home view.');
      } finally {
        setIsBooting(false);
      }
    };

    void boot();
  }, [loadCamps, loadDefaultModel, loadModels, loadProviders]);

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
        system_prompt: 'You are Basecamp, an expert AI assistant. You have access to tools that allow you to read, write, and manage files in the user\'s workspace. You can generate rich multimodal artifacts like PDFs, images, and HTML. When asked to create a file, image, or PDF, you MUST use the `write_file` or `create_artifact` tools to generate it. For binary formats like images or PDFs, always use the `base64` encoding parameter. Do NOT refuse to create files, and do NOT output raw base64 or binary data into the chat. Always use the provided tools.',
        tools_enabled: true,
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

  const handleDeleteCamp = async (campId: string, campName: string) => {
    if (!window.confirm(`Are you sure you want to delete "${campName}"? This action cannot be undone.`)) {
      return;
    }

    try {
      await campDelete(campId);
      // Refresh the camp list to reflect the deletion
      await loadCamps();
      setStatus(`Deleted camp "${campName}".`);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete camp.');
    }
  };

  const handleRefreshModels = async () => {
    setIsRefreshingModels(true);
    resetFeedback();

    try {
      const { count } = await syncModelsToDb();
      await Promise.all([loadModels(), loadProviders()]);
      setStatus(`Refreshed ${count} models from enabled providers.`);
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
          <button type="button" onClick={() => navigate('/settings')}>
            Settings
          </button>
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
        <Field label="Camp Name">
          <input
            value={newCampName}
            onChange={(event) => setNewCampName(event.target.value)}
            placeholder="New Camp"
            aria-label="New camp name"
          />
        </Field>

        <Field label="Provider">
          <select value={newCampProviderFilter} onChange={(event) => setNewCampProviderFilter(event.target.value)}>
            <option value="all">All providers</option>
            {providerOptions.map((providerKind) => (
              <option key={providerKind} value={providerKind}>
                {providerKind}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Model">
          <select value={newCampModel} onChange={(event) => setNewCampModel(event.target.value)}>
            {modelOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <button type="button" className="primary-action" onClick={handleCreateCamp} disabled={isCreatingCamp || isBooting}>
          {isCreatingCamp ? 'INITIALIZING CAMP...' : 'ESTABLISH BASECAMP'}
        </button>
      </section>

      <section className="home-camp-list" aria-label="Camp list">
        <header>
          <h2>Camps</h2>
          <div>
            <span>{visibleCamps.length} shown</span>
            <Field label="Search">
              <input
                value={campQuery}
                onChange={(event) => setCampQuery(event.target.value)}
                placeholder="Search camps"
                aria-label="Search camps"
              />
            </Field>
          </div>
        </header>

        <div className="home-camp-grid" role="list">
          {visibleCamps.map((camp) => (
            <CampCard
              key={camp.id}
              camp={camp}
              promptPreview={campMetaById[camp.id]?.promptPreview ?? 'No context yet.'}
              onOpen={() => navigate(`/camp/${camp.id}`)}
              onDelete={() => void handleDeleteCamp(camp.id, camp.name)}
            />
          ))}
          {visibleCamps.length === 0 ? <p className="empty-state">No camps match this search.</p> : null}
        </div>
      </section>
    </div>
  );
}
