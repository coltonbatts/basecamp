import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { CampCard } from '../components/home/CampCard';
import { ContextManager } from '../components/home/ContextManager';
import { ModelManager } from '../components/home/ModelManager';
import {
  campAttachWorkspaceContextFile,
  campCreate,
  campDetachWorkspaceContextFile,
  campList,
  campListArtifacts,
  campListContextFiles,
  campLoad,
  campUpdateConfig,
  campUpdateSystemPrompt,
  dbListModels,
  ensureDefaultWorkspace,
  getApiKey,
  getDefaultModel,
  setDefaultModel,
  workspaceListContextFiles,
} from '../lib/db';
import { syncModelsToDb } from '../lib/models';
import type { Camp, CampSummary, ModelRow } from '../lib/types';
import './HomeView.css';

const FALLBACK_MODEL = 'openrouter/auto';

type HomeCampMeta = {
  artifactCount: number;
  promptPreview: string;
};

function compactPromptPreview(prompt: string): string {
  const line = prompt
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0);

  if (!line) {
    return 'No system prompt.';
  }

  if (line.length <= 120) {
    return line;
  }

  return `${line.slice(0, 117)}...`;
}

function modelDisplayLabel(model: ModelRow): string {
  if (model.name && model.name.trim()) {
    return `${model.name} (${model.id})`;
  }

  return model.id;
}

