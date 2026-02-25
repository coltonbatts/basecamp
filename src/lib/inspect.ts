import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export const INSPECT_EVENT_CHANNEL = 'basecamp://inspect-event';

export type InspectEventType =
  | 'compose_start'
  | 'compose_end'
  | 'http_request_start'
  | 'http_request_end'
  | 'stream_chunk'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'persist_start'
  | 'persist_end'
  | 'error'
  | string;

export type InspectEventRecord = {
  timestamp_ms: number;
  correlation_id: string;
  event_type: InspectEventType;
  duration_ms?: number | null;
  summary: string;
  payload?: unknown;
};

export type InspectEmitEventPayload = {
  camp_id: string;
  correlation_id: string;
  event_type: InspectEventType;
  timestamp_ms?: number;
  duration_ms?: number;
  summary: string;
  payload?: unknown;
};

export type InspectWriteTurnPayload = {
  camp_id: string;
  correlation_id: string;
  payload: unknown;
};

export type InspectCampFileMeta = {
  path: string;
  exists: boolean;
  size_bytes: number | null;
  modified_at_ms: number | null;
  absolute_path: string;
};

export async function setDeveloperInspectMode(enabled: boolean): Promise<void> {
  await invoke('set_developer_inspect_mode', { enabled });
}

export async function getDeveloperInspectMode(): Promise<boolean> {
  return invoke<boolean>('get_developer_inspect_mode');
}

export async function inspectEmitEvent(payload: InspectEmitEventPayload): Promise<void> {
  await invoke('inspect_emit_event', { payload });
}

export async function inspectWriteTurnRequest(payload: InspectWriteTurnPayload): Promise<string> {
  return invoke<string>('inspect_write_turn_request', { payload });
}

export async function inspectWriteTurnResponse(payload: InspectWriteTurnPayload): Promise<string> {
  return invoke<string>('inspect_write_turn_response', { payload });
}

export async function inspectWriteTurnBundle(payload: InspectWriteTurnPayload): Promise<string> {
  return invoke<string>('inspect_write_turn_bundle', { payload });
}

export async function inspectReadTurnBundle(campId: string, correlationId: string): Promise<unknown> {
  return invoke<unknown>('inspect_read_turn_bundle', {
    campId,
    correlationId,
  });
}

export async function inspectStatCampFile(campId: string, relativePath: string): Promise<InspectCampFileMeta> {
  return invoke<InspectCampFileMeta>('inspect_stat_camp_file', {
    payload: {
      camp_id: campId,
      relative_path: relativePath,
    },
  });
}

export async function listenInspectEvents(
  callback: (event: InspectEventRecord) => void,
): Promise<UnlistenFn> {
  return listen<InspectEventRecord>(INSPECT_EVENT_CHANNEL, (event) => {
    callback(event.payload);
  });
}
