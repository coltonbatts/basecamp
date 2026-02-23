import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import './App.css';
import { CampSettingsPanel } from './components/CampSettingsPanel';
import { TranscriptView } from './components/TranscriptView';
import { useArtifactComposerState } from './hooks/useArtifactComposerState';
import {
  campAppendMessage,
  campCreate,
  campCreateArtifactFromMessage,
  campGetArtifact,
  campIncrementArtifactUsage,
  campListContextFiles,
  campList,
  campListArtifacts,
  campLoad,
  campReadContextFile,
  campUpdateConfig,
  campUpdateMemory,
  campUpdateSystemPrompt,
  campWriteContextFile,
  dbListModels,
  ensureDefaultWorkspace,
  getApiKey,
  pickWorkspaceFolder,
  setWorkspacePath,
} from './lib/db';
import { runCampChatRuntime } from './lib/campChatRuntime';
import { syncModelsToDb } from './lib/models';
import { OpenRouterRequestError, type OpenRouterChatRequestPayload } from './lib/openrouter';
import { executeFilesystemToolCall, FILESYSTEM_TOOLS } from './lib/tools';
import type { Camp, CampArtifactMetadata, CampMessage, CampSummary, ModelRow } from './lib/types';

const FALLBACK_MODEL = 'openrouter/auto';
const DEFAULT_MAX_TOKENS = 1200;
const DEFAULT_TEMPERATURE = 0.3;

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return '{}';
  }
}

function parseJsonInput(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  return JSON.parse(trimmed);
}

function computeProgressLabel(artifactCount: number): 'Basecamp' | 'Ridge' | 'Summit' {
  if (artifactCount >= 8) {
    return 'Summit';
  }

  if (artifactCount >= 3) {
    return 'Ridge';
  }

  return 'Basecamp';
}

function modelDisplayLabel(model: ModelRow): string {
  if (model.name && model.name.trim()) {
    return `${model.name} (${model.id})`;
  }

  return model.id;
}