export function HomeView() {
  const navigate = useNavigate();

  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [camps, setCamps] = useState<CampSummary[]>([]);
  const [campMetaById, setCampMetaById] = useState<Record<string, HomeCampMeta>>({});
  const [selectedCampId, setSelectedCampId] = useState<string | null>(null);

  const [selectedCamp, setSelectedCamp] = useState<Camp | null>(null);
  const [selectedCampModel, setSelectedCampModel] = useState(FALLBACK_MODEL);
  const [selectedCampPrompt, setSelectedCampPrompt] = useState('');
  const [attachedContextFiles, setAttachedContextFiles] = useState<string[]>([]);

  const [models, setModels] = useState<ModelRow[]>([]);
  const [defaultModel, setDefaultModelValue] = useState(FALLBACK_MODEL);
  const [draftDefaultModel, setDraftDefaultModel] = useState(FALLBACK_MODEL);

  const [newCampName, setNewCampName] = useState('New Camp');
  const [newCampModel, setNewCampModel] = useState(FALLBACK_MODEL);

  const [globalContextFiles, setGlobalContextFiles] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<'models' | 'context'>('models');

  const [isBooting, setIsBooting] = useState(true);
  const [isCreatingCamp, setIsCreatingCamp] = useState(false);
  const [isSavingCamp, setIsSavingCamp] = useState(false);
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const [isSavingDefaultModel, setIsSavingDefaultModel] = useState(false);
  const [isRefreshingContext, setIsRefreshingContext] = useState(false);
  const [isMutatingContext, setIsMutatingContext] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const modelOptions = useMemo(() => {
    const options = new Map<string, string>();

    options.set(FALLBACK_MODEL, FALLBACK_MODEL);
    for (const model of models) {
      options.set(model.id, modelDisplayLabel(model));
    }

    for (const value of [defaultModel, draftDefaultModel, newCampModel, selectedCampModel]) {
      const trimmed = value.trim();
      if (!trimmed || options.has(trimmed)) {
        continue;
      }

      options.set(trimmed, trimmed);
    }

    return Array.from(options.entries()).map(([id, label]) => ({ id, label }));
  }, [defaultModel, draftDefaultModel, models, newCampModel, selectedCampModel]);

  const activeCampMeta = selectedCampId ? campMetaById[selectedCampId] : undefined;

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

    setDefaultModelValue(normalized);
    setDraftDefaultModel(normalized);
    setNewCampModel(normalized);
  }, []);

  const loadCamps = useCallback(async () => {
    const rows = await campList();
    setCamps(rows);
    setSelectedCampId((previous) => {
      if (previous && rows.some((camp) => camp.id === previous)) {
        return previous;
      }

      return rows[0]?.id ?? null;
    });

    const metadataEntries = await Promise.all(
      rows.map(async (camp) => {
        try {
          const [campData, artifacts] = await Promise.all([campLoad(camp.id), campListArtifacts(camp.id)]);
          return [
            camp.id,
            {
              artifactCount: artifacts.length,
              promptPreview: compactPromptPreview(campData.system_prompt),
            },
          ] as const;
        } catch {
          return [
            camp.id,
            {
              artifactCount: 0,
              promptPreview: 'Unable to load system prompt.',
            },
          ] as const;
        }
      }),
    );

    setCampMetaById(Object.fromEntries(metadataEntries));
  }, []);

  const loadGlobalContextFiles = useCallback(async () => {
    const files = await workspaceListContextFiles();
    setGlobalContextFiles(files.filter((entry) => !entry.endsWith('/')));
  }, []);

  const loadCampContextFiles = useCallback(async (campId: string): Promise<string[]> => {
    const pendingDirectories = [''];
    const visitedDirectories = new Set<string>(['']);
    const discoveredFiles = new Set<string>();

    while (pendingDirectories.length > 0) {
      const currentPath = pendingDirectories.pop() ?? '';
      const entries = await campListContextFiles(campId, currentPath || undefined);

      for (const entry of entries) {
        if (entry.endsWith('/')) {
          if (!visitedDirectories.has(entry)) {
            visitedDirectories.add(entry);
            pendingDirectories.push(entry);
          }
          continue;
        }

        discoveredFiles.add(entry);
      }
    }

    return [...discoveredFiles].sort();
  }, []);

  const loadSelectedCamp = useCallback(async (campId: string) => {
    const [camp, contextFiles] = await Promise.all([campLoad(campId), loadCampContextFiles(campId)]);

    setSelectedCamp(camp);
    setSelectedCampModel(camp.config.model);
    setSelectedCampPrompt(camp.system_prompt);
    setAttachedContextFiles(contextFiles);
  }, [loadCampContextFiles]);

  useEffect(() => {
    const boot = async () => {
      setIsBooting(true);
      resetFeedback();

      try {
        const defaultWorkspacePath = await ensureDefaultWorkspace();
        setWorkspacePath(defaultWorkspacePath);

        await Promise.all([loadModels(), loadDefaultModel(), loadCamps(), loadGlobalContextFiles()]);
      } catch (bootError) {
        setError(bootError instanceof Error ? bootError.message : 'Unable to load home view.');
      } finally {
        setIsBooting(false);
      }
    };

    void boot();
  }, [loadCamps, loadDefaultModel, loadGlobalContextFiles, loadModels]);

  useEffect(() => {
    if (!selectedCampId) {
      setSelectedCamp(null);
      setSelectedCampPrompt('');
      setSelectedCampModel(defaultModel);
      setAttachedContextFiles([]);
      return;
    }

    void loadSelectedCamp(selectedCampId).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load selected camp.');
    });
  }, [defaultModel, loadSelectedCamp, selectedCampId]);

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

      await loadCamps();
      setSelectedCampId(created.config.id);
      setNewCampName('New Camp');
      setStatus(`Created camp ${created.config.name}.`);
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

  const handleSaveDefaultModel = async () => {
    setIsSavingDefaultModel(true);
    resetFeedback();

    try {
      await setDefaultModel(draftDefaultModel);
      setDefaultModelValue(draftDefaultModel);
      setStatus(`Default model set to ${draftDefaultModel}.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save default model.');
    } finally {
      setIsSavingDefaultModel(false);
    }
  };

  const handleSaveActiveCamp = async () => {
    if (!selectedCampId || !selectedCamp) {
      return;
    }

    setIsSavingCamp(true);
    resetFeedback();

    try {
      await campUpdateConfig({
        camp_id: selectedCampId,
        name: selectedCamp.config.name,
        model: selectedCampModel,
        tools_enabled: selectedCamp.config.tools_enabled,
      });

      await campUpdateSystemPrompt({
        camp_id: selectedCampId,
        system_prompt: selectedCampPrompt,
      });

      await Promise.all([loadSelectedCamp(selectedCampId), loadCamps()]);
      setStatus(`Saved ${selectedCamp.config.name}.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save active camp.');
    } finally {
      setIsSavingCamp(false);
    }
  };

  const handleRefreshContext = async () => {
    setIsRefreshingContext(true);
    resetFeedback();

    try {
      await loadGlobalContextFiles();
      if (selectedCampId) {
        await loadSelectedCamp(selectedCampId);
      }
      setStatus('Context list refreshed.');
    } catch (contextError) {
      setError(contextError instanceof Error ? contextError.message : 'Unable to refresh context files.');
    } finally {
      setIsRefreshingContext(false);
    }
  };

  const handleAttachContext = async (path: string) => {
    if (!selectedCampId) {
      return;
    }

    setIsMutatingContext(true);
    resetFeedback();

    try {
      await campAttachWorkspaceContextFile(selectedCampId, path);
      await Promise.all([loadSelectedCamp(selectedCampId), loadCamps()]);
      setStatus(`Attached ${path}.`);
    } catch (attachError) {
      setError(attachError instanceof Error ? attachError.message : 'Unable to attach context file.');
    } finally {
      setIsMutatingContext(false);
    }
  };

  const handleDetachContext = async (path: string) => {
    if (!selectedCampId) {
      return;
    }

    setIsMutatingContext(true);
    resetFeedback();

    try {
      await campDetachWorkspaceContextFile(selectedCampId, path);
      await Promise.all([loadSelectedCamp(selectedCampId), loadCamps()]);
      setStatus(`Detached ${path}.`);
    } catch (detachError) {
      setError(detachError instanceof Error ? detachError.message : 'Unable to detach context file.');
    } finally {
      setIsMutatingContext(false);
    }
  };

  const openCampWorkspace = (campId: string) => {
    navigate(`/camp/${campId}`);
  };

  return (
    <div className="command-deck">
      <header className="deck-topbar">
        <div className="deck-branding">
          <h1>BASECAMP</h1>
          <p>{workspacePath ?? 'Loading workspace...'}</p>
        </div>

        <div className="deck-top-actions">
          <button type="button" className="primary-action" onClick={handleCreateCamp} disabled={isCreatingCamp || isBooting}>
            {isCreatingCamp ? 'Creating Camp' : 'New Camp'}
          </button>
          <button type="button" onClick={handleRefreshModels} disabled={isRefreshingModels || isBooting}>
            {isRefreshingModels ? 'Refreshing Models' : 'Refresh Models'}
          </button>
        </div>
      </header>

      {status ? <p className="status-line">{status}</p> : null}
      {error ? <p className="error-line">{error}</p> : null}

      <main className="deck-layout" aria-busy={isBooting}>
        <section className="deck-zone deck-camps" aria-label="Camps">
          <div className="zone-header">
            <h2>Camps</h2>
            <span>{camps.length}</span>
          </div>

          <div className="new-camp-form">
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
          </div>

          <div className="camp-list" role="list">
            {camps.map((camp) => (
              <CampCard
                key={camp.id}
                camp={camp}
                promptPreview={campMetaById[camp.id]?.promptPreview ?? 'No system prompt.'}
                artifactCount={campMetaById[camp.id]?.artifactCount ?? 0}
                isActive={camp.id === selectedCampId}
                onPreview={() => setSelectedCampId(camp.id)}
                onOpen={() => openCampWorkspace(camp.id)}
              />
            ))}
          </div>
        </section>

        <section className="deck-zone deck-active" aria-label="Active camp preview">
          <div className="zone-header">
            <h2>Active Camp</h2>
          </div>

          {selectedCamp ? (
            <>
              <p className="active-camp-name">{selectedCamp.config.name}</p>
              <p className="active-camp-path">{selectedCamp.config.id}</p>

              <label>
                <span>Model</span>
                <select value={selectedCampModel} onChange={(event) => setSelectedCampModel(event.target.value)}>
                  {modelOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>System Prompt</span>
                <textarea
                  rows={8}
                  value={selectedCampPrompt}
                  onChange={(event) => setSelectedCampPrompt(event.target.value)}
                  placeholder="Set the camp system prompt"
                />
              </label>

              <section className="active-context-list" aria-label="Attached context files">
                <h3>Attached Context</h3>
                <div className="tag-list">
                  {attachedContextFiles.map((path) => (
                    <span key={path} className="tag-item">
                      {path}
                    </span>
                  ))}
                  {attachedContextFiles.length === 0 ? <p className="empty-state">No context attached.</p> : null}
                </div>
              </section>

              <p className="panel-meta">Last updated: {new Date(selectedCamp.config.updated_at).toLocaleString()}</p>

              <div className="panel-actions">
                <button type="button" onClick={handleSaveActiveCamp} disabled={isSavingCamp}>
                  {isSavingCamp ? 'Saving' : 'Save Camp'}
                </button>
                <button type="button" className="primary-action" onClick={() => openCampWorkspace(selectedCamp.config.id)}>
                  Open Camp
                </button>
              </div>
            </>
          ) : (
            <p className="empty-state">No camp selected.</p>
          )}

          {activeCampMeta ? (
            <div className="active-camp-meta">
              <span>{activeCampMeta.artifactCount} artifacts</span>
              <span>{activeCampMeta.promptPreview}</span>
            </div>
          ) : null}
        </section>

        <section className="deck-zone deck-right" aria-label="Models and context">
          <div className="tab-row" role="tablist" aria-label="Right panel tabs">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'models'}
              className={activeTab === 'models' ? 'tab-active' : ''}
              onClick={() => setActiveTab('models')}
            >
              Models
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'context'}
              className={activeTab === 'context' ? 'tab-active' : ''}
              onClick={() => setActiveTab('context')}
            >
              Context
            </button>
          </div>

          {activeTab === 'models' ? (
            <ModelManager
              models={models}
              defaultModel={defaultModel}
              draftDefaultModel={draftDefaultModel}
              onDraftDefaultModelChange={setDraftDefaultModel}
              onRefreshModels={handleRefreshModels}
              onSaveDefaultModel={handleSaveDefaultModel}
              isRefreshing={isRefreshingModels}
              isSavingDefault={isSavingDefaultModel}
            />
          ) : (
            <ContextManager
              globalFiles={globalContextFiles}
              attachedFiles={attachedContextFiles}
              selectedCampId={selectedCampId}
              isRefreshing={isRefreshingContext}
              isMutating={isMutatingContext}
              onRefresh={handleRefreshContext}
              onAttach={handleAttachContext}
              onDetach={handleDetachContext}
            />
          )}
        </section>
      </main>
    </div>
  );
}
