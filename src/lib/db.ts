import { invoke } from '@tauri-apps/api/core';

import type {
  ApprovalPolicy,
  Camp,
  CampArtifact,
  CampArtifactMetadata,
  CampAppendMessagePayload,
  CampCreateArtifactFromMessagePayload,
  CampCreatePayload,
  CampMessage,
  CampSearchTranscriptPayload,
  CampSummary,
  CampTranscriptSearchMatch,
  CampToggleArtifactArchivePayload,
  CampUpdateConfigPayload,
  CampUpdateArtifactPayload,
  CampUpdateMemoryPayload,
  CampUpdateSystemPromptPayload,
  ModelRow,
  Run,
  RunInsertPayload,
  RunSearchDbArgs,
  RunSearchDbRow,
  RunStartConfig,
  RunStartResult,
  RunStateEvent,
  RunUpdatePayload,
  ToolCallRow,
  ToolCallStartPayload,
  WriteNotePayload,
  WriteNoteResult,
} from './types';

export async function saveApiKey(apiKey: string): Promise<void> {
  await invoke('save_api_key', { apiKey });
}

export async function hasApiKey(): Promise<boolean> {
  return invoke<boolean>('has_api_key');
}

export type OpenRouterModelsSyncResult = {
  count: number;
  updated_at: number;
};

export async function openrouterSyncModels(): Promise<OpenRouterModelsSyncResult> {
  return invoke<OpenRouterModelsSyncResult>('openrouter_sync_models');
}

export async function insertRun(payload: RunInsertPayload): Promise<void> {
  await invoke('insert_run', { payload });
}

export async function listRuns(): Promise<Run[]> {
  return invoke<Run[]>('list_runs');
}

export async function getRunById(id: string): Promise<Run | null> {
  return invoke<Run | null>('get_run_by_id', { id });
}

export async function updateRunRatingAndTags(payload: RunUpdatePayload): Promise<void> {
  await invoke('update_run_rating_and_tags', { payload });
}

export async function dbListModels(): Promise<ModelRow[]> {
  return invoke<ModelRow[]>('db_list_models');
}

export async function dbGetModelsLastSync(): Promise<number | null> {
  return invoke<number | null>('db_get_models_last_sync');
}

export async function setWorkspacePath(path: string): Promise<void> {
  await invoke('set_workspace_path', { path });
}

export async function getWorkspacePath(): Promise<string | null> {
  return invoke<string | null>('get_workspace_path');
}

export async function ensureDefaultWorkspace(): Promise<string> {
  return invoke<string>('ensure_default_workspace');
}

export async function pickWorkspaceFolder(): Promise<string | null> {
  return invoke<string | null>('pick_workspace_folder');
}

export async function setToolsEnabled(enabled: boolean): Promise<void> {
  await invoke('set_tools_enabled', { enabled });
}

export async function getToolsEnabled(): Promise<boolean> {
  return invoke<boolean>('get_tools_enabled');
}

export async function setDefaultModel(model: string): Promise<void> {
  await invoke('set_default_model', { model });
}

export async function getDefaultModel(): Promise<string | null> {
  return invoke<string | null>('get_default_model');
}

export async function insertToolCallStart(payload: ToolCallStartPayload): Promise<string> {
  return invoke<string>('insert_tool_call_start', { payload });
}

export async function updateToolCallResult(toolCallId: string, resultJson: string, finishedAt: number): Promise<void> {
  await invoke('update_tool_call_result', { toolCallId, resultJson, finishedAt });
}

export async function updateToolCallError(toolCallId: string, error: string, finishedAt: number): Promise<void> {
  await invoke('update_tool_call_error', { toolCallId, error, finishedAt });
}

export async function listToolCallsForRun(runId: string): Promise<ToolCallRow[]> {
  return invoke<ToolCallRow[]>('list_tool_calls_for_run', { runId });
}

export async function searchRunsDb(args: RunSearchDbArgs): Promise<RunSearchDbRow[]> {
  return invoke<RunSearchDbRow[]>('search_runs_db', { args });
}

export async function writeNoteToWorkspace(payload: WriteNotePayload): Promise<WriteNoteResult> {
  return invoke<WriteNoteResult>('write_note_to_workspace', { payload });
}

export async function campList(): Promise<CampSummary[]> {
  return invoke<CampSummary[]>('camp_list');
}

export async function campDelete(id: string): Promise<void> {
  await invoke('camp_delete', { campId: id });
}

export async function campCreate(payload: CampCreatePayload): Promise<Camp> {
  return invoke<Camp>('camp_create', { payload });
}

export async function campLoad(campId: string): Promise<Camp> {
  return invoke<Camp>('camp_load', { campId });
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let cursor = 0;
  while (cursor < haystack.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) {
      break;
    }

    count += 1;
    cursor = index + Math.max(needle.length, 1);
  }

  return count;
}

function buildTranscriptExcerpt(content: string, normalizedNeedle: string, maxLength = 220): string {
  const normalizedContent = content.replace(/\s+/g, ' ').trim();
  if (normalizedContent.length <= maxLength) {
    return normalizedContent;
  }

  const lowerContent = normalizedContent.toLowerCase();
  const firstMatchIndex = lowerContent.indexOf(normalizedNeedle);
  if (firstMatchIndex === -1) {
    return `${normalizedContent.slice(0, maxLength - 3)}...`;
  }

  const start = Math.max(0, firstMatchIndex - 80);
  const end = Math.min(normalizedContent.length, start + maxLength);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < normalizedContent.length ? '...' : '';
  return `${prefix}${normalizedContent.slice(start, end)}${suffix}`;
}

