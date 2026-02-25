import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import '../App.css';
import { TranscriptView } from '../components/TranscriptView';
import {
  campAppendMessage,
  campCreate,
  campCreateArtifactFromMessage,
  campListContextFiles,
  campList,
  campListArtifacts,
  campLoad,
  campReadContextFile,
  campUpdateConfig,
  campUpdateSystemPrompt,
  campWriteContextFile,
  dbListModels,
  ensureDefaultWorkspace,
  getApiKey,
  pickWorkspaceFolder,
  setWorkspacePath,
} from '../lib/db';
import { runCampChatRuntime } from '../lib/campChatRuntime';
import { syncModelsToDb } from '../lib/models';
import { OpenRouterRequestError } from '../lib/openrouter';
import { executeFilesystemToolCall, FILESYSTEM_TOOLS } from '../lib/tools';
import type { Camp, CampArtifactMetadata, CampMessage, CampSummary, ModelRow } from '../lib/types';

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

function modelDisplayLabel(model: ModelRow): string {
  const ctx = model.context_length ? ` · ${(model.context_length / 1000).toFixed(0)}k ctx` : '';
  const name = model.name?.trim() ? model.name : model.id;
  return `${name}${ctx}`;
}

type ContextTreeNode = {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  children: ContextTreeNode[];
};

type MutableContextTreeNode = {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  children: Map<string, MutableContextTreeNode>;
};

function buildContextTree(paths: string[]): ContextTreeNode[] {
  const root = new Map<string, MutableContextTreeNode>();

  for (const rawPath of paths) {
    const normalized = rawPath.trim().replace(/^\/+|\/+$/g, '');
    if (!normalized) {
      continue;
    }

    const segments = normalized.split('/').filter(Boolean);
    let currentPath = '';
    let cursor = root;

    segments.forEach((segment, index) => {
      const isLeaf = index === segments.length - 1;
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const nodePath = isLeaf ? currentPath : `${currentPath}/`;
      const key = `${isLeaf ? 'f' : 'd'}:${segment}`;
      const existing = cursor.get(key);

      if (existing) {
        cursor = existing.children;
        return;
      }

      const nextNode: MutableContextTreeNode = {
        name: segment,
        path: nodePath,
        kind: isLeaf ? 'file' : 'dir',
        children: new Map<string, MutableContextTreeNode>(),
      };
      cursor.set(key, nextNode);
      cursor = nextNode.children;
    });
  }

  const freeze = (nodes: Map<string, MutableContextTreeNode>): ContextTreeNode[] => {
    return [...nodes.values()]
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === 'dir' ? -1 : 1;
        }

        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      })
      .map((node) => ({
        name: node.name,
        path: node.path,
        kind: node.kind,
        children: freeze(node.children),
      }));
  };

  return freeze(root);
}

