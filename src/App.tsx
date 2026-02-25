import { Navigate, Route, Routes } from 'react-router-dom';

import { HomeView } from './views/HomeView';
import { MainLayout } from './views/MainLayout';
import { ArenaView } from './views/ArenaView';
import { SettingsView } from './views/SettingsView';
import { ErrorBoundary } from './ErrorBoundary';
import { WebGLBackground } from './components/WebGLBackground';
import { getWebGLEnabled } from './lib/db';
import { useEffect, useState } from 'react';

export default function App() {
  const [webglEnabled, setWebglEnabled] = useState(false);

  useEffect(() => {
    // Load initial state
    getWebGLEnabled().then(setWebglEnabled).catch(() => { });

    // Listen for changes
    const handleWebglChange = () => {
      getWebGLEnabled().then(setWebglEnabled).catch(() => { });
    };

    window.addEventListener('webgl_enabled_changed', handleWebglChange);
    return () => window.removeEventListener('webgl_enabled_changed', handleWebglChange);
  }, []);

  return (
    <>
      <WebGLBackground enabled={webglEnabled} />
      <Routes>
        <Route path="/home" element={<HomeView />} />
        <Route path="/camp/:id" element={
          <ErrorBoundary>
            <MainLayout />
          </ErrorBoundary>
        } />
        <Route path="/arena" element={<ArenaView />} />
        <Route path="/settings" element={<SettingsView />} />
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </>
  );
}
