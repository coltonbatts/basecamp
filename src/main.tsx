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
      if (cmd === 'providers_list' || cmd === 'provider_health_check') return [];
      if (cmd === 'get_default_model') return null;
      if (cmd === 'get_developer_inspect_mode') return false;
      if (cmd === 'ensure_default_workspace') return '/mock/workspace';
      if (cmd === 'workspace_list_context_files') return [];
      if (cmd === 'inspect_stat_camp_file') {
        return {
          path: 'mock.txt',
          exists: false,
          size_bytes: null,
          modified_at_ms: null,
          absolute_path: '/mock/workspace/mock.txt',
        };
      }
      if (cmd === 'camp_load') return {
        config: {
          schema_version: '0.2',
          id: 'test-camp',
          name: 'Test Camp',
          model: 'openrouter/auto',
          provider_kind: 'openrouter',
          model_id: 'auto',
          tools_enabled: true,
          created_at: Date.now(),
          updated_at: Date.now(),
        },
        system_prompt: '',
        memory: {},
        transcript: [],
        context_path: '/mock/workspace/camps/test-camp/context',
      };
      if (cmd === 'camp_list_artifacts') return [];
      if (cmd.startsWith('inspect_') || cmd === 'set_developer_inspect_mode') return null;
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
