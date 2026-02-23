import { invoke } from '@tauri-apps/api/core';

import type {
  Camp,
  CampArtifact,
  CampArtifactMetadata,
  CampAppendMessagePayload,
  CampCreateArtifactFromMessagePayload,
  CampCreatePayload,
  CampMessage,
  CampSummary,
  CampToggleArtifactArchivePayload,
  CampUpdateConfigPayload,
  CampUpdateArtifactPayload,
  CampUpdateMemoryPayload,
  CampUpdateSystemPromptPayload,
  ModelRow,
  ModelRowPayload,
  Run,
  RunInsertPayload,
  RunSearchDbArgs,
  RunSearchDbRow,
  RunUpdatePayload,
  ToolCallRow,
  ToolCallStartPayload,
  WriteNotePayload,
  WriteNoteResult,
} from './types';

export async function saveApiKey(apiKey: string): Promise<void> {
  await invoke('save_api_key', { apiKey });
}

export async function getApiKey(): Promise<string | null> {
  return invoke<string | null>('get_api_key');
}

export async function hasApiKey(): Promise<boolean> {
  return invoke<boolean>('has_api_key');
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

export async function dbUpsertModels(models: ModelRowPayload[]): Promise<void> {
  await invoke('db_upsert_models', { models });
}

export async function dbListModels(): Promise<ModelRow[]> {
  return invoke<ModelRow[]>('db_list_models');
}

export async function dbGetModelsLastSync(): Promise<number | null> {
  return invoke<number | null>('db_get_models_last_sync');
}

export async function dbSetModelsLastSync(tsMs: number): Promise<void> {
  await invoke('db_set_models_last_sync', { tsMs });
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

export async function campCreate(payload: CampCreatePayload): Promise<Camp> {
  return invoke<Camp>('camp_create', { payload });
}

export async function campLoad(campId: string): Promise<Camp> {
  return invoke<Camp>('camp_load', { campId });
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
