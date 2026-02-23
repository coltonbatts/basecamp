import { Navigate, Route, Routes } from 'react-router-dom';

import { HomeView } from './views/HomeView';
import { CampWorkspaceView } from './views/CampWorkspaceView';

export default function App() {
  return (
    <Routes>
      <Route path="/home" element={<HomeView />} />
      <Route path="/camp/:id" element={<CampWorkspaceView />} />
      <Route path="*" element={<Navigate to="/home" replace />} />
    </Routes>
  );
}