export default function App() {
  const [workspacePath, setWorkspacePathValue] = useState<string | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [camps, setCamps] = useState<CampSummary[]>([]);
  const [selectedCampId, setSelectedCampId] = useState<string | null>(null);
  const [selectedCamp, setSelectedCamp] = useState<Camp | null>(null);
  const [artifacts, setArtifacts] = useState<CampArtifactMetadata[]>([]);

  const [draftName, setDraftName] = useState('');
  const [draftModel, setDraftModel] = useState(FALLBACK_MODEL);
  const [draftToolsEnabled, setDraftToolsEnabled] = useState(false);
  const [draftSystemPrompt, setDraftSystemPrompt] = useState('');
  const [draftMemory, setDraftMemory] = useState('{}');

  const [newCampName, setNewCampName] = useState('New Camp');
  const [newCampModel, setNewCampModel] = useState(FALLBACK_MODEL);
  const [newCampModelQuery, setNewCampModelQuery] = useState('');
  const [draftModelQuery, setDraftModelQuery] = useState('');
  const {
    artifactQuery,
    setArtifactQuery,
    selectedArtifactIds,
    artifactById,
    visibleArtifacts,
    selectedArtifactsForComposer,
    toggleArtifactSelection,
    removeSelectedArtifact,
    clearSelectedArtifacts,
    pruneSelectedArtifacts,
  } = useArtifactComposerState(artifacts);

  const [userMessage, setUserMessage] = useState('');
  const [temperature, setTemperature] = useState(DEFAULT_TEMPERATURE);
  const [maxTokens, setMaxTokens] = useState(DEFAULT_MAX_TOKENS);

  const [streamingText, setStreamingText] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isSyncingModels, setIsSyncingModels] = useState(false);
  const [promotingMessageId, setPromotingMessageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [lastRequestPreview, setLastRequestPreview] = useState<OpenRouterChatRequestPayload | null>(null);

  const modelOptions = useMemo(
    () => (models.length > 0 ? models.map((model) => model.id) : [FALLBACK_MODEL]),
    [models],
  );
  const modelOptionsWithLabels = useMemo(
    () => (models.length > 0 ? models.map((model) => ({ id: model.id, label: modelDisplayLabel(model) })) : [{ id: FALLBACK_MODEL, label: FALLBACK_MODEL }]),
    [models],
  );
  const modelById = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);
  const filteredCreateModelOptions = useMemo(() => {
    const query = newCampModelQuery.trim().toLowerCase();
    if (!query) {
      return modelOptionsWithLabels;
    }

    return modelOptionsWithLabels.filter((option) => option.label.toLowerCase().includes(query) || option.id.toLowerCase().includes(query));
  }, [modelOptionsWithLabels, newCampModelQuery]);
  const filteredDraftModelOptions = useMemo(() => {
    const query = draftModelQuery.trim().toLowerCase();
    if (!query) {
      return modelOptionsWithLabels;
    }

    return modelOptionsWithLabels.filter((option) => option.label.toLowerCase().includes(query) || option.id.toLowerCase().includes(query));
  }, [modelOptionsWithLabels, draftModelQuery]);
  const selectedDraftModel = modelById.get(draftModel) ?? null;

  const artifactCount = artifacts.length;
  const reusedArtifactCount = artifacts.filter((artifact) => artifact.usage_count > 0).length;
  const conversationTurnCount = selectedCamp?.transcript.filter((message) => message.role === 'user').length ?? 0;
  const progressionLabel = computeProgressLabel(artifactCount);
  const activeCampSummary = camps.find((camp) => camp.id === selectedCampId) ?? null;

  const loadModels = useCallback(async () => {
    const rows = await dbListModels();
    setModels(rows);
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
  }, []);

  const loadArtifacts = useCallback(async (campId: string) => {
    const rows = await campListArtifacts(campId);
    setArtifacts(rows);
    pruneSelectedArtifacts(rows.map((artifact) => artifact.id));
  }, [pruneSelectedArtifacts]);

  const loadSelectedCamp = useCallback(
    async (campId: string) => {
      const [camp, artifactRows] = await Promise.all([campLoad(campId), campListArtifacts(campId)]);
      setSelectedCamp(camp);
      setArtifacts(artifactRows);
      setDraftName(camp.config.name);
      setDraftModel(camp.config.model);
      setDraftToolsEnabled(camp.config.tools_enabled);
      setDraftModelQuery('');
      setDraftSystemPrompt(camp.system_prompt);
      setDraftMemory(prettyJson(camp.memory));
      clearSelectedArtifacts();
    },
    [clearSelectedArtifacts],
  );

  useEffect(() => {
    const boot = async () => {
      try {
        await loadModels();
        const defaultWorkspacePath = await ensureDefaultWorkspace();
        setWorkspacePathValue(defaultWorkspacePath);
        await loadCamps();
      } catch (bootError) {
        setError(bootError instanceof Error ? bootError.message : 'Unable to load app state.');
      }
    };

    void boot();
  }, [loadCamps, loadModels]);

  useEffect(() => {
    if (!modelOptions.includes(newCampModel)) {
      setNewCampModel(modelOptions[0] ?? FALLBACK_MODEL);
    }
  }, [modelOptions, newCampModel]);

  useEffect(() => {
    if (!modelOptions.includes(draftModel)) {
      setDraftModel(modelOptions[0] ?? FALLBACK_MODEL);
    }
  }, [modelOptions, draftModel]);

  useEffect(() => {
    if (!selectedCampId) {
      setSelectedCamp(null);
      setArtifacts([]);
      clearSelectedArtifacts();
      return;
    }

    void loadSelectedCamp(selectedCampId).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load camp.');
    });
  }, [clearSelectedArtifacts, selectedCampId, loadSelectedCamp]);

  const handlePickWorkspace = async () => {
    setError(null);
    setStatus(null);

    try {
      const picked = await pickWorkspaceFolder();
      if (!picked) {
        return;
      }

      await setWorkspacePath(picked);
      setWorkspacePathValue(picked);
      setStatus(`Workspace set to ${picked}`);
      await loadCamps();
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : 'Unable to set workspace path.');
    }
  };

  const handleUseDefaultWorkspace = async () => {
    setError(null);
    setStatus(null);

    try {
      const defaultWorkspacePath = await ensureDefaultWorkspace();
      setWorkspacePathValue(defaultWorkspacePath);
      await loadCamps();
      setStatus(`Using Basecamp folder: ${defaultWorkspacePath}`);
    } catch (workspaceError) {
      setError(workspaceError instanceof Error ? workspaceError.message : 'Unable to use Basecamp default workspace.');
    }
  };

  const handleCreateCamp = async () => {
    if (!workspacePath) {
      setError('Select a workspace folder before creating camps.');
      return;
    }

    setError(null);
    setStatus(null);

    try {
      const normalizedName = newCampName.trim() || 'New Camp';
      const created = await campCreate({
        name: normalizedName,
        model: newCampModel || modelOptions[0] || FALLBACK_MODEL,
        system_prompt: '',
        memory: {},
        tools_enabled: false,
      });

      setNewCampName('New Camp');
      setNewCampModelQuery('');
      await loadCamps();
      setSelectedCampId(created.config.id);
      setStatus(`Camp workspace created: ${created.config.name}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create camp.');
    }
  };

  const handlePickRandomModel = () => {
    if (modelOptions.length === 0) {
      return;
    }

    const pool = filteredCreateModelOptions.length > 0 ? filteredCreateModelOptions : modelOptionsWithLabels;
    const random = pool[Math.floor(Math.random() * pool.length)];
    setNewCampModel(random.id);
  };

  const persistCampDrafts = useCallback(async () => {
    if (!selectedCampId) {
      throw new Error('No camp selected.');
    }

    const parsedMemory = parseJsonInput(draftMemory);

    await campUpdateConfig({
      camp_id: selectedCampId,
      name: draftName,
      model: draftModel,
      tools_enabled: draftToolsEnabled,
    });

    await campUpdateSystemPrompt({
      camp_id: selectedCampId,
      system_prompt: draftSystemPrompt,
    });

    await campUpdateMemory({
      camp_id: selectedCampId,
      memory: parsedMemory,
    });

    const refreshedCamp = await campLoad(selectedCampId);
    setSelectedCamp(refreshedCamp);
    setDraftMemory(prettyJson(refreshedCamp.memory));
    await loadCamps();

    return refreshedCamp;
  }, [draftMemory, draftModel, draftName, draftSystemPrompt, draftToolsEnabled, loadCamps, selectedCampId]);

  const handleSaveCamp = async () => {
    setIsSaving(true);
    setError(null);
    setStatus(null);

    try {
      const refreshedCamp = await persistCampDrafts();
      setStatus(`Saved camp ${refreshedCamp.config.name}`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save camp files.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSyncModels = async () => {
    setIsSyncingModels(true);
    setError(null);
    setStatus(null);

    try {
      const apiKey = await getApiKey();
      if (!apiKey) {
        throw new Error('OpenRouter API key is missing. Save it in Settings first.');
      }

      const { count } = await syncModelsToDb(apiKey);
      await loadModels();
      setStatus(`Synced ${count} models.`);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Unable to sync models.');
    } finally {
      setIsSyncingModels(false);
    }
  };

  const handlePromoteMessageToArtifact = async (message: CampMessage) => {
    if (!selectedCampId) {
      return;
    }

    setPromotingMessageId(message.id);
    setError(null);
    setStatus(null);

    try {
      const created = await campCreateArtifactFromMessage({
        camp_id: selectedCampId,
        message_id: message.id,
      });

      await Promise.all([loadArtifacts(selectedCampId), loadCamps()]);
      setStatus(`Created artifact "${created.metadata.title}"`);
    } catch (promoteError) {
      setError(promoteError instanceof Error ? promoteError.message : 'Unable to promote message to artifact.');
    } finally {
      setPromotingMessageId(null);
    }
  };

  const handleSendMessage = async (event: FormEvent) => {
    event.preventDefault();

    if (!selectedCampId || !selectedCamp) {
      setError('Select or create a camp before sending messages.');
      return;
    }

    const trimmedMessage = userMessage.trim();
    if (!trimmedMessage) {
      return;
    }

    const messageArtifactIds = [...new Set(selectedArtifactIds)].sort();

    setIsSending(true);
    setStreamingText('');
    setError(null);
    setStatus(null);

    try {
      const apiKey = await getApiKey();
      if (!apiKey) {
        throw new Error('OpenRouter API key is missing. Save it in Settings first.');
      }

      await persistCampDrafts();

      await campAppendMessage({
        camp_id: selectedCampId,
        role: 'user',
        content: trimmedMessage,
        included_artifact_ids: messageArtifactIds.length > 0 ? messageArtifactIds : undefined,
      });

      if (messageArtifactIds.length > 0) {
        await campIncrementArtifactUsage(selectedCampId, messageArtifactIds);
      }

      const [campWithUser, selectedArtifacts] = await Promise.all([
        campLoad(selectedCampId),
        Promise.all(messageArtifactIds.map((artifactId) => campGetArtifact(selectedCampId, artifactId))),
      ]);
      setSelectedCamp(campWithUser);

      const runtimeResult = await runCampChatRuntime({
        campId: selectedCampId,
        camp: campWithUser,
        selectedArtifacts,
        apiKey,
        temperature,
        maxTokens,
        onToken: (token) => {
          setStreamingText((previous) => previous + token);
        },
        tools: FILESYSTEM_TOOLS,
        executeToolCall: async ({ campId, toolCall }) => {
          return executeFilesystemToolCall(toolCall, {
            readFile: async (path) => campReadContextFile(campId, path),
            listFiles: async (path) => campListContextFiles(campId, path),
            writeFile: async (path, content) => campWriteContextFile(campId, path, content),
          });
        },
      });
      setLastRequestPreview(runtimeResult.requestPayload);

      for (const message of runtimeResult.transcriptMessages) {
        await campAppendMessage({
          camp_id: selectedCampId,
          ...message,
        });
      }

      const updatedCamp = await campLoad(selectedCampId);
      setSelectedCamp(updatedCamp);
      await Promise.all([loadCamps(), loadArtifacts(selectedCampId)]);

      setUserMessage('');
      clearSelectedArtifacts();
      setStreamingText('');
      setStatus(
        runtimeResult.usingTools
          ? 'Response completed with tool use and saved to transcript.jsonl'
          : 'Response streamed and saved to transcript.jsonl',
      );
    } catch (sendError) {
      if (sendError instanceof OpenRouterRequestError) {
        setError(sendError.message);
      } else {
        setError(sendError instanceof Error ? sendError.message : 'Unable to send message.');
      }
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="trail-shell">
      <header className="trail-header">
        <div className="trail-title">
          <h1>Basecamp</h1>
          <p>{workspacePath ?? 'Pick a folder to begin'}</p>
        </div>

        <div className="trail-toolbar">
          <button type="button" onClick={handleUseDefaultWorkspace}>
            Default
          </button>
          <button type="button" onClick={handlePickWorkspace}>
            Folder
          </button>
          <button type="button" onClick={handleSyncModels} disabled={isSyncingModels}>
            {isSyncingModels ? 'Syncing...' : 'Models'}
          </button>
        </div>
      </header>

      <div className="trail-stats">
        <span>{progressionLabel}</span>
        <span>
          {camps.length} Camp{camps.length === 1 ? '' : 's'}
        </span>
        <span>
          {artifactCount} Artifact{artifactCount === 1 ? '' : 's'}
        </span>
        <span>{conversationTurnCount} Turns</span>
        <span>{reusedArtifactCount} Reused</span>
      </div>

      {status ? <p className="status-line">{status}</p> : null}
      {error ? <p className="error-line">{error}</p> : null}

      <main className="trail-grid">
        <aside className="trail-rail">
          <section className="panel trail-card">
            <div className="panel-header">
              <h2>New Camp</h2>
            </div>

            <label>
              <span>Name</span>
              <input
                value={newCampName}
                onChange={(event) => setNewCampName(event.target.value)}
                placeholder="New Camp"
                aria-label="New camp name"
              />
            </label>

            <label>
              <span>Find Model</span>
              <input
                value={newCampModelQuery}
                onChange={(event) => setNewCampModelQuery(event.target.value)}
                placeholder="Search"
              />
            </label>

            <label>
              <span>Model</span>
              <select value={newCampModel} onChange={(event) => setNewCampModel(event.target.value)}>
                {(filteredCreateModelOptions.length > 0 ? filteredCreateModelOptions : modelOptionsWithLabels).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="builder-inline-actions">
              <button type="button" onClick={handlePickRandomModel} disabled={modelOptionsWithLabels.length === 0}>
                Random
              </button>
              <button type="button" className="primary-action" onClick={handleCreateCamp} disabled={!workspacePath}>
                Create
              </button>
            </div>
          </section>

          <section className="panel trail-card camp-list-panel">
            <div className="panel-header">
              <h2>Camps</h2>
              <span className="count-pill">{camps.length}</span>
            </div>

            <div className="camp-list-scroll">
              {camps.map((camp) => (
                <button
                  type="button"
                  key={camp.id}
                  className={`camp-list-item ${camp.id === selectedCampId ? 'active' : ''}`}
                  onClick={() => setSelectedCampId(camp.id)}
                >
                  <strong>{camp.name}</strong>
                  <span>{camp.model}</span>
                </button>
              ))}
              {camps.length === 0 ? <p className="hint">No camps yet.</p> : null}
            </div>
          </section>
        </aside>

        <section className="panel trail-main">
          <div className="panel-header chat-header">
            <div>
              <h2>{selectedCamp ? draftName : 'Choose A Camp'}</h2>
              <p className="hint">{selectedCamp ? draftModel : 'Create one on the left, then send a message.'}</p>
            </div>

            {selectedCamp ? (
              <button type="button" onClick={handleSaveCamp} disabled={isSaving}>
                {isSaving ? 'Saving...' : 'Save'}
              </button>
            ) : null}
          </div>

          {selectedCamp ? (
            <CampSettingsPanel
              draftName={draftName}
              onDraftNameChange={setDraftName}
              draftModelQuery={draftModelQuery}
              onDraftModelQueryChange={setDraftModelQuery}
              draftModel={draftModel}
              onDraftModelChange={setDraftModel}
              filteredDraftModelOptions={filteredDraftModelOptions}
              modelOptionsWithLabels={modelOptionsWithLabels}
              draftToolsEnabled={draftToolsEnabled}
              onDraftToolsEnabledChange={setDraftToolsEnabled}
              draftSystemPrompt={draftSystemPrompt}
              onDraftSystemPromptChange={setDraftSystemPrompt}
              draftMemory={draftMemory}
              onDraftMemoryChange={setDraftMemory}
              selectedDraftModelContextLength={selectedDraftModel?.context_length ?? null}
              activeCampPath={activeCampSummary?.path ?? null}
              selectedArtifactIds={selectedArtifactIds}
              artifactQuery={artifactQuery}
              onArtifactQueryChange={setArtifactQuery}
              visibleArtifacts={visibleArtifacts}
              onToggleArtifactSelection={toggleArtifactSelection}
            />
          ) : null}

          <TranscriptView
            selectedCamp={selectedCamp}
            streamingText={streamingText}
            artifactById={artifactById}
            isSending={isSending}
            promotingMessageId={promotingMessageId}
            onPromoteMessageToArtifact={(message) => {
              void handlePromoteMessageToArtifact(message);
            }}
          />

          <form className="composer" onSubmit={handleSendMessage}>
            {selectedArtifactsForComposer.length > 0 ? (
              <div className="artifact-chip-row">
                {selectedArtifactsForComposer.map((artifact) => (
                  <button
                    type="button"
                    key={`pending-${artifact.id}`}
                    className="artifact-chip selectable"
                    onClick={() => removeSelectedArtifact(artifact.id)}
                  >
                    {artifact.title}
                  </button>
                ))}
              </div>
            ) : null}

            <label>
              <span>Message</span>
              <textarea
                value={userMessage}
                onChange={(event) => setUserMessage(event.target.value)}
                rows={4}
                placeholder={selectedCamp ? 'Type your message...' : 'Create or select a camp first'}
                disabled={!selectedCamp}
              />
            </label>

            <div className="composer-controls">
              <label>
                <span>Temp</span>
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(event) => setTemperature(Number(event.target.value))}
                />
              </label>

              <label>
                <span>Tokens</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={maxTokens}
                  onChange={(event) => setMaxTokens(Math.max(1, Math.floor(Number(event.target.value))))}
                />
              </label>

              <button type="submit" className="primary-action" disabled={isSending || !selectedCamp}>
                {isSending ? 'Streaming...' : 'Send'}
              </button>
            </div>
          </form>

          <details className="request-preview">
            <summary>Debug</summary>
            <pre>{lastRequestPreview ? JSON.stringify(lastRequestPreview, null, 2) : 'No request yet.'}</pre>
          </details>
        </section>
      </main>
    </div>
  );
}