export async function campSearchTranscript(
  campId: string,
  payload: CampSearchTranscriptPayload,
): Promise<CampTranscriptSearchMatch[]> {
  const normalizedQuery = payload.query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const normalizedLimit = Math.min(Math.max(payload.limit ?? 10, 1), 50);
  const roleFilter = payload.roles && payload.roles.length > 0 ? new Set(payload.roles) : null;

  const camp = await campLoad(campId);
  const matches: CampTranscriptSearchMatch[] = [];

  for (const message of camp.transcript) {
    if (roleFilter && !roleFilter.has(message.role)) {
      continue;
    }

    const matchCount = countOccurrences(message.content.toLowerCase(), normalizedQuery);
    if (matchCount === 0) {
      continue;
    }

    const nextMatch: CampTranscriptSearchMatch = {
      id: message.id,
      role: message.role,
      created_at: message.created_at,
      excerpt: buildTranscriptExcerpt(message.content, normalizedQuery),
      match_count: matchCount,
    };

    if (message.name !== undefined) {
      nextMatch.name = message.name;
    }

    if (message.tool_call_id !== undefined) {
      nextMatch.tool_call_id = message.tool_call_id;
    }

    matches.push(nextMatch);
  }

  matches.sort((left, right) => {
    if (left.match_count !== right.match_count) {
      return right.match_count - left.match_count;
    }

    if (left.created_at !== right.created_at) {
      return right.created_at - left.created_at;
    }

    return left.id.localeCompare(right.id);
  });

  return matches.slice(0, normalizedLimit);
}

export async function campUpdateConfig(payload: CampUpdateConfigPayload): Promise<void> {
  await invoke('camp_update_config', { payload });
}

export async function campUpdateSystemPrompt(payload: CampUpdateSystemPromptPayload): Promise<void> {
  await invoke('camp_update_system_prompt', { payload });
}

export async function campUpdateMemory(payload: CampUpdateMemoryPayload): Promise<void> {
  await invoke('camp_update_memory', { payload });
}

export async function campAppendMessage(payload: CampAppendMessagePayload): Promise<CampMessage> {
  return invoke<CampMessage>('camp_append_message', { payload });
}

export async function campListArtifacts(campId: string): Promise<CampArtifactMetadata[]> {
  return invoke<CampArtifactMetadata[]>('camp_list_artifacts', { campId });
}

export async function campGetArtifact(campId: string, artifactId: string): Promise<CampArtifact> {
  return invoke<CampArtifact>('camp_get_artifact', { campId, artifactId });
}

export async function campCreateArtifactFromMessage(payload: CampCreateArtifactFromMessagePayload): Promise<CampArtifact> {
  return invoke<CampArtifact>('camp_create_artifact_from_message', { payload });
}

export async function campUpdateArtifact(payload: CampUpdateArtifactPayload): Promise<CampArtifact> {
  return invoke<CampArtifact>('camp_update_artifact', { payload });
}

export async function campToggleArtifactArchive(payload: CampToggleArtifactArchivePayload): Promise<CampArtifactMetadata> {
  return invoke<CampArtifactMetadata>('camp_toggle_artifact_archive', { payload });
}

export async function campIncrementArtifactUsage(campId: string, artifactIds: string[]): Promise<void> {
  await invoke('camp_increment_artifact_usage', { campId, artifactIds });
}

export async function campReadContextFile(campId: string, path: string): Promise<string> {
  return invoke<string>('tauri_cmd_read_context_file', { campId, path });
}

export async function campReadContextFileBase64(campId: string, path: string): Promise<string> {
  return invoke<string>('tauri_cmd_read_context_file_base64', { campId, path });
}

export async function workspaceListContextFiles(): Promise<string[]> {
  return invoke<string[]>('workspace_list_context_files');
}

export async function campAttachWorkspaceContextFile(campId: string, path: string): Promise<void> {
  await invoke('camp_attach_workspace_context_file', { campId, path });
}

export async function campDetachWorkspaceContextFile(campId: string, path: string): Promise<void> {
  await invoke('camp_detach_workspace_context_file', { campId, path });
}

export async function campListContextFiles(campId: string, path?: string): Promise<string[]> {
  return invoke<string[]>('tauri_cmd_list_context_files', { campId, path });
}

export async function campWriteContextFile(campId: string, path: string, content: string): Promise<void> {
  await invoke('tauri_cmd_write_context_file', { campId, path, content });
}

// ── Agent Run State ──────────────────────────────────────────────

export async function runStart(campId: string, config: RunStartConfig): Promise<RunStartResult> {
  return invoke<RunStartResult>('run_start', { campId, config });
}

export async function runCancel(campId: string, runId: string): Promise<{ run_id: string; cancelled: boolean }> {
  return invoke('run_cancel', { campId, runId });
}

export async function runGetState(campId: string, runId: string): Promise<RunStateEvent[]> {
  return invoke<RunStateEvent[]>('run_get_state', { campId, runId });
}

export async function runAppendEvent(campId: string, event: RunStateEvent): Promise<void> {
  await invoke('run_append_event', { campId, event });
}

export async function setApprovalPolicy(policy: ApprovalPolicy): Promise<void> {
  await invoke('set_approval_policy', { policy });
}

export async function getApprovalPolicy(): Promise<ApprovalPolicy> {
  return invoke<ApprovalPolicy>('get_approval_policy');
}

export async function setMaxIterations(value: number): Promise<void> {
  await invoke('set_max_iterations', { value });
}

export async function getMaxIterations(): Promise<number> {
  return invoke<number>('get_max_iterations');
}

export async function campWriteContextFileBytes(campId: string, path: string, contentBase64: string): Promise<void> {
  await invoke('tauri_cmd_write_context_file_bytes', { campId, path, contentBase64 });
}
