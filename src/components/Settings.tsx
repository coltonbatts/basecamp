import { useEffect, useState, type FormEvent } from 'react';

import {
  getApprovalPolicy,
  getMaxIterations,
  providerHealthCheck,
  providerRefreshModels,
  providersList,
  providerUpdate,
  getToolsEnabled,
  getWorkspacePath,
  hasApiKey,
  pickWorkspaceFolder,
  saveApiKey,
  setApprovalPolicy as persistApprovalPolicy,
  setMaxIterations as persistMaxIterations,
  setToolsEnabled as persistToolsEnabled,
  setWorkspacePath,
} from '../lib/db';
import type { ApprovalPolicy, ProviderKind, ProviderRegistryRow } from '../lib/types';
import {
  getDeveloperInspectMode,
  setDeveloperInspectMode as persistDeveloperInspectMode,
} from '../lib/inspect';
import { fetchOpenRouterKeyInfo, type OpenRouterKeyInfo } from '../lib/openrouter';
import { syncModelsToDb } from '../lib/models';

type SettingsProps = {
  cachedModelCount: number;
  modelsLastSync: number | null;
  onModelsSynced: () => Promise<void>;
};

function formatLastSync(lastSync: number | null): string {
  if (!lastSync) {
    return 'never';
  }

  return new Date(lastSync).toLocaleString();
}

function providerTitle(kind: ProviderKind): string {
  if (kind === 'openrouter') return 'OpenRouter';
  if (kind === 'lmstudio') return 'LM Studio';
  if (kind === 'ollama') return 'Ollama';
  return 'llama.cpp';
}

function providerInstructionsUrl(kind: ProviderKind): string | null {
  if (kind === 'lmstudio') return 'https://lmstudio.ai/docs/app/api/endpoints/openai';
  if (kind === 'ollama') return 'https://ollama.com/download';
  if (kind === 'llama_cpp') return 'https://github.com/ggerganov/llama.cpp/tree/master/examples/server';
  return null;
}

function providerHealthLabel(provider: ProviderRegistryRow): string {
  if (provider.last_error) {
    return 'Down';
  }
  if (provider.last_ok_at) {
    return 'Healthy';
  }
  return 'Unknown';
}

