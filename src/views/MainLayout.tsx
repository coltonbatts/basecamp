import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import '../App.css';
import { AppShell } from '../components/layout/AppShell';
import { LeftPane } from '../components/layout/LeftPane';
import { CenterPane } from '../components/layout/CenterPane';
import { RightPane } from '../components/layout/RightPane';
import { TeamArena } from '../components/TeamArena';
import { TeamConfig } from '../components/TeamConfig';
import { InspectPanel, type InspectFileWrite, type InspectTurnData } from '../components/InspectPanel';
import { TranscriptView } from '../components/TranscriptView';
import { ViewState } from '../components/ui/ViewState';
import { useArtifactComposerState } from '../hooks/useArtifactComposerState';
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
  campReadContextFileBase64,
  campSearchTranscript,
  campUpdateConfig,
  campUpdateArtifact,
  campUpdateMemory,
  campUpdateSystemPrompt,
  campWriteContextFile,
  campWriteContextFileBytes,
  dbListModels,
  ensureDefaultWorkspace,
  pickWorkspaceFolder,
  providersList,
  setWorkspacePath,
} from '../lib/db';
import { runCampChatRuntime } from '../lib/campChatRuntime';
import {
  getDeveloperInspectMode,
  inspectEmitEvent,
  inspectStatCampFile,
  inspectWriteTurnBundle,
  inspectWriteTurnRequest,
  inspectWriteTurnResponse,
  listenInspectEvents,
  type InspectCampFileMeta,
  type InspectEmitEventPayload,
  type InspectEventRecord,
} from '../lib/inspect';
import { syncModelsToDb } from '../lib/models';
import { OpenRouterRequestError, type OpenRouterToolCall } from '../lib/openrouter';
import { executeCampToolCall, executeMcpToolCall, getAllToolSpecs, getToolKind, isMcpToolName } from '../lib/tools';
import { buildMcpToolEntry, setMcpTools } from '../lib/tools/registry';
import type { Camp, CampArtifact, CampArtifactMetadata, CampMessage, CampSummary, ModelRow, CampMessageAttachment, ProviderRegistryRow } from '../lib/types';

const FALLBACK_MODEL = 'openrouter/auto';
const DEFAULT_MAX_TOKENS = 1200;
const DEFAULT_TEMPERATURE = 0.3;
const TOOL_REJECT_MESSAGE = 'Tool call rejected by user.';

type InspectFileWriteMapEntry = {
  path: string;
  before: InspectCampFileMeta | null;
  after: InspectCampFileMeta | null;
};

type ActiveInspectTurn = InspectTurnData & {
  requestPayload: {
    requests: unknown[];
  } | null;
  responsePayload: {
    responses: unknown[];
  } | null;
};

function buildCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `corr-${Date.now()}`;
}

function modelDisplayLabel(model: ModelRow): string {
  const ctx = model.context_length ? ` · ${(model.context_length / 1000).toFixed(0)}k ctx` : '';
  const name = model.name?.trim() ? model.name : model.id;
  return `[${model.provider_kind ?? 'openrouter'}] ${name}${ctx}`;
}

