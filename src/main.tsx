import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';

import App from './App';
import './index.css';

// @ts-expect-error - Mocking Tauri for web debugging
if (!window.__TAURI__) {
  // @ts-expect-error
  window.__TAURI__ = {
    invoke: async (cmd: string, args: any) => {
      console.log(`Mock invoked: ${cmd}`, args);
      if (cmd === 'camp_list') return [];
      if (cmd === 'db_list_models') return [];
      if (cmd === 'get_default_model') return null;
      if (cmd === 'ensure_default_workspace') return '/mock/workspace';
      if (cmd === 'workspace_list_context_files') return [];
      if (cmd === 'camp_load') return {
        id: 'test-camp',
        name: 'Test Camp',
        model: 'openrouter/auto',
        tools_enabled: false,
        created_at: Date.now(),
        updated_at: Date.now(),
        transcript: [],
      };
      if (cmd === 'camp_list_artifacts') return [];
      return null;
    }
  };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
