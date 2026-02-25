import { useEffect, useMemo, useState } from 'react';

import {
  decomposeTask,
  executeAgentStep,
  getTeamBus,
  getTeamStatus,
  promoteArtifact,
  runReflectionLoop,
} from '../lib/db';
import {
  listenTeamArtifactPromoted,
  listenTeamBusUpdate,
  listenTeamReflectionRound,
  listenTeamStepComplete,
} from '../lib/team';
import type { TeamBusEntry, TeamStatus } from '../lib/types';
import { AgentCard } from './AgentCard';

type TeamArenaProps = {
  campId: string;
};

function toContentPreview(content: unknown): string {
  if (typeof content === 'string') {
    return content.slice(0, 180);
  }

  try {
    const serialized = JSON.stringify(content);
    return serialized.length > 180 ? `${serialized.slice(0, 177)}...` : serialized;
  } catch {
    return 'Unserializable content';
  }
}

function sumTokenUsage(entries: TeamBusEntry[]): Record<string, { input: number; output: number }> {
  const totals: Record<string, { input: number; output: number }> = {};
  for (const entry of entries) {
    if (!totals[entry.from]) {
      totals[entry.from] = { input: 0, output: 0 };
    }
    totals[entry.from].input += entry.token_usage?.input ?? 0;
    totals[entry.from].output += entry.token_usage?.output ?? 0;
  }
  return totals;
}

