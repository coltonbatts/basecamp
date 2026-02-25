import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Settings } from '../components/Settings';
import { dbGetModelsLastSync, dbListModels } from '../lib/db';

export function SettingsView() {
  const navigate = useNavigate();
  const [cachedModelCount, setCachedModelCount] = useState(0);
  const [modelsLastSync, setModelsLastSync] = useState<number | null>(null);

  const loadData = async () => {
    try {
      const [models, lastSync] = await Promise.all([dbListModels(), dbGetModelsLastSync()]);
      setCachedModelCount(models.length);
      setModelsLastSync(lastSync);
    } catch (err) {
      console.error('Failed to load settings data', err);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  return (
    <div className="home-dashboard">
      <header className="home-dashboard-header">
        <div>
          <h1>Settings</h1>
          <p>Configure Basecamp workspace and keys.</p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button type="button" onClick={() => navigate('/home')}>
            Home
          </button>
        </div>
      </header>

      <Settings cachedModelCount={cachedModelCount} modelsLastSync={modelsLastSync} onModelsSynced={loadData} />
    </div>
  );
}
