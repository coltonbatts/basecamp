import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';

import { createTeamAgent, getTeamStatus, removeTeamAgent, updateTeamSettings } from '../lib/db';
import type { TeamAgentCreateInput, TeamStatus } from '../lib/types';
import { AgentCard } from './AgentCard';

type TeamConfigProps = {
  campId: string;
  modelOptions: string[];
};

const DEFAULT_TOOLS = 'read_file,list_files,write_file';

function parseTools(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function TeamConfig({ campId, modelOptions }: TeamConfigProps) {
  const [status, setStatus] = useState<TeamStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [supervisorModel, setSupervisorModel] = useState('');
  const [reflectionLoops, setReflectionLoops] = useState(true);
  const [maxRounds, setMaxRounds] = useState(2);

  const [agentId, setAgentId] = useState('researcher');
  const [agentRole, setAgentRole] = useState('Researcher');
  const [agentModel, setAgentModel] = useState(modelOptions[0] ?? 'openrouter/auto');
  const [agentTools, setAgentTools] = useState(DEFAULT_TOOLS);
  const [agentDescription, setAgentDescription] = useState('');

  const sortedModels = useMemo(() => {
    const values = modelOptions.filter((value) => value.trim().length > 0);
    if (values.length === 0) {
      return ['openrouter/auto'];
    }
    return values;
  }, [modelOptions]);

  const loadStatus = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await getTeamStatus(campId);
      setStatus(next);
      setSupervisorModel(next.supervisor_model || sortedModels[0] || 'openrouter/auto');
      setReflectionLoops(next.reflection_loops);
      setMaxRounds(next.max_reflection_rounds);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load team settings.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campId]);

  useEffect(() => {
    if (!sortedModels.includes(agentModel)) {
      setAgentModel(sortedModels[0]);
    }
  }, [agentModel, sortedModels]);

  const handleSaveTeamSettings = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const next = await updateTeamSettings(campId, {
        supervisor_model: supervisorModel,
        reflection_loops: reflectionLoops,
        max_reflection_rounds: maxRounds,
      });
      setStatus(next);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to update team settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleAddAgent = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload: TeamAgentCreateInput = {
        id: agentId,
        role: agentRole,
        model: agentModel,
        tool_subset: parseTools(agentTools),
        description: agentDescription,
      };
      await createTeamAgent(campId, payload);
      await loadStatus();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create team agent.');
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveAgent = async (id: string) => {
    setSaving(true);
    setError(null);
    try {
      await removeTeamAgent(campId, id);
      await loadStatus();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Unable to remove team agent.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="team-config-panel">
      <header>
        <h3>Team Setup</h3>
        <button type="button" onClick={() => void loadStatus()} disabled={isLoading || saving}>
          Refresh
        </button>
      </header>

      {error && <p className="error-line">{error}</p>}
      {isLoading && <p className="hint">Loading team config…</p>}

      <form className="team-settings-form" onSubmit={handleSaveTeamSettings}>
        <label>
          Supervisor model
          <select value={supervisorModel} onChange={(event) => setSupervisorModel(event.target.value)}>
            {sortedModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={reflectionLoops}
            onChange={(event) => setReflectionLoops(event.target.checked)}
          />
          Reflection loops
        </label>

        <label>
          Max reflection rounds
          <input
            type="number"
            min={1}
            max={8}
            value={maxRounds}
            onChange={(event) => setMaxRounds(Number(event.target.value))}
          />
        </label>

        <button type="submit" disabled={saving}>
          Save Team Settings
        </button>
      </form>

      <div className="team-agent-list">
        {(status?.agents ?? []).map((agent) => (
          <AgentCard key={agent.id} agent={agent} onRemove={handleRemoveAgent} />
        ))}
      </div>

      <form className="team-agent-create" onSubmit={handleAddAgent}>
        <h4>Add Agent</h4>
        <label>
          Agent id
          <input value={agentId} onChange={(event) => setAgentId(event.target.value)} placeholder="researcher" />
        </label>
        <label>
          Role
          <input value={agentRole} onChange={(event) => setAgentRole(event.target.value)} placeholder="Researcher" />
        </label>
        <label>
          Model
          <select value={agentModel} onChange={(event) => setAgentModel(event.target.value)}>
            {sortedModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tool subset (comma-separated)
          <input
            value={agentTools}
            onChange={(event) => setAgentTools(event.target.value)}
            placeholder="read_file,list_files,write_file"
          />
        </label>
        <label>
          Description
          <input
            value={agentDescription}
            onChange={(event) => setAgentDescription(event.target.value)}
            placeholder="Gathers information and writes findings"
          />
        </label>
        <button type="submit" disabled={saving}>
          Add / Update Agent
        </button>
      </form>
    </section>
  );
}