export function Settings({ cachedModelCount, modelsLastSync, onModelsSynced }: SettingsProps) {
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [savingToolsEnabled, setSavingToolsEnabled] = useState(false);
  const [savingDeveloperInspect, setSavingDeveloperInspect] = useState(false);
  const [providers, setProviders] = useState<ProviderRegistryRow[]>([]);
  const [providerDrafts, setProviderDrafts] = useState<Record<string, { enabled: boolean; base_url: string }>>({});
  const [savingProviderKind, setSavingProviderKind] = useState<ProviderKind | null>(null);
  const [checkingProviders, setCheckingProviders] = useState(false);
  const [refreshingProviderModels, setRefreshingProviderModels] = useState(false);
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [workspacePath, setWorkspacePathState] = useState<string | null>(null);
  const [toolsEnabled, setToolsEnabledState] = useState(true);
  const [developerInspectMode, setDeveloperInspectModeState] = useState(false);
  const [approvalPolicy, setApprovalPolicyState] = useState<ApprovalPolicy>('manual');
  const [savingApprovalPolicy, setSavingApprovalPolicy] = useState(false);
  const [maxIterations, setMaxIterationsState] = useState(10);
  const [savingMaxIterations, setSavingMaxIterations] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [keyInfo, setKeyInfo] = useState<OpenRouterKeyInfo["data"] | null>(null);
  const [fetchingKeyInfo, setFetchingKeyInfo] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);

      try {
        const [exists, currentWorkspacePath, currentToolsEnabled, currentDeveloperInspectMode, currentApprovalPolicy, currentMaxIterations, providerRows] = await Promise.all([
          hasApiKey(),
          getWorkspacePath(),
          getToolsEnabled(),
          getDeveloperInspectMode(),
          getApprovalPolicy(),
          getMaxIterations(),
          providersList(),
        ]);

        setHasSavedKey(exists);
        setWorkspacePathState(currentWorkspacePath);
        setToolsEnabledState(currentToolsEnabled);
        setDeveloperInspectModeState(currentDeveloperInspectMode);
        setApprovalPolicyState(currentApprovalPolicy as ApprovalPolicy);
        setMaxIterationsState(currentMaxIterations);
        setProviders(providerRows);
        setProviderDrafts(
          Object.fromEntries(
            providerRows.map((provider) => [
              provider.provider_kind,
              {
                enabled: provider.enabled,
                base_url: provider.base_url,
              },
            ]),
          ),
        );
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load settings state.');
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, []);

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!apiKey.trim()) {
      setError('API key cannot be empty.');
      return;
    }

    setSaving(true);
    setError(null);
    setStatus(null);

    try {
      await saveApiKey(apiKey.trim());
      setApiKey('');
      setHasSavedKey(true);
      setStatus('OpenRouter API key saved securely.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save API key.');
    } finally {
      setSaving(false);
    }
  };

  const handleSyncModels = async () => {
    setSyncing(true);
    setError(null);
    setStatus(null);

    try {
      const result = await syncModelsToDb();
      await onModelsSynced();
      setStatus(`Refreshed ${result.count} models from enabled providers.`);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Unable to sync models.');
    } finally {
      setSyncing(false);
    }
  };

  const handleProviderDraftChange = (
    kind: ProviderKind,
    next: Partial<{ enabled: boolean; base_url: string }>,
  ) => {
    setProviderDrafts((previous) => {
      const current = previous[kind] ?? { enabled: false, base_url: '' };
      return {
        ...previous,
        [kind]: {
          ...current,
          ...next,
        },
      };
    });
  };

  const handleSaveProvider = async (kind: ProviderKind) => {
    const draft = providerDrafts[kind];
    if (!draft) {
      return;
    }
    setSavingProviderKind(kind);
    setError(null);
    setStatus(null);
    try {
      await providerUpdate({
        provider_kind: kind,
        enabled: draft.enabled,
        base_url: draft.base_url,
      });
      const latest = await providersList();
      setProviders(latest);
      setStatus(`${providerTitle(kind)} settings saved.`);
    } catch (providerError) {
      setError(providerError instanceof Error ? providerError.message : 'Unable to save provider settings.');
    } finally {
      setSavingProviderKind(null);
    }
  };

  const handleCheckProviders = async () => {
    setCheckingProviders(true);
    setError(null);
    setStatus(null);
    try {
      const checked = await providerHealthCheck();
      setProviders(checked);
      setStatus('Provider health check complete.');
    } catch (providerError) {
      setError(providerError instanceof Error ? providerError.message : 'Unable to run provider health check.');
    } finally {
      setCheckingProviders(false);
    }
  };

  const handleRefreshProviderModels = async () => {
    setRefreshingProviderModels(true);
    setError(null);
    setStatus(null);
    try {
      const refreshed = await providerRefreshModels();
      await onModelsSynced();
      setStatus(`Refreshed ${refreshed.total_count} cached models from providers.`);
    } catch (providerError) {
      setError(providerError instanceof Error ? providerError.message : 'Unable to refresh provider models.');
    } finally {
      setRefreshingProviderModels(false);
    }
  };

  const handlePickWorkspaceFolder = async () => {
    setSavingWorkspace(true);
    setError(null);
    setStatus(null);

    try {
      const selectedFolder = await pickWorkspaceFolder();
      if (!selectedFolder) {
        setStatus('Workspace folder selection cancelled.');
        return;
      }

      await setWorkspacePath(selectedFolder);
      setWorkspacePathState(selectedFolder);
      setStatus('Workspace folder saved.');
    } catch (workspaceError) {
      setError(workspaceError instanceof Error ? workspaceError.message : 'Unable to set workspace folder.');
    } finally {
      setSavingWorkspace(false);
    }
  };

  const handleCheckUsage = async () => {
    setFetchingKeyInfo(true);
    setError(null);
    setStatus(null);
    setKeyInfo(null);

    try {
      const info = await fetchOpenRouterKeyInfo();
      setKeyInfo(info);
      setStatus('Key info retrieved successfully.');
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Unable to fetch key info.');
    } finally {
      setFetchingKeyInfo(false);
    }
  };

  const handleToolsToggle = async (enabled: boolean) => {
    setSavingToolsEnabled(true);
    setError(null);
    setStatus(null);

    const previous = toolsEnabled;
    setToolsEnabledState(enabled);

    try {
      await persistToolsEnabled(enabled);
      setStatus(`Tools ${enabled ? 'enabled' : 'disabled'}.`);
    } catch (toggleError) {
      setToolsEnabledState(previous);
      setError(toggleError instanceof Error ? toggleError.message : 'Unable to update tools setting.');
    } finally {
      setSavingToolsEnabled(false);
    }
  };

  const handleApprovalPolicyChange = async (policy: ApprovalPolicy) => {
    setSavingApprovalPolicy(true);
    setError(null);
    setStatus(null);

    const previous = approvalPolicy;
    setApprovalPolicyState(policy);

    try {
      await persistApprovalPolicy(policy);
      setStatus(`Approval policy set to ${policy}.`);
    } catch (policyError) {
      setApprovalPolicyState(previous);
      setError(policyError instanceof Error ? policyError.message : 'Unable to update approval policy.');
    } finally {
      setSavingApprovalPolicy(false);
    }
  };

  const handleMaxIterationsChange = async (value: number) => {
    setSavingMaxIterations(true);
    setError(null);
    setStatus(null);

    const previous = maxIterations;
    const clamped = Math.min(Math.max(value, 1), 50);
    setMaxIterationsState(clamped);

    try {
      await persistMaxIterations(clamped);
      setStatus(`Max iterations set to ${clamped}.`);
    } catch (iterError) {
      setMaxIterationsState(previous);
      setError(iterError instanceof Error ? iterError.message : 'Unable to update max iterations.');
    } finally {
      setSavingMaxIterations(false);
    }
  };

  const handleDeveloperInspectToggle = async (enabled: boolean) => {
    setSavingDeveloperInspect(true);
    setError(null);
    setStatus(null);

    const previous = developerInspectMode;
    setDeveloperInspectModeState(enabled);

    try {
      await persistDeveloperInspectMode(enabled);
      setStatus(`Developer inspect mode ${enabled ? 'enabled' : 'disabled'}.`);
    } catch (toggleError) {
      setDeveloperInspectModeState(previous);
      setError(toggleError instanceof Error ? toggleError.message : 'Unable to update developer inspect mode.');
    } finally {
      setSavingDeveloperInspect(false);
    }
  };

  return (
    <section className="panel settings-panel">
      <h2>Settings</h2>

      {loading && <p className="inline-status">Loading settings...</p>}
      {!loading && (
        <>
          <p className="settings-note">API key is stored in your operating system secure credential store.</p>
          <p className="settings-note">Saved key status: {hasSavedKey ? 'Configured' : 'Not configured'}</p>

          <form onSubmit={handleSave} className="settings-form">
            <label className="field">
              <span>OpenRouter API Key</span>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                autoComplete="off"
                placeholder="OpenRouter API key"
              />
            </label>

            <div className="button-row">
              <button type="submit" disabled={saving}>
                {saving ? 'Saving...' : 'Save Key'}
              </button>
              <button type="button" className="secondary" onClick={() => void handleSyncModels()} disabled={syncing}>
                {syncing ? 'Syncing...' : 'Sync Models'}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void handleCheckUsage()}
                disabled={fetchingKeyInfo}
              >
                {fetchingKeyInfo ? 'Checking...' : 'Check Credits'}
              </button>
            </div>
          </form>

          {keyInfo && (
            <div className="settings-subsection usage-stats">
              <h3>OpenRouter Key Info</h3>
              <p className="settings-note">
                <strong>Usage:</strong> ${keyInfo.usage.toFixed(4)}
              </p>
              <p className="settings-note">
                <strong>Limit:</strong> {keyInfo.limit !== null ? `$${keyInfo.limit.toFixed(4)}` : 'None'}
              </p>
              {keyInfo.limit_remaining !== null && (
                <p className="settings-note">
                  <strong>Remaining:</strong> ${keyInfo.limit_remaining.toFixed(4)}
                </p>
              )}
              <p className="settings-note">
                <strong>Tier:</strong> {keyInfo.is_free_tier ? 'Free' : 'Paid'}
              </p>
              <p className="settings-note">
                <strong>Rate Limit:</strong> {keyInfo.rate_limit.requests} req / {keyInfo.rate_limit.interval}
              </p>
            </div>
          )}

          <div className="settings-subsection">
            <h3>Providers</h3>
            <div className="button-row">
              <button type="button" className="secondary" onClick={() => void handleCheckProviders()} disabled={checkingProviders}>
                {checkingProviders ? 'Checking...' : 'Health Check'}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void handleRefreshProviderModels()}
                disabled={refreshingProviderModels}
              >
                {refreshingProviderModels ? 'Refreshing...' : 'Refresh Models'}
              </button>
            </div>
            {providers.map((provider) => {
              const kind = provider.provider_kind;
              const draft = providerDrafts[kind] ?? {
                enabled: provider.enabled,
                base_url: provider.base_url,
              };
              const instructionsUrl = providerInstructionsUrl(kind);
              return (
                <div key={kind} className="settings-subsection" style={{ border: '1px solid var(--line)', borderRadius: '8px', padding: '12px' }}>
                  <p className="settings-note">
                    <strong>{providerTitle(kind)}</strong> · {providerHealthLabel(provider)}
                    {provider.last_ok_at ? ` · Last OK ${new Date(provider.last_ok_at).toLocaleString()}` : ''}
                  </p>
                  {provider.last_error ? <p className="inline-warning">{provider.last_error}</p> : null}
                  <label className="settings-toggle">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) => handleProviderDraftChange(kind, { enabled: event.target.checked })}
                    />
                    <span>Enabled</span>
                  </label>
                  <label className="field">
                    <span>Base URL</span>
                    <input
                      type="text"
                      value={draft.base_url}
                      onChange={(event) => handleProviderDraftChange(kind, { base_url: event.target.value })}
                    />
                  </label>
                  <div className="button-row">
                    <button
                      type="button"
                      onClick={() => void handleSaveProvider(kind)}
                      disabled={savingProviderKind === kind}
                    >
                      {savingProviderKind === kind ? 'Saving...' : 'Save Provider'}
                    </button>
                    {instructionsUrl ? (
                      <a href={instructionsUrl} target="_blank" rel="noreferrer" className="secondary" style={{ alignSelf: 'center' }}>
                        Open instructions
                      </a>
                    ) : null}
                  </div>
                </div>
              );
            })}
            <p className="settings-note">Cached models: {cachedModelCount}</p>
            <p className="settings-note">Last model sync: {formatLastSync(modelsLastSync)}</p>
          </div>

          <hr className="settings-divider" />

          <div className="settings-subsection">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={toolsEnabled}
                disabled={savingToolsEnabled}
                onChange={(event) => {
                  void handleToolsToggle(event.target.checked);
                }}
              />
              <span>Tools enabled</span>
            </label>
            <p className="settings-note">When disabled, Basecamp runs standard chat completions without tool calls.</p>
          </div>

          <div className="settings-subsection">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={developerInspectMode}
                disabled={savingDeveloperInspect}
                onChange={(event) => {
                  void handleDeveloperInspectToggle(event.target.checked);
                }}
              />
              <span>Developer Mode (Inspect)</span>
            </label>
            <p className="settings-note">
              Writes local debug logs to each camp at <code>.camp/debug/</code> and enables the chat Inspect panel.
            </p>
          </div>

          <div className="settings-subsection">
            <p className="settings-note">Workspace folder: {workspacePath ?? 'None selected'}</p>
            <button type="button" onClick={() => void handlePickWorkspaceFolder()} disabled={savingWorkspace}>
              {savingWorkspace ? 'Picking...' : 'Pick Workspace Folder'}
            </button>
          </div>

          <hr className="settings-divider" />

          <div className="settings-subsection">
            <label className="field">
              <span>Approval Policy</span>
              <select
                value={approvalPolicy}
                disabled={savingApprovalPolicy}
                onChange={(event) => {
                  void handleApprovalPolicyChange(event.target.value as ApprovalPolicy);
                }}
              >
                <option value="manual">Manual — approve every tool call</option>
                <option value="auto-safe">Auto-safe — auto-approve read-only tools</option>
                <option value="full-auto">Full-auto — auto-approve all tools</option>
              </select>
            </label>
            <p className="settings-note">Controls whether agent tool calls require manual approval before execution.</p>
          </div>

          <div className="settings-subsection">
            <label className="field">
              <span>Max Iterations per Run</span>
              <input
                type="number"
                min={1}
                max={50}
                value={maxIterations}
                disabled={savingMaxIterations}
                onChange={(event) => {
                  const parsed = parseInt(event.target.value, 10);
                  if (!Number.isNaN(parsed)) {
                    void handleMaxIterationsChange(parsed);
                  }
                }}
              />
            </label>
            <p className="settings-note">Maximum tool-use loop iterations per agent run (1–50, default 10).</p>
          </div>
        </>
      )}

      {error && <p className="inline-error">{error}</p>}
      {status && <p className="inline-status">{status}</p>}
    </section>
  );
}
