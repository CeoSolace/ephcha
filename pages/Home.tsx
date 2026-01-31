// pages/Home.tsx (New: Server list and join/create)
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LocalStorageStore, getPrekeyBundle } from '../encryption.ts';
import { v4 as uuidv4 } from 'uuid';

interface Props {
  store: LocalStorageStore | null;
  userId: string;
}

const Home: React.FC<Props> = ({ store, userId }) => {
  const [joinedServers, setJoinedServers] = useState<Record<string, { memberToken: string, admin: boolean, channels: string[] }>>(JSON.parse(localStorage.getItem('joinedServers') || '{}'));
  const [serverIdInput, setServerIdInput] = useState<string>('');
  const [joinTokenInput, setJoinTokenInput] = useState<string>('');
  const navigate = useNavigate();
  const API_BASE = process.env.REACT_APP_API_BASE || 'http://localhost:8000';

  const createServer = async () => {
    const res = await fetch(`${API_BASE}/create_server`, { method: 'POST' });
    const { server_id, join_token } = await res.json();
    await joinServer(server_id, join_token);
  };

  const joinServer = async (server_id: string, join_token: string) => {
    if (!store) return;
    const bundle = await getPrekeyBundle(store);
    const res = await fetch(`${API_BASE}/join_server/${server_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, join_token, prekey_bundle: bundle }),
    });
    if (!res.ok) return;
    const { member_token, others, admin_user_id } = await res.json();
    const isAdmin = admin_user_id === userId;
    const channels = ['general'];
    const updated = { ...joinedServers, [server_id]: { memberToken: member_token, admin: isAdmin, channels } };
    setJoinedServers(updated);
    localStorage.setItem('joinedServers', JSON.stringify(updated));

    // Store prekeys and members
    localStorage.setItem(`prekeys_${server_id}`, JSON.stringify(others));
    const members = Object.keys(others);
    members.push(userId);
    localStorage.setItem(`members_${server_id}`, JSON.stringify(members));

    navigate(`/server/${server_id}`);
  };

  return (
    <div style={{ padding: '20px' }}>
      <h1>E2EE Chat App - Home</h1>
      <button onClick={createServer}>Create Server</button>
      <input value={serverIdInput} onChange={e => setServerIdInput(e.target.value)} placeholder="Server ID" />
      <input value={joinTokenInput} onChange={e => setJoinTokenInput(e.target.value)} placeholder="Join Token" />
      <button onClick={() => joinServer(serverIdInput, joinTokenInput)}>Join Server</button>
      <div>
        Joined Servers: {Object.keys(joinedServers).map(s => (
          <button key={s} onClick={() => navigate(`/server/${s}`)}>{s.slice(0, 8)}...</button>
        ))}
      </div>
    </div>
  );
};

export default Home;