export function TeamArena({ campId }: TeamArenaProps) {
  const [status, setStatus] = useState<TeamStatus | null>(null);
  const [busEntries, setBusEntries] = useState<TeamBusEntry[]>([]);
  const [task, setTask] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastReflectionRound, setLastReflectionRound] = useState<number | null>(null);

  const loadArenaState = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [nextStatus, nextBus] = await Promise.all([getTeamStatus(campId), getTeamBus(campId)]);
      setStatus(nextStatus);
      setBusEntries(nextBus);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load team arena data.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadArenaState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campId]);

  useEffect(() => {
    let isDisposed = false;

    const setup = async () => {
      const unlisteners = await Promise.all([
        listenTeamBusUpdate((entry) => {
          if (isDisposed) {
            return;
          }
          setBusEntries((previous) => [...previous, entry]);
        }),
        listenTeamStepComplete(() => {
          if (isDisposed) {
            return;
          }
          void loadArenaState();
        }),
        listenTeamArtifactPromoted(() => {
          if (isDisposed) {
            return;
          }
          void loadArenaState();
        }),
        listenTeamReflectionRound((payload) => {
          if (isDisposed) {
            return;
          }
          setLastReflectionRound(payload.round);
        }),
      ]);

      if (isDisposed) {
        for (const unlisten of unlisteners) {
          unlisten();
        }
      }

      return () => {
        for (const unlisten of unlisteners) {
          unlisten();
        }
      };
    };

    let cleanup: (() => void) | null = null;
    void setup().then((release) => {
      cleanup = release ?? null;
    });

    return () => {
      isDisposed = true;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campId]);

  const tokenTotals = useMemo(() => sumTokenUsage(busEntries), [busEntries]);

  const handleRunTask = async () => {
    if (!task.trim()) {
      return;
    }

    setIsRunning(true);
    setError(null);

    try {
      const plan = await decomposeTask(campId, task.trim());

      const completed = new Set<string>();
      const emittedDrafts: string[] = [];

      while (completed.size < plan.steps.length) {
        const readySteps = plan.steps.filter(
          (step) => !completed.has(step.step_id) && step.depends_on.every((dependency) => completed.has(dependency)),
        );

        if (readySteps.length === 0) {
          throw new Error('No executable steps found. Check decomposition dependencies.');
        }

        for (const step of readySteps) {
          const result = await executeAgentStep(campId, step.assigned_to, step);
          completed.add(step.step_id);
          emittedDrafts.push(result.draft_path);
        }
      }

      if (plan.reflection_required && status?.reflection_loops) {
        const rounds = status.max_reflection_rounds > 0 ? status.max_reflection_rounds : 2;
        for (const draftPath of emittedDrafts) {
          await runReflectionLoop(campId, draftPath, rounds);
        }
      }

      await loadArenaState();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Team execution failed.');
    } finally {
      setIsRunning(false);
    }
  };

  const handlePromoteDraft = async (draftPath: string) => {
    try {
      await promoteArtifact(campId, draftPath);
      await loadArenaState();
    } catch (promoteError) {
      setError(promoteError instanceof Error ? promoteError.message : 'Unable to promote artifact.');
    }
  };

  const critiqueEntries = useMemo(
    () => busEntries.filter((entry) => entry.type === 'critique').slice(-4).reverse(),
    [busEntries],
  );

  return (
    <section className="team-arena-shell">
      <header className="team-arena-header">
        <h3>Team Arena</h3>
        <button type="button" onClick={() => void loadArenaState()} disabled={isLoading || isRunning}>
          Refresh
        </button>
      </header>

      <label>
        Team task
        <textarea
          value={task}
          onChange={(event) => setTask(event.target.value)}
          placeholder="Describe the work for the supervisor to decompose"
          disabled={isRunning}
        />
      </label>
      <button type="button" onClick={() => void handleRunTask()} disabled={isRunning || !task.trim()}>
        {isRunning ? 'Running Team...' : 'Run Team'}
      </button>

      {lastReflectionRound !== null && (
        <p className="hint">Latest reflection round: {lastReflectionRound}</p>
      )}
      {error && <p className="error-line">{error}</p>}

      <div className="team-arena-grid">
        <div className="team-timeline-panel">
          <h4>Timeline</h4>
          <div className="team-timeline-list">
            {busEntries.slice().reverse().map((entry) => (
              <article key={entry.id} className={`team-bus-card type-${entry.type}`}>
                <header>
                  <strong>{entry.type}</strong>
                  <span>{entry.from} → {entry.to}</span>
                </header>
                {entry.step_id && <p>step: {entry.step_id}</p>}
                <p>{toContentPreview(entry.content)}</p>
              </article>
            ))}
            {busEntries.length === 0 && <p className="hint">No team bus entries yet.</p>}
          </div>
        </div>

        <aside className="team-side-panel">
          <h4>Agents</h4>
          <div className="team-agent-list compact">
            {(status?.agents ?? []).map((agent) => (
              <AgentCard
                key={agent.id}
                agent={{
                  ...agent,
                  token_usage: tokenTotals[agent.id] ?? agent.token_usage,
                }}
              />
            ))}
            {!status?.agents.length && <p className="hint">No agents configured.</p>}
          </div>

          <h4>Step Status</h4>
          <ul className="team-step-list">
            {(status?.steps ?? []).map((step) => (
              <li key={step.step_id} className={`team-step status-${step.status}`}>
                <strong>{step.step_id}</strong>
                <span>{step.assigned_to}</span>
                <span>{step.status}</span>
              </li>
            ))}
            {!status?.steps.length && <li className="hint">No active decomposition plan.</li>}
          </ul>

          <h4>Artifacts</h4>
          <div className="team-artifacts">
            <div>
              <h5>Drafts</h5>
              <ul>
                {(status?.artifacts.drafts ?? []).map((draft) => (
                  <li key={draft}>
                    <span>{draft}</span>
                    <button type="button" onClick={() => void handlePromoteDraft(draft)}>
                      Promote
                    </button>
                  </li>
                ))}
                {(status?.artifacts.drafts ?? []).length === 0 && <li className="hint">No drafts.</li>}
              </ul>
            </div>
            <div>
              <h5>Promoted</h5>
              <ul>
                {(status?.artifacts.promoted ?? []).map((artifact) => (
                  <li key={artifact}>{artifact}</li>
                ))}
                {(status?.artifacts.promoted ?? []).length === 0 && <li className="hint">No promoted artifacts.</li>}
              </ul>
            </div>
          </div>

          <h4>Reflection Notes</h4>
          <div className="team-reflection-list">
            {critiqueEntries.map((entry) => (
              <article key={entry.id} className="team-bus-card type-critique">
                <p>{toContentPreview(entry.content)}</p>
              </article>
            ))}
            {critiqueEntries.length === 0 && <p className="hint">No critique rounds yet.</p>}
          </div>
        </aside>
      </div>
    </section>
  );
}
