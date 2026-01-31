// App.tsx (Updated as router wrapper)
import React, { useState, useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import Home from './pages/Home.tsx';
import Server from './pages/Server.tsx';
import { LocalStorageStore, initSignalStore } from './encryption.ts';  // Import shared store init
import { v4 as uuidv4 } from 'uuid';

const App: React.FC = () => {
  const [store, setStore] = useState<LocalStorageStore | null>(null);
  const [userId] = useState<string>(localStorage.getItem('userId') || uuidv4());

  useEffect(() => {
    const s = new LocalStorageStore();
    initSignalStore(s).then(() => setStore(s));
    localStorage.setItem('userId', userId);
  }, [userId]);

  return (
    <Routes>
      <Route path="/" element={<Home store={store} userId={userId} />} />
      <Route path="/server/:serverId" element={<Server store={store} userId={userId} />} />
    </Routes>
  );
};

export default App;