export function MainLayout() {
  const navigate = useNavigate();
  const { id: routeCampId } = useParams<{ id: string }>();
  const [workspacePath, setWorkspacePathValue] = useState<string | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [camps, setCamps] = useState<CampSummary[]>([]);
  const [selectedCampId, setSelectedCampId] = useState<string | null>(null);
  const [selectedCamp, setSelectedCamp] = useState<Camp | null>(null);
  const [artifacts, setArtifacts] = useState<CampArtifactMetadata[]>([]);
  const [attachedContextFiles, setAttachedContextFiles] = useState<string[]>([]);

  const [draftName, setDraftName] = useState('');
  const [draftModel, setDraftModel] = useState(FALLBACK_MODEL);
  const [draftToolsEnabled, setDraftToolsEnabled] = useState(false);
  const [draftSystemPrompt, setDraftSystemPrompt] = useState('');

  const [userMessage, setUserMessage] = useState('');

  // Minimal settings for now
  const temperature = DEFAULT_TEMPERATURE;
  const maxTokens = DEFAULT_MAX_TOKENS;

  const [streamingText, setStreamingText] = useState('');
  const [isSavingContextFile, setIsSavingContextFile] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isSyncingModels, setIsSyncingModels] = useState(false);
  const [isRefreshingContext, setIsRefreshingContext] = useState(false);
  const [promotingMessageId, setPromotingMessageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [selectedContextFilePath, setSelectedContextFilePath] = useState<string | null>(null);
  const [selectedContextFileContent, setSelectedContextFileContent] = useState('');
  const [contextFileDraft, setContextFileDraft] = useState('');
  const [isLoadingContextFile, setIsLoadingContextFile] = useState(false);
  const [collapsedContextDirs, setCollapsedContextDirs] = useState<string[]>([]);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const modelOptions = useMemo(() => (models.length > 0 ? models.map((model) => model.id) : [FALLBACK_MODEL]), [models]);
  const modelOptionsWithLabels = useMemo(() => (models.length > 0 ? models.map((model) => ({ id: model.id, label: modelDisplayLabel(model) })) : [{ id: FALLBACK_MODEL, label: FALLBACK_MODEL }]), [models]);

  const artifactById = useMemo(() => new Map(artifacts.map((artifact) => [artifact.id, artifact])), [artifacts]);

  const contextTree = useMemo(() => buildContextTree(attachedContextFiles), [attachedContextFiles]);
  const contextFileDirty = selectedContextFilePath ? contextFileDraft !== selectedContextFileContent : false;

  const loadModels = useCallback(async () => {
    const rows = await dbListModels();
    setModels(rows);
  }, []);

  const loadCamps = useCallback(async () => {
    const rows = (await campList()).sort((left, right) => right.updated_at - left.updated_at);
    setCamps(rows);
    setSelectedCampId((previous) => {
      if (routeCampId && rows.some((camp) => camp.id === routeCampId)) {
        return routeCampId;
      }

      if (previous && rows.some((camp) => camp.id === previous)) {
        return previous;
      }

      return rows[0]?.id ?? null;
    });
  }, [routeCampId]);

  const loadArtifacts = useCallback(async (campId: string) => {
    const rows = await campListArtifacts(campId);
    setArtifacts(rows);
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

  const loadSelectedCamp = useCallback(
    async (campId: string) => {
      const [camp, artifactRows, contextFiles] = await Promise.all([
        campLoad(campId),
        campListArtifacts(campId),
        loadCampContextFiles(campId),
      ]);
      setSelectedCamp(camp);
      setArtifacts(artifactRows);
      setAttachedContextFiles(contextFiles);
      setDraftName(camp.config.name);
      setDraftModel(camp.config.model);
      setDraftToolsEnabled(camp.config.tools_enabled);
      setDraftSystemPrompt(camp.system_prompt);
    },
    [loadCampContextFiles]
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
    if (!modelOptions.includes(draftModel)) {
      setDraftModel(modelOptions[0] ?? FALLBACK_MODEL);
    }
  }, [modelOptions, draftModel]);

  useEffect(() => {
    if (!routeCampId) { return; }
    if (!camps.some((camp) => camp.id === routeCampId)) { return; }
    setSelectedCampId(routeCampId);
  }, [camps, routeCampId]);

  useEffect(() => {
    if (!selectedCampId || selectedCampId === routeCampId) { return; }
    navigate(`/camp/${selectedCampId}`, { replace: true });
  }, [navigate, routeCampId, selectedCampId]);

  useEffect(() => {
    if (!selectedCampId) {
      setSelectedCamp(null);
      setArtifacts([]);
      setAttachedContextFiles([]);
      return;
    }

    void loadSelectedCamp(selectedCampId).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load camp.');
    });
  }, [selectedCampId, loadSelectedCamp]);

  useEffect(() => {
    if (!selectedCampId || isSending) { return; }
    composerTextareaRef.current?.focus();
  }, [isSending, selectedCampId]);

  useEffect(() => {
    if (!selectedCampId) {
      setSelectedContextFilePath(null);
      setSelectedContextFileContent('');
      setContextFileDraft('');
      setCollapsedContextDirs([]);
      return;
    }

    if (attachedContextFiles.length === 0) {
      setSelectedContextFilePath(null);
      setSelectedContextFileContent('');
      setContextFileDraft('');
      return;
    }

    if (selectedContextFilePath && attachedContextFiles.includes(selectedContextFilePath)) {
      return;
    }

    setSelectedContextFilePath(attachedContextFiles[0] ?? null);
  }, [attachedContextFiles, selectedCampId, selectedContextFilePath]);

  useEffect(() => {
    if (!selectedCampId || !selectedContextFilePath) {
      setSelectedContextFileContent('');
      setContextFileDraft('');
      return;
    }

    let ignore = false;
    setIsLoadingContextFile(true);
    setError(null);

    void campReadContextFile(selectedCampId, selectedContextFilePath)
      .then((content) => {
        if (ignore) return;
        setSelectedContextFileContent(content);
        setContextFileDraft(content);
      })
      .catch((contextReadError) => {
        if (ignore) return;
        setSelectedContextFileContent('');
        setContextFileDraft('');
        setError(contextReadError instanceof Error ? contextReadError.message : 'Unable to load context file.');
      })
      .finally(() => {
        if (ignore) return;
        setIsLoadingContextFile(false);
      });

    return () => { ignore = true; };
  }, [selectedCampId, selectedContextFilePath]);

  const handlePickWorkspace = async () => {
    setError(null);
    setStatus(null);
    try {
      const picked = await pickWorkspaceFolder();
      if (!picked) return;

      await setWorkspacePath(picked);
      setWorkspacePathValue(picked);
      setStatus(`Workspace set to ${picked}`);
      await loadCamps();
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : 'Unable to set workspace path.');
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
      const created = await campCreate({
        name: 'New Camp',
        model: modelOptions[0] || FALLBACK_MODEL,
        system_prompt: '',
        memory: {},
        tools_enabled: false,
      });

      await loadCamps();
      setSelectedCampId(created.config.id);
      setStatus(`Camp workspace created: ${created.config.name}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create camp.');
    }
  };

  const persistCampDraftsForSend = useCallback(async () => {
    if (!selectedCampId) throw new Error('No camp selected.');

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

    const refreshedCamp = await campLoad(selectedCampId);
    setSelectedCamp(refreshedCamp);
    await loadCamps();

    return refreshedCamp;
  }, [draftModel, draftName, draftSystemPrompt, draftToolsEnabled, loadCamps, selectedCampId]);

  const handleSyncModels = async () => {
    setIsSyncingModels(true);
    setError(null);
    setStatus(null);

    try {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('OpenRouter API key is missing. Save it in Settings first.');

      const { count } = await syncModelsToDb(apiKey);
      await loadModels();
      setStatus(`Synced ${count} models.`);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Unable to sync models.');
    } finally {
      setIsSyncingModels(false);
    }
  };

  const handleRefreshContext = async () => {
    setIsRefreshingContext(true);
    setError(null);
    setStatus(null);

    try {
      if (selectedCampId) {
        await loadSelectedCamp(selectedCampId);
      }
      setStatus('Context files refreshed.');
    } catch (contextError) {
      setError(contextError instanceof Error ? contextError.message : 'Unable to refresh context files.');
    } finally {
      setIsRefreshingContext(false);
    }
  };

  const handleToggleContextDir = (path: string) => {
    setCollapsedContextDirs((previous) => {
      if (previous.includes(path)) {
        return previous.filter((entry) => entry !== path);
      }
      return [...previous, path];
    });
  };

  const handleSaveContextFile = async () => {
    if (!selectedCampId || !selectedContextFilePath) return;

    setIsSavingContextFile(true);
    setError(null);
    setStatus(null);

    try {
      await campWriteContextFile(selectedCampId, selectedContextFilePath, contextFileDraft);
      setSelectedContextFileContent(contextFileDraft);
      await loadCamps();
      setStatus(`Saved ${selectedContextFilePath}`);
    } catch (contextWriteError) {
      setError(contextWriteError instanceof Error ? contextWriteError.message : 'Unable to save context file.');
    } finally {
      setIsSavingContextFile(false);
    }
  };

  const handlePromoteMessageToArtifact = async (message: CampMessage) => {
    if (!selectedCampId) return;

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
    if (!trimmedMessage) return;

    setIsSending(true);
    setStreamingText('');
    setError(null);
    setStatus(null);

    try {
      const apiKey = await getApiKey();
      if (!apiKey) throw new Error('OpenRouter API key is missing. Save it in Settings first.');

      await persistCampDraftsForSend();

      await campAppendMessage({
        camp_id: selectedCampId,
        role: 'user',
        content: trimmedMessage,
      });

      const campWithUser = await campLoad(selectedCampId);
      setSelectedCamp(campWithUser);

      const runRuntime = (campForRuntime: Camp) =>
        runCampChatRuntime({
          campId: selectedCampId,
          camp: campForRuntime,
          selectedArtifacts: [],
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

      const runtimeResult = await runRuntime(campWithUser);

      for (const message of runtimeResult.transcriptMessages) {
        await campAppendMessage({
          camp_id: selectedCampId,
          ...message,
        });
      }

      const updatedCamp = await campLoad(selectedCampId);
      setSelectedCamp(updatedCamp);
      const [, , refreshedContextFiles] = await Promise.all([
        loadCamps(),
        loadArtifacts(selectedCampId),
        loadCampContextFiles(selectedCampId),
      ]);
      setAttachedContextFiles(refreshedContextFiles);

      setUserMessage('');
      setStreamingText('');
      setStatus(
        runtimeResult.usingTools
          ? 'Response completed with tool use and saved to transcript.jsonl'
          : 'Response streamed and saved to transcript.jsonl',
      );
    } catch (sendError) {
      if (sendError instanceof OpenRouterRequestError) {
        setError(`${sendError.message} (model: ${sendError.requestPayload.model})`);
      } else {
        setError(sendError instanceof Error ? sendError.message : 'Unable to send message.');
      }
    } finally {
      setIsSending(false);
    }
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const renderContextTree = (nodes: ContextTreeNode[], depth = 0) => {
    return nodes.map((node) => {
      if (node.kind === 'dir') {
        const collapsed = collapsedContextDirs.includes(node.path);

        return (
          <div key={node.path} className="context-tree-group">
            <button
              type="button"
              className="tree-row tree-dir"
              onClick={() => handleToggleContextDir(node.path)}
              style={{ paddingLeft: `${0.55 + depth * 0.8}rem` }}
            >
              <span className="tree-glyph">{collapsed ? '+' : '-'}</span>
              <span className="tree-label">{node.name}</span>
            </button>
            {!collapsed ? renderContextTree(node.children, depth + 1) : null}
          </div>
        );
      }

      return (
        <button
          type="button"
          key={node.path}
          className={`tree-row tree-file ${node.path === selectedContextFilePath ? 'active' : ''}`}
          onClick={() => setSelectedContextFilePath(node.path)}
          style={{ paddingLeft: `${0.55 + depth * 0.8}rem` }}
        >
          <span className="tree-glyph">*</span>
          <span className="tree-label">{node.name}</span>
        </button>
      );
    });
  };

  return (
    <div className="camp-workspace trail-shell">
      <header className="trail-header">
        <div className="trail-title">
          <h1>Basecamp</h1>
          <p>{workspacePath ?? 'Choose a workspace folder to begin'}</p>
        </div>

        <div className="trail-toolbar">
          <button type="button" onClick={() => navigate('/home')}>
            Home
          </button>
          <button type="button" onClick={handlePickWorkspace}>
            Open Folder
          </button>
          <button type="button" onClick={handleSyncModels} disabled={isSyncingModels}>
            {isSyncingModels ? 'Syncing...' : 'Sync Models'}
          </button>
        </div>
      </header>

      {status ? <p className="status-line">{status}</p> : null}
      {error ? <p className="error-line">{error}</p> : null}

      <main className="main-layout-panels">
        {/* Left Sidebar: Explorer */}
        <div className="main-layout-explorer panel">
          <div className="panel-header">
            <h2>EXPLORER</h2>
          </div>

          <section className="explorer-section camp-list-panel">
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

            {workspacePath && (
              <button
                type="button"
                className="primary-action"
                onClick={handleCreateCamp}
                style={{ marginTop: 'var(--space-2)' }}
              >
                Create Camp
              </button>
            )}
          </section>

          <section className="explorer-section explorer-tree" style={{ marginTop: 'var(--space-3)' }}>
            <div className="panel-header" style={{ paddingLeft: 0, paddingRight: 0, borderBottom: 'none' }}>
              <h2>FILES</h2>
              <button type="button" onClick={handleRefreshContext} disabled={isRefreshingContext} style={{ padding: 'var(--space-1) var(--space-2)', fontSize: 'var(--text-xs)' }}>
                {isRefreshingContext ? '...' : 'Refresh'}
              </button>
            </div>
            <div className="context-tree-scroll" style={{ flex: 1, minHeight: 0 }}>
              {!selectedCamp ? <p className="hint">Select a camp to view its files.</p> : null}
              {selectedCamp && contextTree.length === 0 ? <p className="hint">No attached files.</p> : null}
              {selectedCamp ? renderContextTree(contextTree) : null}
            </div>
          </section>
        </div>

        {/* Center Pane: Canvas */}
        <div className="main-layout-canvas panel">
          <div className="panel-header chat-header">
            <div>
              <h2>CANVAS</h2>
            </div>
            <div className="canvas-actions">
              <button
                type="button"
                className="primary-action"
                onClick={handleSaveContextFile}
                disabled={!selectedCamp || !selectedContextFilePath || !contextFileDirty || isSavingContextFile}
              >
                {isSavingContextFile ? 'Saving...' : 'Save File'}
              </button>
            </div>
          </div>

          <div className="canvas-editor-shell">
            {!selectedCamp ? <p className="hint">Create or select a camp to open files.</p> : null}
            {selectedCamp && !selectedContextFilePath ? <p className="hint">Select a file from the explorer to view or edit.</p> : null}
            {selectedCamp && selectedContextFilePath ? (
              isLoadingContextFile ? (
                <p className="hint">Loading file...</p>
              ) : (
                <textarea
                  className="canvas-editor"
                  value={contextFileDraft}
                  onChange={(event) => setContextFileDraft(event.target.value)}
                  spellCheck={false}
                />
              )
            ) : null}
          </div>
        </div>

        {/* Right Sidebar: Chat */}
        <div className="main-layout-chat panel">
          <div className="panel-header chat-header">
            <div>
              <h2>CHAT</h2>
            </div>
            {selectedCamp && (
              <div style={{ textAlign: 'right' }}>
                <label className="chat-model-picker" style={{ display: 'inline-block' }}>
                  <select value={draftModel} onChange={(event) => setDraftModel(event.target.value)} style={{ width: '180px', marginTop: 0 }}>
                    {modelOptionsWithLabels.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </div>

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

          <form className="composer main-layout-composer" onSubmit={handleSendMessage} style={{ borderTop: 'var(--border-width) solid var(--line)', paddingTop: 'var(--space-3)' }}>
            <textarea
              ref={composerTextareaRef}
              value={userMessage}
              onChange={(event) => setUserMessage(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              rows={4}
              placeholder={selectedCamp ? 'Ask anything...' : 'Create or select a camp first'}
              disabled={!selectedCamp}
              autoFocus
              style={{ minHeight: '80px', marginBottom: 'var(--space-2)' }}
            />
            <div className="composer-actions" style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="submit" className="primary-action" disabled={isSending || !selectedCamp}>
                {isSending ? 'Sending...' : 'Send'}
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
