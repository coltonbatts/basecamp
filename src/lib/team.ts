import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { AgentStepResult, TeamBusEntry } from './types';

export const TEAM_STEP_COMPLETE_EVENT = 'team://step_complete';
export const TEAM_BUS_UPDATE_EVENT = 'team://bus_update';
export const TEAM_ARTIFACT_PROMOTED_EVENT = 'team://artifact_promoted';
export const TEAM_REFLECTION_ROUND_EVENT = 'team://reflection_round';

export async function listenTeamStepComplete(
  callback: (payload: AgentStepResult) => void,
): Promise<UnlistenFn> {
  return listen<AgentStepResult>(TEAM_STEP_COMPLETE_EVENT, (event) => {
    callback(event.payload);
  });
}

export async function listenTeamBusUpdate(
  callback: (payload: TeamBusEntry) => void,
): Promise<UnlistenFn> {
  return listen<TeamBusEntry>(TEAM_BUS_UPDATE_EVENT, (event) => {
    callback(event.payload);
  });
}

export async function listenTeamArtifactPromoted(
  callback: (payload: { from: string; to: string; pass?: boolean; rounds_completed?: number }) => void,
): Promise<UnlistenFn> {
  return listen(TEAM_ARTIFACT_PROMOTED_EVENT, (event) => {
    callback(event.payload as { from: string; to: string; pass?: boolean; rounds_completed?: number });
  });
}

export async function listenTeamReflectionRound(
  callback: (payload: { round: number; artifact_path: string; critique: unknown }) => void,
): Promise<UnlistenFn> {
  return listen(TEAM_REFLECTION_ROUND_EVENT, (event) => {
    callback(event.payload as { round: number; artifact_path: string; critique: unknown });
  });
}