function modelSupportsTools(model: ModelRow | null): boolean {
  if (!model?.capabilities_json) {
    return true;
  }
  try {
    const parsed = JSON.parse(model.capabilities_json) as { supports_tools?: unknown };
    if (typeof parsed.supports_tools === 'boolean') {
      return parsed.supports_tools;
    }
  } catch {
    return true;
  }
  return true;
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

type ToolApprovalDecision = 'approve' | 'reject';
type ToolApprovalStatus = 'pending' | 'approved' | 'running' | 'rejected' | 'done' | 'error';
type ToolApprovalMode = 'manual' | 'auto-safe';
type ToolQueueItemKind = 'read' | 'mutate' | 'unknown';

const TOOL_APPROVAL_MODE: ToolApprovalMode = 'manual';

type ToolApprovalItem = {
  id: string;
  name: string;
  kind: ToolQueueItemKind;
  argsJson: string;
  status: ToolApprovalStatus;
  resultPreview: string | null;
  errorMessage: string | null;
  createdAt: number;
};

function truncatePreview(value: string, maxLength = 160): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function shouldRequireToolApproval(mode: ToolApprovalMode, kind: ToolQueueItemKind): boolean {
  if (mode === 'manual') {
    return true;
  }

  return kind !== 'read';
}

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
  const [providerStatusRows, setProviderStatusRows] = useState<ProviderRegistryRow[]>([]);
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
  const [userAttachments, setUserAttachments] = useState<CampMessageAttachment[]>([]);

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
  const [toolApprovalQueue, setToolApprovalQueue] = useState<ToolApprovalItem[]>([]);
  const [developerInspectMode, setDeveloperInspectMode] = useState(false);
  const [inspectTurn, setInspectTurn] = useState<ActiveInspectTurn | null>(null);
  const [inspectExporting, setInspectExporting] = useState(false);
  const [inspectExportError, setInspectExportError] = useState<string | null>(null);

  // Layout states
  const [leftTab, setLeftTab] = useState<'camps' | 'files' | 'context'>('camps');
  const [centerMode, setCenterMode] = useState<string>('editor');
  const [rightMode, setRightMode] = useState<'chat' | 'team'>('chat');
  const [leftPaneWidth, setLeftPaneWidth] = useState(260);
  const [rightPaneWidth, setRightPaneWidth] = useState(360);
  const [leftPaneCollapsed, setLeftPaneCollapsed] = useState(false);
  const [rightPaneCollapsed, setRightPaneCollapsed] = useState(false);

  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const toolApprovalResolversRef = useRef(new Map<string, (decision: ToolApprovalDecision) => void>());
  const activeCorrelationIdRef = useRef<string | null>(null);
  const inspectFileWritesRef = useRef<Map<string, InspectFileWriteMapEntry>>(new Map());
  const inspectTimelineRef = useRef<InspectEventRecord[]>([]);

  // Keyboard Shortcuts
  useEffect(() => {
    const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
      // Cmd/Ctrl + B: Toggle Left Pane
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setLeftPaneCollapsed(prev => !prev);
      }
      // Cmd/Ctrl + J: Toggle Right Pane
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setRightPaneCollapsed(prev => !prev);
      }
      // Cmd/Ctrl + K: Focus command palette / search (placeholder for now)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        console.log('Command palette shortcut invoked');
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  const modelOptions = useMemo(() => (models.length > 0 ? models.map((model) => model.id) : [FALLBACK_MODEL]), [models]);
  const modelOptionsWithLabels = useMemo(() => (models.length > 0 ? models.map((model) => ({ id: model.id, label: modelDisplayLabel(model) })) : [{ id: FALLBACK_MODEL, label: FALLBACK_MODEL }]), [models]);
  const selectedModelRow = useMemo(
    () => models.find((model) => model.id === draftModel) ?? null,
    [draftModel, models],
  );
  const selectedModelSupportsTools = useMemo(
    () => modelSupportsTools(selectedModelRow),
    [selectedModelRow],
  );
  const selectedProviderStatus = useMemo(() => {
    const providerKind =
      selectedModelRow?.provider_kind ?? (draftModel.includes('/') ? draftModel.split('/')[0] : 'openrouter');
    return providerStatusRows.find((provider) => provider.provider_kind === providerKind) ?? null;
  }, [draftModel, providerStatusRows, selectedModelRow]);

  const artifactById = useMemo(() => new Map(artifacts.map((artifact) => [artifact.id, artifact])), [artifacts]);
  const {
    artifactQuery,
    setArtifactQuery,
    selectedArtifactIds,
    selectedArtifactsForComposer,
    visibleArtifacts,
    toggleArtifactSelection,
    removeSelectedArtifact,
    clearSelectedArtifacts,
    pruneSelectedArtifacts,
  } = useArtifactComposerState(artifacts);

  const contextTree = useMemo(() => buildContextTree(attachedContextFiles), [attachedContextFiles]);
  const contextFileDirty = selectedContextFilePath ? contextFileDraft !== selectedContextFileContent : false;

  const loadModels = useCallback(async () => {
    const rows = await dbListModels();
    setModels(rows);
  }, []);

  const loadProviders = useCallback(async () => {
    const rows = await providersList();
    setProviderStatusRows(rows);
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
        await Promise.all([loadModels(), loadProviders()]);
        const defaultWorkspacePath = await ensureDefaultWorkspace();
        setWorkspacePathValue(defaultWorkspacePath);
        await loadCamps();
      } catch (bootError) {
        setError(bootError instanceof Error ? bootError.message : 'Unable to load app state.');
      }
    };

    void boot();
  }, [loadCamps, loadModels, loadProviders]);

  // Discover MCP tools from registered servers on startup
  useEffect(() => {
    const discoverMcpTools = async () => {
      try {
        type McpServerStatusPayload = { id: string; enabled: boolean; connected: boolean };
        type McpToolDefPayload = {
          server_id: string;
          name: string;
          qualified_name: string;
          description: string;
          input_schema: Record<string, unknown>;
          read_only: boolean;
        };

        const servers = await invoke<McpServerStatusPayload[]>('mcp_list_servers');
        const enabledServers = servers.filter((s) => s.enabled);
        const allTools: McpToolDefPayload[] = [];

        for (const server of enabledServers) {
          try {
            const tools = await invoke<McpToolDefPayload[]>('mcp_discover_tools', {
              serverId: server.id,
            });
            allTools.push(...tools);
          } catch {
            // If a single server fails, continue with others
          }
        }

        setMcpTools(allTools.map(buildMcpToolEntry));
      } catch {
        // MCP discovery is best-effort; don't block app startup
      }
    };

    void discoverMcpTools();
  }, []);

  useEffect(() => {
    void getDeveloperInspectMode()
      .then((enabled) => {
        setDeveloperInspectMode(enabled);
      })
      .catch(() => {
        setDeveloperInspectMode(false);
      });
  }, []);

  useEffect(() => {
    if (!developerInspectMode) {
      return;
    }

    let isDisposed = false;
    let dispose: (() => void) | null = null;

    void listenInspectEvents((event) => {
      if (isDisposed) {
        return;
      }

      if (!activeCorrelationIdRef.current || event.correlation_id !== activeCorrelationIdRef.current) {
        return;
      }

      inspectTimelineRef.current = [...inspectTimelineRef.current, event];

      setInspectTurn((previous) => {
        if (!previous || previous.correlationId !== event.correlation_id) {
          return previous;
        }

        return {
          ...previous,
          events: [...previous.events, event],
        };
      });
    }).then((unlisten) => {
      if (isDisposed) {
        unlisten();
        return;
      }
      dispose = unlisten;
    });

    return () => {
      isDisposed = true;
      if (dispose) {
        dispose();
      }
    };
  }, [developerInspectMode]);

  const emitInspectEventForTurn = useCallback(
    async (
      campId: string,
      correlationId: string,
      event: Omit<InspectEmitEventPayload, 'camp_id' | 'correlation_id'>,
    ) => {
      if (!developerInspectMode) {
        return;
      }

      try {
        await inspectEmitEvent({
          camp_id: campId,
          correlation_id: correlationId,
          ...event,
        });
      } catch {
        // Ignore inspect telemetry failures so runtime behavior is unchanged.
      }
    },
    [developerInspectMode],
  );

  const emitInspectEventForActiveTurn = useCallback(
    async (campId: string, event: Omit<InspectEmitEventPayload, 'camp_id' | 'correlation_id'>) => {
      const correlationId = activeCorrelationIdRef.current;
      if (!correlationId) {
        return;
      }

      await emitInspectEventForTurn(campId, correlationId, event);
    },
    [emitInspectEventForTurn],
  );

  const captureCampFileMeta = useCallback(
    async (campId: string, relativePath: string): Promise<InspectCampFileMeta | null> => {
      if (!developerInspectMode) {
        return null;
      }

      try {
        return await inspectStatCampFile(campId, relativePath);
      } catch {
        return null;
      }
    },
    [developerInspectMode],
  );

  const commitFileWritesToInspectTurn = useCallback(() => {
    const sortedWrites: InspectFileWrite[] = [...inspectFileWritesRef.current.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => ({
        path: entry.path,
        before: entry.before,
        after: entry.after,
      }));

    setInspectTurn((previous) => {
      if (!previous) {
        return previous;
      }

      return {
        ...previous,
        filesWritten: sortedWrites,
      };
    });
  }, []);

  const recordFileWritesForTurn = useCallback(
    async <T,>(
      campId: string,
      relativePaths: string[],
      operation: () => Promise<T>,
      summary: string,
    ): Promise<T> => {
      const correlationId = activeCorrelationIdRef.current;
      if (!developerInspectMode || !correlationId) {
        return operation();
      }

      const startedAt = Date.now();
      const normalizedPaths = [...new Set(relativePaths)].sort((left, right) => left.localeCompare(right));
      const beforeByPath = new Map<string, InspectCampFileMeta | null>();
      await Promise.all(
        normalizedPaths.map(async (path) => {
          beforeByPath.set(path, await captureCampFileMeta(campId, path));
        }),
      );

      await emitInspectEventForTurn(campId, correlationId, {
        event_type: 'persist_start',
        summary,
        payload: {
          paths: normalizedPaths,
        },
      });

      try {
        const result = await operation();
        const afterByPath = new Map<string, InspectCampFileMeta | null>();
        await Promise.all(
          normalizedPaths.map(async (path) => {
            afterByPath.set(path, await captureCampFileMeta(campId, path));
          }),
        );

        for (const path of normalizedPaths) {
          inspectFileWritesRef.current.set(path, {
            path,
            before: beforeByPath.get(path) ?? null,
            after: afterByPath.get(path) ?? null,
          });
        }
        commitFileWritesToInspectTurn();

        await emitInspectEventForTurn(campId, correlationId, {
          event_type: 'persist_end',
          duration_ms: Date.now() - startedAt,
          summary: `${summary} complete`,
          payload: {
            paths: normalizedPaths,
          },
        });

        return result;
      } catch (error) {
        await emitInspectEventForTurn(campId, correlationId, {
          event_type: 'error',
          summary: `${summary} failed`,
          payload: {
            paths: normalizedPaths,
            error: error instanceof Error ? error.message : 'Unknown persistence error.',
            stack: error instanceof Error ? error.stack : null,
          },
        });
        throw error;
      }
    },
    [
      captureCampFileMeta,
      commitFileWritesToInspectTurn,
      developerInspectMode,
      emitInspectEventForTurn,
    ],
  );

  const recordFileWriteForTurn = useCallback(
    async <T,>(campId: string, relativePath: string, operation: () => Promise<T>, summary: string): Promise<T> =>
      recordFileWritesForTurn(campId, [relativePath], operation, summary),
    [recordFileWritesForTurn],
  );

  useEffect(() => {
    if (!modelOptions.includes(draftModel)) {
      setDraftModel(modelOptions[0] ?? FALLBACK_MODEL);
    }
  }, [modelOptions, draftModel]);

  useEffect(() => {
    if (!selectedModelSupportsTools && draftToolsEnabled) {
      setDraftToolsEnabled(false);
    }
  }, [selectedModelSupportsTools, draftToolsEnabled]);

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
    if (!selectedCamp?.config.is_team) {
      if (centerMode === 'team') {
        setCenterMode('editor');
      }
      if (rightMode === 'team') {
        setRightMode('chat');
      }
    }
  }, [centerMode, rightMode, selectedCamp?.config.is_team]);

  useEffect(() => {
    pruneSelectedArtifacts(artifacts.map((artifact) => artifact.id));
  }, [artifacts, pruneSelectedArtifacts]);

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
    const resolvers = toolApprovalResolversRef.current;
    return () => {
      for (const resolve of resolvers.values()) {
        resolve('reject');
      }
      resolvers.clear();
    };
  }, []);

  const clearToolApprovalQueue = useCallback(() => {
    for (const resolve of toolApprovalResolversRef.current.values()) {
      resolve('reject');
    }
    toolApprovalResolversRef.current.clear();
    setToolApprovalQueue([]);
  }, []);

  useEffect(() => {
    clearSelectedArtifacts();
    clearToolApprovalQueue();
  }, [clearSelectedArtifacts, clearToolApprovalQueue, selectedCampId]);

  useEffect(() => {
    if (!selectedCampId || isSending) { return; }
    composerTextareaRef.current?.focus();
  }, [isSending, selectedCampId]);

  const upsertToolApprovalItem = useCallback((nextItem: ToolApprovalItem) => {
    setToolApprovalQueue((previous) => {
      const existingIndex = previous.findIndex((item) => item.id === nextItem.id);
      if (existingIndex === -1) {
        return [nextItem, ...previous];
      }

      return previous.map((item) => (item.id === nextItem.id ? nextItem : item));
    });
  }, []);

  const resolveToolApproval = useCallback((toolCallId: string, decision: ToolApprovalDecision) => {
    const resolver = toolApprovalResolversRef.current.get(toolCallId);
    if (!resolver) {
      return;
    }

    toolApprovalResolversRef.current.delete(toolCallId);
    setToolApprovalQueue((previous) =>
      previous.map((item) =>
        item.id === toolCallId
          ? {
            ...item,
            status: decision === 'approve' ? 'approved' : 'rejected',
            errorMessage: decision === 'reject' ? TOOL_REJECT_MESSAGE : item.errorMessage,
          }
          : item,
      ),
    );
    resolver(decision);
  }, []);

  const handleApproveToolCall = useCallback((toolCallId: string) => {
    resolveToolApproval(toolCallId, 'approve');
  }, [resolveToolApproval]);

  const handleRejectToolCall = useCallback((toolCallId: string) => {
    resolveToolApproval(toolCallId, 'reject');
  }, [resolveToolApproval]);

  const handleApproveAllPendingToolCalls = useCallback(() => {
    const pendingIds = toolApprovalQueue.filter((item) => item.status === 'pending').map((item) => item.id);
    for (const id of pendingIds) {
      resolveToolApproval(id, 'approve');
    }
  }, [resolveToolApproval, toolApprovalQueue]);

  const handleRejectAllPendingToolCalls = useCallback(() => {
    const pendingIds = toolApprovalQueue.filter((item) => item.status === 'pending').map((item) => item.id);
    for (const id of pendingIds) {
      resolveToolApproval(id, 'reject');
    }
  }, [resolveToolApproval, toolApprovalQueue]);

  const executeToolCallWithApproval = useCallback(
    async (
      campId: string,
      toolCall: OpenRouterToolCall & { id: string },
    ): Promise<string> => {
      const argsJson = toolCall.function.arguments ?? '{}';
      const toolKind = getToolKind(toolCall.function.name) ?? 'unknown';
      const requiresApproval = shouldRequireToolApproval(TOOL_APPROVAL_MODE, toolKind);
      const initialItem: ToolApprovalItem = {
        id: toolCall.id,
        name: toolCall.function.name,
        kind: toolKind,
        argsJson,
        status: requiresApproval ? 'pending' : 'running',
        resultPreview: null,
        errorMessage: null,
        createdAt: Date.now(),
      };
      upsertToolApprovalItem(initialItem);

      if (requiresApproval) {
        const decision = await new Promise<ToolApprovalDecision>((resolve) => {
          toolApprovalResolversRef.current.set(toolCall.id, resolve);
        });

        if (decision === 'reject') {
          return JSON.stringify({ error: TOOL_REJECT_MESSAGE });
        }

        setToolApprovalQueue((previous) =>
          previous.map((item) => (item.id === toolCall.id ? { ...item, status: 'running' } : item)),
        );
      }

      try {
        const toolResult = isMcpToolName(toolCall.function.name)
          ? await executeMcpToolCall(toolCall)
          : await executeCampToolCall(toolCall, {
            readFile: async (path) => campReadContextFile(campId, path),
            listFiles: async (path) => campListContextFiles(campId, path),
            writeFile: async (path, content, encoding) => {
              const normalizedPath = path.trim().replace(/^\/+/, '');
              await recordFileWritesForTurn(
                campId,
                [`context/${normalizedPath}`, 'camp.json'],
                () => encoding === 'base64'
                  ? campWriteContextFileBytes(campId, path, content)
                  : campWriteContextFile(campId, path, content),
                `Tool write_file -> ${normalizedPath}`,
              );
            },
            listArtifacts: async () => campListArtifacts(campId),
            getArtifact: async (artifactId) => campGetArtifact(campId, artifactId),
            createArtifact: async ({ sourceMessageId, title, tags }) => {
              const artifact = await recordFileWritesForTurn(
                campId,
                ['artifacts/index.json', 'camp.json'],
                () =>
                  campCreateArtifactFromMessage({
                    camp_id: campId,
                    message_id: sourceMessageId,
                    title,
                    tags,
                  }),
                'Tool create_artifact',
              );

              const artifactPath = `artifacts/${artifact.metadata.filename}`;
              const artifactMeta = await captureCampFileMeta(campId, artifactPath);
              inspectFileWritesRef.current.set(artifactPath, {
                path: artifactPath,
                before: null,
                after: artifactMeta,
              });
              commitFileWritesToInspectTurn();

              return artifact;
            },
            updateArtifact: async ({ artifactId, title, body, tags }) => {
              const artifact = await recordFileWritesForTurn(
                campId,
                ['artifacts/index.json', 'camp.json'],
                () =>
                  campUpdateArtifact({
                    camp_id: campId,
                    artifact_id: artifactId,
                    title,
                    body,
                    tags,
                  }),
                'Tool update_artifact',
              );

              const artifactPath = `artifacts/${artifact.metadata.filename}`;
              const artifactMeta = await captureCampFileMeta(campId, artifactPath);
              inspectFileWritesRef.current.set(artifactPath, {
                path: artifactPath,
                before: null,
                after: artifactMeta,
              });
              commitFileWritesToInspectTurn();

              return artifact;
            },
            searchTranscript: async ({ query, limit, roles }) =>
              campSearchTranscript(campId, {
                query,
                limit,
                roles,
              }),
            updateCampPrompt: async (systemPrompt) => {
              await recordFileWritesForTurn(
                campId,
                ['system_prompt.md', 'camp.json'],
                () =>
                  campUpdateSystemPrompt({
                    camp_id: campId,
                    system_prompt: systemPrompt,
                  }),
                'Tool update_camp_prompt',
              );
              setDraftSystemPrompt(systemPrompt);
            },
            updateCampMemory: async (memory) => {
              await recordFileWritesForTurn(
                campId,
                ['memory.json', 'camp.json'],
                () =>
                  campUpdateMemory({
                    camp_id: campId,
                    memory,
                  }),
                'Tool update_camp_memory',
              );
            },
          });

        setToolApprovalQueue((previous) =>
          previous.map((item) =>
            item.id === toolCall.id
              ? {
                ...item,
                status: 'done',
                resultPreview: truncatePreview(toolResult.replace(/\s+/g, ' ').trim()),
                errorMessage: null,
              }
              : item,
          ),
        );

        return toolResult;
      } catch (toolError) {
        const errorMessage = toolError instanceof Error ? toolError.message : 'Tool execution failed.';
        void emitInspectEventForActiveTurn(campId, {
          event_type: 'error',
          summary: `Tool ${toolCall.function.name} failed`,
          payload: {
            tool_call_id: toolCall.id,
            tool_name: toolCall.function.name,
            error: errorMessage,
            stack: toolError instanceof Error ? toolError.stack : null,
          },
        });

        setToolApprovalQueue((previous) =>
          previous.map((item) =>
            item.id === toolCall.id
              ? {
                ...item,
                status: 'error',
                errorMessage,
              }
              : item,
          ),
        );

        return JSON.stringify({ error: errorMessage });
      }
    },
    [
      captureCampFileMeta,
      commitFileWritesToInspectTurn,
      emitInspectEventForActiveTurn,
      recordFileWritesForTurn,
      upsertToolApprovalItem,
    ],
  );

  useEffect(() => {
    if (!selectedCampId || !selectedContextFilePath) {
      setSelectedContextFileContent('');
      setContextFileDraft('');
      return;
    }

    let ignore = false;
    setIsLoadingContextFile(true);
    setError(null);

    const isBinary = /\.(png|jpe?g|gif|webp|pdf)$/i.test(selectedContextFilePath);
    const readPromise = isBinary
      ? campReadContextFileBase64(selectedCampId, selectedContextFilePath)
      : campReadContextFile(selectedCampId, selectedContextFilePath);

    void readPromise
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
        system_prompt: 'You are Basecamp, an expert AI assistant. You have access to tools that allow you to read, write, and manage files in the user\'s workspace. You can generate rich multimodal artifacts like PDFs, images, and HTML. When asked to create a file, image, or PDF, you MUST use the `write_file` or `create_artifact` tools to generate it. For binary formats like images or PDFs, always use the `base64` encoding parameter. Do NOT refuse to create files, and do NOT output raw base64 or binary data into the chat. Always use the provided tools.',
        memory: {},
        tools_enabled: true,
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

    await recordFileWriteForTurn(
      selectedCampId,
      'camp.json',
      () =>
        campUpdateConfig({
          camp_id: selectedCampId,
          name: draftName,
          model: draftModel,
          tools_enabled: draftToolsEnabled && selectedModelSupportsTools,
        }),
      'Persist camp config before send',
    );

    await recordFileWritesForTurn(
      selectedCampId,
      ['system_prompt.md', 'camp.json'],
      () =>
        campUpdateSystemPrompt({
          camp_id: selectedCampId,
          system_prompt: draftSystemPrompt,
        }),
      'Persist system prompt before send',
    );

    const refreshedCamp = await campLoad(selectedCampId);
    setSelectedCamp(refreshedCamp);
    await loadCamps();

    return refreshedCamp;
  }, [
    draftModel,
    draftName,
    draftSystemPrompt,
    draftToolsEnabled,
    selectedModelSupportsTools,
    loadCamps,
    recordFileWriteForTurn,
    recordFileWritesForTurn,
    selectedCampId,
  ]);

  const handleSyncModels = async () => {
    setIsSyncingModels(true);
    setError(null);
    setStatus(null);

    try {
      const { count } = await syncModelsToDb();
      await Promise.all([loadModels(), loadProviders()]);
      setStatus(`Refreshed ${count} models from enabled providers.`);
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
    clearToolApprovalQueue();

    const correlationId = developerInspectMode ? buildCorrelationId() : null;
    if (correlationId) {
      activeCorrelationIdRef.current = correlationId;
      inspectFileWritesRef.current.clear();
      inspectTimelineRef.current = [];
      setInspectExportError(null);
      setInspectTurn({
        correlationId,
        events: [],
        requestPayload: { requests: [] },
        responsePayload: { responses: [] },
        filesWritten: [],
        composedInputBreakdown: null,
        exportPath: null,
      });
    }

    const capturedRequests: unknown[] = [];
    const capturedResponses: unknown[] = [];
    let composedBreakdown: unknown = null;

    try {
      await persistCampDraftsForSend();
      const selectedArtifactsForRequest: CampArtifact[] = await Promise.all(
        selectedArtifactIds.map((artifactId) => campGetArtifact(selectedCampId, artifactId)),
      );

      await recordFileWritesForTurn(
        selectedCampId,
        ['transcript.jsonl', 'camp.json'],
        () =>
          campAppendMessage({
            camp_id: selectedCampId,
            role: 'user',
            content: trimmedMessage,
            included_artifact_ids: selectedArtifactIds.length > 0 ? selectedArtifactIds : undefined,
            attachments: userAttachments.length > 0 ? userAttachments : undefined,
          }),
        'Append user message',
      );

      const campWithUser = await campLoad(selectedCampId);
      setSelectedCamp(campWithUser);

      const runRuntime = (campForRuntime: Camp) =>
        runCampChatRuntime({
          campId: selectedCampId,
          camp: campForRuntime,
          selectedArtifacts: selectedArtifactsForRequest,
          temperature,
          maxTokens,
          onToken: (token) => {
            setStreamingText((previous) => previous + token);
          },
          tools: selectedModelSupportsTools ? getAllToolSpecs() : undefined,
          correlationId: correlationId ?? undefined,
          onComposeStart: correlationId
            ? () => {
              void emitInspectEventForTurn(selectedCampId, correlationId, {
                event_type: 'compose_start',
                summary: 'Composing provider payload',
              });
            }
            : undefined,
          onComposeEnd: correlationId
            ? ({ requestPayload, breakdown }) => {
              composedBreakdown = breakdown;
              setInspectTurn((previous) => {
                if (!previous || previous.correlationId !== correlationId) {
                  return previous;
                }

                return {
                  ...previous,
                  composedInputBreakdown: breakdown,
                };
              });

              void emitInspectEventForTurn(selectedCampId, correlationId, {
                event_type: 'compose_end',
                summary: `Composed ${requestPayload.messages.length} messages`,
                payload: {
                  model: requestPayload.model,
                  message_count: requestPayload.messages.length,
                  tool_count: requestPayload.tools?.length ?? 0,
                  artifact_count: breakdown && typeof breakdown === 'object' && 'artifacts' in breakdown
                    ? ((breakdown as { artifacts?: unknown[] }).artifacts?.length ?? 0)
                    : 0,
                },
              });
            }
            : undefined,
          telemetry: correlationId
            ? {
              onHttpRequestStart: (httpEvent) => {
                capturedRequests.push(httpEvent.request_payload);
                setInspectTurn((previous) => {
                  if (!previous || previous.correlationId !== correlationId) {
                    return previous;
                  }

                  const existing = previous.requestPayload?.requests ?? [];
                  return {
                    ...previous,
                    requestPayload: {
                      requests: [...existing, httpEvent.request_payload],
                    },
                  };
                });

                void emitInspectEventForTurn(selectedCampId, correlationId, {
                  event_type: 'http_request_start',
                  summary: `Provider request (${httpEvent.message_count} messages)`,
                  payload: {
                    model: httpEvent.request_payload.model,
                    message_count: httpEvent.message_count,
                    stream: httpEvent.stream,
                  },
                });
              },
              onHttpRequestEnd: (httpEvent) => {
                const nextResponse = {
                  provider_kind: httpEvent.provider_kind,
                  base_url: httpEvent.base_url,
                  status_code: httpEvent.status,
                  duration_ms: httpEvent.duration_ms,
                  headers: httpEvent.response_headers,
                  body: httpEvent.response_payload,
                  stream: httpEvent.stream,
                  stream_chunk_count: httpEvent.stream_chunk_count ?? null,
                };
                capturedResponses.push(nextResponse);
                setInspectTurn((previous) => {
                  if (!previous || previous.correlationId !== correlationId) {
                    return previous;
                  }

                  const existing = previous.responsePayload?.responses ?? [];
                  return {
                    ...previous,
                    responsePayload: {
                      responses: [...existing, nextResponse],
                    },
                  };
                });

                void emitInspectEventForTurn(selectedCampId, correlationId, {
                  event_type: 'http_request_end',
                  duration_ms: httpEvent.duration_ms,
                  summary: `${httpEvent.provider_kind} response ${httpEvent.status}`,
                  payload: {
                    provider_kind: httpEvent.provider_kind,
                    base_url: httpEvent.base_url,
                    status_code: httpEvent.status,
                    stream: httpEvent.stream,
                    stream_chunk_count: httpEvent.stream_chunk_count ?? 0,
                  },
                });

                if (typeof httpEvent.stream_chunk_count === 'number' && httpEvent.stream_chunk_count > 0) {
                  void emitInspectEventForTurn(selectedCampId, correlationId, {
                    event_type: 'stream_chunk',
                    summary: `${httpEvent.stream_chunk_count} stream chunks`,
                    payload: {
                      count: httpEvent.stream_chunk_count,
                    },
                  });
                }
              },
              onHttpRequestError: (httpEvent) => {
                const nextResponse = {
                  provider_kind: httpEvent.provider_kind ?? null,
                  status_code: httpEvent.status ?? null,
                  duration_ms: httpEvent.duration_ms,
                  error: httpEvent.error_message,
                  response: httpEvent.response_payload,
                  stream: httpEvent.stream,
                };
                capturedResponses.push(nextResponse);
                setInspectTurn((previous) => {
                  if (!previous || previous.correlationId !== correlationId) {
                    return previous;
                  }

                  const existing = previous.responsePayload?.responses ?? [];
                  return {
                    ...previous,
                    responsePayload: {
                      responses: [...existing, nextResponse],
                    },
                  };
                });

                void emitInspectEventForTurn(selectedCampId, correlationId, {
                  event_type: 'error',
                  duration_ms: httpEvent.duration_ms,
                  summary: 'Provider request failed',
                  payload: {
                    provider_kind: httpEvent.provider_kind ?? null,
                    status_code: httpEvent.status ?? null,
                    error: httpEvent.error_message,
                    response: httpEvent.response_payload,
                    stack: httpEvent.stack ?? null,
                  },
                });
              },
              onToolCallStart: (toolEvent) => {
                void emitInspectEventForTurn(selectedCampId, correlationId, {
                  event_type: 'tool_call_start',
                  summary: `Tool call ${toolEvent.tool_name} started`,
                  payload: {
                    tool_call_id: toolEvent.tool_call_id,
                    tool_name: toolEvent.tool_name,
                  },
                });
              },
              onToolCallEnd: (toolEvent) => {
                void emitInspectEventForTurn(selectedCampId, correlationId, {
                  event_type: 'tool_call_end',
                  duration_ms: toolEvent.duration_ms,
                  summary: `Tool call ${toolEvent.tool_name} ${toolEvent.success ? 'completed' : 'returned error'}`,
                  payload: {
                    tool_call_id: toolEvent.tool_call_id,
                    tool_name: toolEvent.tool_name,
                    success: toolEvent.success,
                  },
                });
              },
            }
            : undefined,
          executeToolCall: async ({ campId, toolCall }) => {
            return executeToolCallWithApproval(campId, toolCall);
          },
        });

      const runtimeResult = await runRuntime(campWithUser);

      for (const message of runtimeResult.transcriptMessages) {
        await recordFileWritesForTurn(
          selectedCampId,
          ['transcript.jsonl', 'camp.json'],
          () =>
            campAppendMessage({
              camp_id: selectedCampId,
              ...message,
            }),
          `Append ${message.role} message`,
        );
      }

      if (correlationId) {
        const requestPayloadForFile = {
          correlation_id: correlationId,
          composed_input_breakdown: composedBreakdown ?? runtimeResult.composedInputBreakdown,
          requests: capturedRequests,
        };
        const responsePayloadForFile = {
          correlation_id: correlationId,
          responses: capturedResponses,
        };

        await inspectWriteTurnRequest({
          camp_id: selectedCampId,
          correlation_id: correlationId,
          payload: requestPayloadForFile,
        });
        await inspectWriteTurnResponse({
          camp_id: selectedCampId,
          correlation_id: correlationId,
          payload: responsePayloadForFile,
        });

        setInspectTurn((previous) => {
          if (!previous || previous.correlationId !== correlationId) {
            return previous;
          }

          return {
            ...previous,
            requestPayload: { requests: capturedRequests },
            responsePayload: { responses: capturedResponses },
            composedInputBreakdown: composedBreakdown ?? runtimeResult.composedInputBreakdown,
          };
        });
      }

      const updatedCamp = await campLoad(selectedCampId);
      setSelectedCamp(updatedCamp);
      const usageIncrementPromise =
        selectedArtifactIds.length > 0
          ? recordFileWritesForTurn(
            selectedCampId,
            ['artifacts/index.json', 'camp.json'],
            () => campIncrementArtifactUsage(selectedCampId, selectedArtifactIds),
            'Increment selected artifact usage',
          )
          : Promise.resolve();
      const [, , refreshedContextFiles] = await Promise.all([
        loadCamps(),
        loadArtifacts(selectedCampId),
        loadCampContextFiles(selectedCampId),
        usageIncrementPromise,
      ]);
      setAttachedContextFiles(refreshedContextFiles);

      if (correlationId) {
        const filesWritten = [...inspectFileWritesRef.current.values()]
          .sort((left, right) => left.path.localeCompare(right.path))
          .map((entry) => ({
            path: entry.path,
            before: entry.before,
            after: entry.after,
          }));

        const bundlePayload = {
          correlation_id: correlationId,
          composed_input_breakdown: composedBreakdown ?? runtimeResult.composedInputBreakdown,
          openrouter_request_json: {
            requests: capturedRequests,
          },
          openrouter_response_json: {
            responses: capturedResponses,
          },
          event_timeline: inspectTimelineRef.current,
          files_written: filesWritten,
        };

        const bundlePath = await inspectWriteTurnBundle({
          camp_id: selectedCampId,
          correlation_id: correlationId,
          payload: bundlePayload,
        });

        setInspectTurn((previous) => {
          if (!previous || previous.correlationId !== correlationId) {
            return previous;
          }

          return {
            ...previous,
            filesWritten,
            exportPath: bundlePath || previous.exportPath,
          };
        });
      }

      setUserMessage('');
      setUserAttachments([]);
      setStreamingText('');
      setStatus(
        runtimeResult.usingTools
          ? 'Response completed with tool use and saved to transcript.jsonl'
          : 'Response streamed and saved to transcript.jsonl',
      );
    } catch (sendError) {
      if (correlationId) {
        await emitInspectEventForTurn(selectedCampId, correlationId, {
          event_type: 'error',
          summary: 'Chat turn failed',
          payload: {
            error: sendError instanceof Error ? sendError.message : 'Unknown send error.',
            stack: sendError instanceof Error ? sendError.stack : null,
          },
        });
      }

      if (sendError instanceof OpenRouterRequestError) {
        setError(`${sendError.message} (model: ${sendError.requestPayload.model})`);
      } else {
        setError(sendError instanceof Error ? sendError.message : 'Unable to send message.');
      }
    } finally {
      setIsSending(false);
    }
  };

  const handleBranchFromMessage = (message: CampMessage) => {
    setStatus(`Branch from message ${message.id.slice(0, 8)} is coming soon.`);
  };

  const handleReplayFromMessage = (message: CampMessage) => {
    setStatus(`Replay from message ${message.id.slice(0, 8)} is coming soon.`);
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const handleFileAttach = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const base64Url = e.target?.result as string;
      setUserAttachments((prev) => [
        ...prev,
        { type: 'image_url', image_url: { url: base64Url } },
      ]);
    };
    reader.readAsDataURL(file);
    event.target.value = ''; // Reset input
  };

  const buildInspectBundlePayload = useCallback((turn: ActiveInspectTurn) => {
    const filesWritten = turn.filesWritten
      .map((entry) => ({
        path: entry.path,
        before: entry.before,
        after: entry.after,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));

    return {
      correlation_id: turn.correlationId,
      composed_input_breakdown: turn.composedInputBreakdown,
      openrouter_request_json: turn.requestPayload ?? { requests: [] },
      openrouter_response_json: turn.responsePayload ?? { responses: [] },
      event_timeline: [...turn.events].sort((left, right) => left.timestamp_ms - right.timestamp_ms),
      files_written: filesWritten,
    };
  }, []);

  const handleExportTurnBundle = useCallback(async () => {
    if (!selectedCampId || !inspectTurn) {
      return;
    }

    setInspectExporting(true);
    setInspectExportError(null);

    try {
      const bundlePath = await inspectWriteTurnBundle({
        camp_id: selectedCampId,
        correlation_id: inspectTurn.correlationId,
        payload: buildInspectBundlePayload(inspectTurn),
      });

      setInspectTurn((previous) => {
        if (!previous || previous.correlationId !== inspectTurn.correlationId) {
          return previous;
        }

        return {
          ...previous,
          exportPath: bundlePath || previous.exportPath,
        };
      });
    } catch (error) {
      setInspectExportError(error instanceof Error ? error.message : 'Unable to export turn bundle.');
    } finally {
      setInspectExporting(false);
    }
  }, [buildInspectBundlePayload, inspectTurn, selectedCampId]);

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
    <AppShell
      leftPaneWidth={leftPaneWidth}
      rightPaneWidth={rightPaneWidth}
      onLeftPaneResize={setLeftPaneWidth}
      onRightPaneResize={setRightPaneWidth}
      leftPaneCollapsed={leftPaneCollapsed}
      rightPaneCollapsed={rightPaneCollapsed}
      topBar={
        <header className="ide-top-bar">
          <div className="ide-top-bar-left">
            <h1 className="ide-camp-title">
              Basecamp
              <span className={`status-dot ${selectedProviderStatus && !selectedProviderStatus.last_error ? 'online' : ''}`} title={selectedProviderStatus?.last_error || 'Online'} />
            </h1>
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              {workspacePath ? (selectedCamp?.config.name || 'No Camp Selected') : 'No Workspace'}
            </span>
          </div>
          <div className="ide-top-bar-center">
            {selectedCamp && (
              <select
                value={draftModel}
                onChange={(event) => setDraftModel(event.target.value)}
                style={{ width: '240px', padding: 'var(--space-1) var(--space-2)', fontSize: 'var(--text-xs)' }}
              >
                {modelOptionsWithLabels.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            )}
            {error && <span className="error-line" style={{ margin: 0, padding: 'var(--space-1) var(--space-2)' }}>{error}</span>}
            {status && <span className="status-line" style={{ margin: 0, padding: 'var(--space-1) var(--space-2)' }}>{status}</span>}
          </div>
          <div className="ide-top-bar-right">
            <button type="button" className="icon-button" onClick={() => navigate('/home')} title="Home">HOME</button>
            <button type="button" className="icon-button" onClick={handlePickWorkspace} title="Open Folder">DIR</button>
            <button type="button" className="icon-button" onClick={handleSyncModels} disabled={isSyncingModels} title="Sync Models">
              {isSyncingModels ? '...' : 'SYNC'}
            </button>
            {workspacePath && (
              <button
                type="button"
                className="icon-button"
                onClick={handleCreateCamp}
                title="New Camp"
              >
                NEW
              </button>
            )}
          </div>
        </header>
      }
      leftPane={
        <LeftPane
          activeTab={leftTab}
          onTabChange={setLeftTab}
          renderCamps={() => (
            <div className="camp-list-scroll" style={{ border: 'none', background: 'transparent' }}>
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
              {camps.length === 0 ? (
                <ViewState.Empty title="No Camps" message="Create your first basecamp to begin orchestrating." icon="⛺" />
              ) : null}
            </div>
          )}
          renderFiles={() => (
            <div className="context-tree-scroll" style={{ border: 'none', background: 'transparent' }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--space-2)' }}>
                <button type="button" className="icon-button" onClick={handleRefreshContext} disabled={isRefreshingContext} style={{ padding: 'var(--space-1)', fontSize: '10px' }}>
                  {isRefreshingContext ? '...' : '🔄 Refresh'}
                </button>
              </div>
              {!selectedCamp ? (
                <ViewState.Empty title="No Basecamp Selected" message="Select a Camp to explore context paths." />
              ) : null}
              {selectedCamp && contextTree.length === 0 ? (
                <ViewState.Empty title="Context Empty" message="No tracked files found." />
              ) : null}
              {selectedCamp ? renderContextTree(contextTree) : null}
            </div>
          )}
          renderContext={() => (
            <div className="artifact-scroll composer-artifact-scroll" style={{ border: 'none', background: 'transparent', maxHeight: 'none' }}>
              <label>
                <span>Search Artifacts</span>
                <input
                  type="text"
                  value={artifactQuery}
                  onChange={(event) => setArtifactQuery(event.target.value)}
                  placeholder="Filter by title or tag"
                  disabled={!selectedCamp}
                />
              </label>

              {selectedArtifactsForComposer.length > 0 && (
                <div className="artifact-chip-row" style={{ marginTop: 'var(--space-2)' }}>
                  {selectedArtifactsForComposer.map((artifact) => (
                    <button
                      key={artifact.id}
                      type="button"
                      className="artifact-chip selectable"
                      onClick={() => removeSelectedArtifact(artifact.id)}
                      title="Remove from next message"
                    >
                      {artifact.title}
                    </button>
                  ))}
                </div>
              )}

              <div style={{ marginTop: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                {visibleArtifacts.map((artifact) => {
                  const isSelected = selectedArtifactIds.includes(artifact.id);
                  return (
                    <button
                      key={artifact.id}
                      type="button"
                      className={`artifact-item artifact-select-toggle ${isSelected ? 'is-selected' : ''}`}
                      onClick={() => toggleArtifactSelection(artifact.id)}
                      disabled={!selectedCamp || isSending}
                    >
                      <strong>{artifact.title}</strong>
                      <p>{artifact.tags.length > 0 ? artifact.tags.join(', ') : 'No tags'}</p>
                    </button>
                  );
                })}
              </div>
              {selectedCamp && visibleArtifacts.length === 0 ? (
                <ViewState.Empty title="No Match" message="No artifacts found." />
              ) : null}
            </div>
          )}
        />
      }
      centerPane={
        <CenterPane
          mode={centerMode}
          modes={selectedCamp?.config.is_team ? ['editor', 'team'] : ['editor']}
          onModeChange={setCenterMode}
          renderHeaderActions={() => (
            <>
              {centerMode === 'editor' ? (
                <button
                  type="button"
                  className="primary-action icon-button"
                  onClick={handleSaveContextFile}
                  disabled={!selectedCamp || !selectedContextFilePath || !contextFileDirty || isSavingContextFile}
                  title="Save File"
                >
                  {isSavingContextFile ? '...' : '💾'}
                </button>
              ) : null}
            </>
          )}
          renderContent={() => {
            if (centerMode === 'team' && selectedCampId) {
              return (
                <div className="canvas-editor-shell" style={{ border: 'none', background: 'transparent', flex: '1', minHeight: 0, padding: 'var(--space-2)', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
                  <TeamConfig campId={selectedCampId} modelOptions={modelOptions} />
                </div>
              );
            }

            return (
              <div className="canvas-editor-shell" style={{ border: 'none', background: 'transparent', flex: '1', minHeight: 0, padding: 'var(--space-2)', display: 'flex', flexDirection: 'column' }}>
                {!selectedCamp ? (
                  <ViewState.Empty title="Uninitialized" message="Create or select a camp to compose artifacts." icon="🏗️" />
                ) : null}
                {selectedCamp && !selectedContextFilePath ? (
                  <ViewState.Empty title="No File Selected" message="Pick a file from the explorer to preview or edit." icon="📄" />
                ) : null}
                {selectedCamp && selectedContextFilePath ? (
                  isLoadingContextFile ? (
                    <ViewState.Loading title="Loading File..." />
                  ) : /\.(png|jpe?g|gif|webp)$/i.test(selectedContextFilePath) ? (
                    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', padding: 'var(--space-4)' }}>
                      <img src={`data:image/${selectedContextFilePath.split('.').pop()};base64,${contextFileDraft}`} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} alt="Preview" />
                    </div>
                  ) : /\.pdf$/i.test(selectedContextFilePath) ? (
                    <div style={{ width: '100%', height: '100%' }}>
                      <object data={`data:application/pdf;base64,${contextFileDraft}`} type="application/pdf" width="100%" height="100%">
                        <p>Browser cannot display PDF.</p>
                      </object>
                    </div>
                  ) : /\.html?$/i.test(selectedContextFilePath) ? (
                    <div style={{ width: '100%', height: '100%', background: 'white' }}>
                      <iframe srcDoc={contextFileDraft} sandbox="allow-scripts allow-popups" style={{ width: '100%', height: '100%', border: 'none' }} title="Preview" />
                    </div>
                  ) : (
                    <textarea
                      className="canvas-editor"
                      value={contextFileDraft}
                      onChange={(event) => setContextFileDraft(event.target.value)}
                      spellCheck={false}
                      style={{ flex: 1, minHeight: 0, margin: 0, padding: 0 }}
                    />
                  )
                ) : null}
              </div>
            );
          }}
        />
      }
      rightPane={
        <RightPane
          renderTranscript={() => (
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              <div className="chat-header" style={{ padding: 'var(--space-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                  {selectedCamp?.config.is_team ? (
                    <>
                      <button
                        type="button"
                        className={`mode-tab ${rightMode === 'chat' ? 'active' : ''}`}
                        onClick={() => setRightMode('chat')}
                      >
                        CHAT
                      </button>
                      <button
                        type="button"
                        className={`mode-tab ${rightMode === 'team' ? 'active' : ''}`}
                        onClick={() => setRightMode('team')}
                      >
                        TEAM
                      </button>
                    </>
                  ) : (
                    <div style={{ fontWeight: 'bold' }}>CHAT</div>
                  )}
                </div>
                {selectedCamp && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    {rightMode === 'chat' ? (
                      <label className="settings-toggle" style={{ margin: 0, display: 'flex', gap: '6px' }}>
                        <input
                          type="checkbox"
                          checked={draftToolsEnabled}
                          disabled={!selectedModelSupportsTools}
                          onChange={(event) => setDraftToolsEnabled(event.target.checked)}
                        />
                        <span style={{ fontSize: '0.8rem' }}>Tools</span>
                      </label>
                    ) : null}
                  </div>
                )}
              </div>
              {rightMode === 'team' && selectedCamp ? (
                <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 'var(--space-1)' }}>
                  <TeamArena campId={selectedCamp.config.id} />
                </div>
              ) : (
                <>
                  <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                    <TranscriptView
                      selectedCamp={selectedCamp}
                      streamingText={streamingText}
                      artifactById={artifactById}
                      isSending={isSending}
                      promotingMessageId={promotingMessageId}
                      onBranchFromMessage={handleBranchFromMessage}
                      onReplayFromMessage={handleReplayFromMessage}
                      onPromoteMessageToArtifact={(message) => {
                        void handlePromoteMessageToArtifact(message);
                      }}
                    />
                  </div>

                  {toolApprovalQueue.length > 0 && (
                    <section className="tool-approval-queue" style={{ maxHeight: '200px', border: 'none', borderTop: 'var(--border-width) solid var(--line)', background: 'transparent' }}>
                      <header className="panel-header" style={{ padding: 'var(--space-1) 0' }}>
                        <h2 style={{ fontSize: 'var(--text-xs)' }}>TOOL QUEUE</h2>
                        <div className="tool-queue-actions">
                          <button
                            type="button"
                            onClick={handleApproveAllPendingToolCalls}
                            disabled={!toolApprovalQueue.some((item) => item.status === 'pending')}
                            title="Approve All"
                            style={{ padding: '2px 4px', fontSize: '10px' }}
                          >
                            [APPROVE] ALL
                          </button>
                          <button
                            type="button"
                            onClick={handleRejectAllPendingToolCalls}
                            disabled={!toolApprovalQueue.some((item) => item.status === 'pending')}
                            title="Reject All"
                            style={{ padding: '2px 4px', fontSize: '10px' }}
                          >
                            [REJECT] ALL
                          </button>
                        </div>
                      </header>
                      <div className="tool-queue-list">
                        {toolApprovalQueue.map((item) => (
                          <article key={item.id} className={`tool-queue-item ${item.status}`} style={{ padding: 'var(--space-1)' }}>
                            <header>
                              <strong style={{ fontSize: '10px' }}>{item.name}</strong>
                              <span style={{ fontSize: '10px' }}>{item.status}</span>
                            </header>
                            {item.status === 'pending' ? (
                              <div className="tool-queue-item-actions" style={{ marginTop: 'var(--space-1)' }}>
                                <button type="button" onClick={() => handleApproveToolCall(item.id)}>[APPROVE]</button>
                                <button type="button" onClick={() => handleRejectToolCall(item.id)}>[REJECT]</button>
                              </div>
                            ) : null}
                          </article>
                        ))}
                      </div>
                    </section>
                  )}

                  <InspectPanel
                    enabled={developerInspectMode}
                    turn={inspectTurn}
                    exporting={inspectExporting}
                    exportError={inspectExportError}
                    onExport={() => {
                      void handleExportTurnBundle();
                    }}
                  />
                </>
              )}
            </div>
          )}
          renderComposer={() => (
            rightMode === 'team' ? (
              <div style={{ borderTop: 'var(--border-width) solid var(--line)', padding: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                Team mode active. Use Team Arena to decompose and execute tasks.
              </div>
            ) : (
              <form className="composer main-layout-composer" onSubmit={handleSendMessage} style={{ border: 'none', borderTop: 'var(--border-width) solid var(--line)', padding: 'var(--space-2)', margin: 0 }}>
                {userAttachments.length > 0 && (
                  <div className="composer-attachments" style={{ display: 'flex', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
                    {userAttachments.map((att, idx) => (
                      <div key={idx} style={{ position: 'relative', width: '40px', height: '40px' }}>
                        {att.type === 'image_url' && (
                          <img src={att.image_url.url} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '4px', border: '1px solid var(--line)' }} alt="Attached file" />
                        )}
                        <button type="button" onClick={() => setUserAttachments(prev => prev.filter((_, i) => i !== idx))} style={{ position: 'absolute', top: '-5px', right: '-5px', background: 'var(--text-error, red)', color: 'var(--bg, white)', borderRadius: '50%', width: '16px', height: '16px', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', padding: 0, lineHeight: 1 }}>×</button>
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  ref={composerTextareaRef}
                  value={userMessage}
                  onChange={(event) => setUserMessage(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  rows={2}
                  placeholder={selectedCamp ? 'Ask anything...' : 'Create or select a camp first'}
                  disabled={!selectedCamp}
                  autoFocus
                  style={{ minHeight: '60px', marginBottom: 'var(--space-2)', fontSize: 'var(--text-sm)', border: 'none', background: 'transparent', resize: 'none' }}
                />
                <div className="composer-actions" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div className="composer-toolbar">
                    <input type="file" id="composer-file-upload" accept="image/*" onChange={handleFileAttach} style={{ display: 'none' }} />
                    <label htmlFor="composer-file-upload" className="secondary-action icon-button" style={{ cursor: 'pointer', padding: '4px 8px' }} title="Attach File">
                      [ATTACH]
                    </label>
                  </div>
                  <button type="submit" className="primary-action icon-button" disabled={isSending || !selectedCamp} title="Send Message" style={{ padding: '4px 8px' }}>
                    {isSending ? '...' : '[SEND]'}
                  </button>
                </div>
              </form>
            )
          )}
        />
      }
    />
  );
}
