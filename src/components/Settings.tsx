import { useEffect, useState, type FormEvent } from 'react';

import {
  getApiKey,
  getToolsEnabled,
  getWorkspacePath,
  hasApiKey,
  pickWorkspaceFolder,
  saveApiKey,
  setToolsEnabled as persistToolsEnabled,
  setWorkspacePath,
} from '../lib/db';
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

export function Settings({ cachedModelCount, modelsLastSync, onModelsSynced }: SettingsProps) {
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [savingToolsEnabled, setSavingToolsEnabled] = useState(false);
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [workspacePath, setWorkspacePathState] = useState<string | null>(null);
  const [toolsEnabled, setToolsEnabledState] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);

      try {
        const [exists, currentWorkspacePath, currentToolsEnabled] = await Promise.all([
          hasApiKey(),
          getWorkspacePath(),
          getToolsEnabled(),
        ]);

        setHasSavedKey(exists);
        setWorkspacePathState(currentWorkspacePath);
        setToolsEnabledState(currentToolsEnabled);
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
      const apiKeyFromStore = await getApiKey();
      if (!apiKeyFromStore) {
        throw new Error('OpenRouter API key is missing. Save it before syncing models.');
      }

      const result = await syncModelsToDb(apiKeyFromStore);
      await onModelsSynced();
      setStatus(`Synced ${result.count} models from OpenRouter.`);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Unable to sync models.');
    } finally {
      setSyncing(false);
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
                placeholder="sk-or-v1-..."
              />
            </label>

            <div className="button-row">
              <button type="submit" disabled={saving}>
                {saving ? 'Saving...' : 'Save Key'}
              </button>
              <button type="button" className="secondary" onClick={() => void handleSyncModels()} disabled={syncing}>
                {syncing ? 'Syncing...' : 'Sync Models'}
              </button>
            </div>
          </form>

          <p className="settings-note">Cached models: {cachedModelCount}</p>
          <p className="settings-note">Last model sync: {formatLastSync(modelsLastSync)}</p>

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
            <p className="settings-note">Workspace folder: {workspacePath ?? 'None selected'}</p>
            <button type="button" onClick={() => void handlePickWorkspaceFolder()} disabled={savingWorkspace}>
              {savingWorkspace ? 'Picking...' : 'Pick Workspace Folder'}
            </button>
          </div>

          <p className="settings-note">
            Agent Mode v0 (Soul): tool calls are logged, writes are sandboxed to your workspace folder, and each run is
            capped at 5 tool steps.
          </p>
        </>
      )}

      {error && <p className="inline-error">{error}</p>}
      {status && <p className="inline-status">{status}</p>}
    </section>
  );
}
