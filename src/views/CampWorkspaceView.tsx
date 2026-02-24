import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import '../App.css';
import { CampSettingsPanel } from '../components/CampSettingsPanel';
import { TranscriptView } from '../components/TranscriptView';
import { useArtifactComposerState } from '../hooks/useArtifactComposerState';
import {
  campAttachWorkspaceContextFile,
  campAppendMessage,
  campCreate,
  campCreateArtifactFromMessage,
  campDetachWorkspaceContextFile,
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
  workspaceListContextFiles,
} from '../lib/db';
import { runCampChatRuntime } from '../lib/campChatRuntime';
import { syncModelsToDb } from '../lib/models';
import { OpenRouterRequestError, type OpenRouterChatRequestPayload } from '../lib/openrouter';
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

function parseJsonInput(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  return JSON.parse(trimmed);
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

export function CampWorkspaceView() {
  const navigate = useNavigate();
  const { id: routeCampId } = useParams<{ id: string }>();
  const [workspacePath, setWorkspacePathValue] = useState<string | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [camps, setCamps] = useState<CampSummary[]>([]);
  const [selectedCampId, setSelectedCampId] = useState<string | null>(null);
  const [selectedCamp, setSelectedCamp] = useState<Camp | null>(null);
  const [artifacts, setArtifacts] = useState<CampArtifactMetadata[]>([]);
  const [globalContextFiles, setGlobalContextFiles] = useState<string[]>([]);
  const [attachedContextFiles, setAttachedContextFiles] = useState<string[]>([]);

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

  const [sessionTokens, setSessionTokens] = useState<number>(0);
  const [resolvedModel, setResolvedModel] = useState<string | null>(null);

  const [streamingText, setStreamingText] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isSyncingModels, setIsSyncingModels] = useState(false);
  const [isRefreshingContext, setIsRefreshingContext] = useState(false);
  const [isMutatingContext, setIsMutatingContext] = useState(false);
  const [promotingMessageId, setPromotingMessageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [lastRequestPreview, setLastRequestPreview] = useState<OpenRouterChatRequestPayload | null>(null);
  const [contextTreeQuery, setContextTreeQuery] = useState('');
  const [selectedContextFilePath, setSelectedContextFilePath] = useState<string | null>(null);
  const [selectedContextFileContent, setSelectedContextFileContent] = useState('');
  const [contextFileDraft, setContextFileDraft] = useState('');
  const [isLoadingContextFile, setIsLoadingContextFile] = useState(false);
  const [isSavingContextFile, setIsSavingContextFile] = useState(false);
  const [collapsedContextDirs, setCollapsedContextDirs] = useState<string[]>([]);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);

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

  const activeCampSummary = camps.find((camp) => camp.id === selectedCampId) ?? null;
  const filteredContextFiles = useMemo(() => {
    const query = contextTreeQuery.trim().toLowerCase();
    if (!query) {
      return attachedContextFiles;
    }

    return attachedContextFiles.filter((path) => path.toLowerCase().includes(query));
  }, [attachedContextFiles, contextTreeQuery]);
  const contextTree = useMemo(() => buildContextTree(filteredContextFiles), [filteredContextFiles]);
  const collapsedContextDirSet = useMemo(() => new Set(collapsedContextDirs), [collapsedContextDirs]);
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
    pruneSelectedArtifacts(rows.map((artifact) => artifact.id));
  }, [pruneSelectedArtifacts]);

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
      setDraftModelQuery('');
      setDraftSystemPrompt(camp.system_prompt);
      setDraftMemory(prettyJson(camp.memory));
      clearSelectedArtifacts();
    },
    [clearSelectedArtifacts, loadCampContextFiles],
  );

  useEffect(() => {
    const boot = async () => {
      try {
        await loadModels();
        await loadGlobalContextFiles();
        const defaultWorkspacePath = await ensureDefaultWorkspace();
        setWorkspacePathValue(defaultWorkspacePath);
        await loadCamps();
      } catch (bootError) {
        setError(bootError instanceof Error ? bootError.message : 'Unable to load app state.');
      }
    };

    void boot();
  }, [loadCamps, loadGlobalContextFiles, loadModels]);

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
    if (!routeCampId) {
      return;
    }

    if (!camps.some((camp) => camp.id === routeCampId)) {
      return;
    }

    setSelectedCampId(routeCampId);
  }, [camps, routeCampId]);

  useEffect(() => {
    if (!selectedCampId || selectedCampId === routeCampId) {
      return;
    }

    navigate(`/camp/${selectedCampId}`, { replace: true });
  }, [navigate, routeCampId, selectedCampId]);

  useEffect(() => {
    if (!selectedCampId) {
      setSelectedCamp(null);
      setArtifacts([]);
      setAttachedContextFiles([]);
      clearSelectedArtifacts();
      setSessionTokens(0);
      setResolvedModel(null);
      return;
    }

    setSessionTokens(0);
    setResolvedModel(null);

    void loadSelectedCamp(selectedCampId).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load camp.');
    });
  }, [clearSelectedArtifacts, selectedCampId, loadSelectedCamp]);

  useEffect(() => {
    if (!selectedCampId || isSending) {
      return;
    }

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
        if (ignore) {
          return;
        }

        setSelectedContextFileContent(content);
        setContextFileDraft(content);
      })
      .catch((contextReadError) => {
        if (ignore) {
          return;
        }

        setSelectedContextFileContent('');
        setContextFileDraft('');
        setError(contextReadError instanceof Error ? contextReadError.message : 'Unable to load context file.');
      })
      .finally(() => {
        if (ignore) {
          return;
        }
        setIsLoadingContextFile(false);
      });

    return () => {
      ignore = true;
    };
  }, [selectedCampId, selectedContextFilePath]);

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

  const persistCampDraftsForSend = useCallback(async () => {
    if (!selectedCampId) {
      throw new Error('No camp selected.');
    }

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

  const handleRefreshContext = async () => {
    setIsRefreshingContext(true);
    setError(null);
    setStatus(null);

    try {
      await loadGlobalContextFiles();
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

  const handleAttachContext = async (path: string) => {
    if (!selectedCampId) {
      return;
    }

    setIsMutatingContext(true);
    setError(null);
    setStatus(null);

    try {
      await campAttachWorkspaceContextFile(selectedCampId, path);
      await loadSelectedCamp(selectedCampId);
      await loadCamps();
      setStatus(`Attached ${path}`);
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
    setError(null);
    setStatus(null);

    try {
      await campDetachWorkspaceContextFile(selectedCampId, path);
      await loadSelectedCamp(selectedCampId);
      await loadCamps();
      setStatus(`Detached ${path}`);
    } catch (detachError) {
      setError(detachError instanceof Error ? detachError.message : 'Unable to detach context file.');
    } finally {
      setIsMutatingContext(false);
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
    if (!selectedCampId || !selectedContextFilePath) {
      return;
    }

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

      await persistCampDraftsForSend();

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

      const runRuntime = (campForRuntime: Camp) =>
        runCampChatRuntime({
          campId: selectedCampId,
          camp: campForRuntime,
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

      const runtimeResult = await runRuntime(campWithUser);
      setLastRequestPreview(runtimeResult.requestPayload);

      if (runtimeResult.usage?.total_tokens) {
        setSessionTokens((prev) => prev + (runtimeResult.usage?.total_tokens ?? 0));
      }
      setResolvedModel(runtimeResult.resolvedModel);

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
      clearSelectedArtifacts();
      setStreamingText('');
      setStatus(
        runtimeResult.usingTools
          ? 'Response completed with tool use and saved to transcript.jsonl'
          : 'Response streamed and saved to transcript.jsonl',
      );
    } catch (sendError) {
      if (sendError instanceof OpenRouterRequestError) {
        setLastRequestPreview(sendError.requestPayload as OpenRouterChatRequestPayload);
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
        const collapsed = collapsedContextDirSet.has(node.path);

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
          <button type="button" onClick={handleUseDefaultWorkspace}>
            Basecamp Folder
          </button>
          <button type="button" onClick={handlePickWorkspace}>
            Choose Folder
          </button>
          <button type="button" onClick={handleSyncModels} disabled={isSyncingModels}>
            {isSyncingModels ? 'Syncing...' : 'Sync Models'}
          </button>
        </div>
      </header>

      {status ? <p className="status-line">{status}</p> : null}
      {error ? <p className="error-line">{error}</p> : null}

      <main className="trail-grid ide-grid">
        <aside className="panel ide-pane ide-explorer">
          <div className="panel-header">
            <h2>Explorer</h2>
            <span className="count-pill">{attachedContextFiles.length}</span>
          </div>

          <details className="artifact-drawer ide-drawer" open>
            <summary>Create Camp</summary>

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
              <span>Search Model</span>
              <input
                value={newCampModelQuery}
                onChange={(event) => setNewCampModelQuery(event.target.value)}
                placeholder="Search models"
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
                Randomize
              </button>
              <button type="button" className="primary-action" onClick={handleCreateCamp} disabled={!workspacePath}>
                Create Camp
              </button>
            </div>
          </details>

          <section className="explorer-section camp-list-panel">
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
              {camps.length === 0 ? <p className="hint">No camps yet. Create one above.</p> : null}
            </div>
          </section>

          <section className="explorer-section explorer-tree">
            <div className="panel-header">
              <h2>Context Tree</h2>
              <button type="button" onClick={handleRefreshContext} disabled={isRefreshingContext}>
                {isRefreshingContext ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>

            <label>
              <span>Filter Files</span>
              <input
                value={contextTreeQuery}
                onChange={(event) => setContextTreeQuery(event.target.value)}
                placeholder="path or file"
              />
            </label>

            <div className="context-tree-scroll">
              {!selectedCamp ? <p className="hint">Select a camp to view its context tree.</p> : null}
              {selectedCamp && contextTree.length === 0 ? <p className="hint">No attached context files.</p> : null}
              {selectedCamp ? renderContextTree(contextTree) : null}
            </div>
          </section>
        </aside>

        <section className="panel ide-pane ide-canvas">
          <div className="panel-header chat-header">
            <div>
              <h2>Canvas</h2>
              <p className="hint">{selectedContextFilePath ?? 'Select a file from the explorer to view or edit.'}</p>
            </div>
            <div className="canvas-actions">
              {selectedCamp ? (
                <button type="button" onClick={handleSaveCamp} disabled={isSaving}>
                  {isSaving ? 'Saving Camp...' : 'Save Camp'}
                </button>
              ) : null}
              <button
                type="button"
                className="primary-action"
                onClick={handleSaveContextFile}
                disabled={!selectedCamp || !selectedContextFilePath || !contextFileDirty || isSavingContextFile}
              >
                {isSavingContextFile ? 'Saving File...' : 'Save File'}
              </button>
            </div>
          </div>

          <div className="canvas-editor-shell">
            {!selectedCamp ? <p className="hint">Create or select a camp to open files.</p> : null}
            {selectedCamp && !selectedContextFilePath ? <p className="hint">Attach files to this camp, then pick one from the tree.</p> : null}
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

          {selectedCamp ? (
            <details className="artifact-drawer camp-context-drawer">
              <summary>Workspace Context Files ({attachedContextFiles.length} attached)</summary>
              <div className="camp-context-toolbar">
                <p className="hint">Attach files from workspace `context/` for reusable camp context.</p>
              </div>

              <div className="artifact-scroll">
                {globalContextFiles.map((path) => {
                  const isAttached = attachedContextFiles.includes(path);

                  return (
                    <article key={path} className="artifact-item camp-context-item">
                      <header>
                        <strong>{path}</strong>
                        <button
                          type="button"
                          className={isAttached ? '' : 'primary-action'}
                          disabled={isMutatingContext}
                          onClick={() => {
                            if (isAttached) {
                              void handleDetachContext(path);
                              return;
                            }
                            void handleAttachContext(path);
                          }}
                        >
                          {isAttached ? 'Detach' : 'Attach'}
                        </button>
                      </header>
                    </article>
                  );
                })}
                {globalContextFiles.length === 0 ? <p className="hint">No files found in workspace `context/`.</p> : null}
              </div>
            </details>
          ) : null}

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
            />
          ) : null}

          <details className="request-preview">
            <summary>Request Preview</summary>
            <pre>{lastRequestPreview ? JSON.stringify(lastRequestPreview, null, 2) : 'No request yet.'}</pre>
          </details>
        </section>

        <section className="panel ide-pane ide-chat">
          <div className="panel-header chat-header">
            <div>
              <h2>Chat</h2>
              <p className="hint">{selectedCamp ? draftName : 'Create one on the left to start chatting.'}</p>
            </div>

            {selectedCamp ? (
              <div style={{ textAlign: 'right' }}>
                <label className="chat-model-picker">
                  <span>Agent Model (Locked To Camp)</span>
                  <select value={draftModel} onChange={(event) => setDraftModel(event.target.value)}>
                    {(filteredDraftModelOptions.length > 0 ? filteredDraftModelOptions : modelOptionsWithLabels).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                {resolvedModel && resolvedModel !== draftModel && (
                  <div className="hint" style={{ marginTop: 'var(--space-1)' }}>
                    Resolved: {resolvedModel}
                  </div>
                )}
                {sessionTokens > 0 && (
                  <div className="hint" style={{ marginTop: 'var(--space-1)' }}>
                    {sessionTokens.toLocaleString()} tokens
                  </div>
                )}
              </div>
            ) : null}
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

          <form className="composer" onSubmit={handleSendMessage}>
            {selectedCamp ? (
              <details className="artifact-drawer composer-artifact-drawer">
                <summary>
                  {selectedArtifactIds.length > 0
                    ? `${selectedArtifactIds.length} artifact${selectedArtifactIds.length === 1 ? '' : 's'} selected`
                    : 'Include artifacts'}
                </summary>

                <label>
                  <span>Search</span>
                  <input
                    value={artifactQuery}
                    onChange={(event) => setArtifactQuery(event.target.value)}
                    placeholder="title or tag"
                  />
                </label>

                <div className="artifact-scroll">
                  {visibleArtifacts.map((artifact) => (
                    <article key={artifact.id} className="artifact-item">
                      <header>
                        <label>
                          <input
                            type="checkbox"
                            checked={selectedArtifactIds.includes(artifact.id)}
                            onChange={() => toggleArtifactSelection(artifact.id)}
                          />
                          <strong>{artifact.title}</strong>
                        </label>
                        <time>{new Date(artifact.updated_at).toLocaleString()}</time>
                      </header>
                      <p>{artifact.tags.join(', ')}</p>
                    </article>
                  ))}
                  {visibleArtifacts.length === 0 ? <p className="hint">No artifacts yet.</p> : null}
                </div>
              </details>
            ) : null}

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
                ref={composerTextareaRef}
                value={userMessage}
                onChange={(event) => setUserMessage(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                rows={6}
                placeholder={selectedCamp ? 'Ask for planning, analysis, or drafting help...' : 'Create or select a camp first'}
                disabled={!selectedCamp}
                autoFocus
              />
            </label>

            <div className="composer-actions">
              <details className="composer-tuning">
                <summary>Model Controls</summary>
                <div className="composer-controls">
                  <label>
                    <span>Temperature</span>
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
                    <span>Max Tokens</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={maxTokens}
                      onChange={(event) => setMaxTokens(Math.max(1, Math.floor(Number(event.target.value))))}
                    />
                  </label>
                </div>
              </details>
              <button type="submit" className="primary-action" disabled={isSending || !selectedCamp}>
                {isSending ? 'Generating...' : 'Send Message'}
              </button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}
