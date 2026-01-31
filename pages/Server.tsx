// pages/Server.tsx (New: Channel and chat view)
import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { LocalStorageStore, GroupSessionBuilder, GroupCipher, base64ToArrayBuffer, arrayBufferToBase64, padPlaintext, unpadPlaintext } from '../encryption.ts';
import * as libsignal from 'libsignal-protocol-javascript';

interface Props {
  store: LocalStorageStore | null;
  userId: string;
}

interface Message {
  sender: string;
  text: string;
  channel: string;
}

const Server: React.FC<Props> = ({ store, userId }) => {
  const { serverId } = useParams<{ serverId: string }>();
  const [joinedServers, setJoinedServers] = useState<Record<string, { memberToken: string, admin: boolean, channels: string[] }>>(JSON.parse(localStorage.getItem('joinedServers') || '{}'));
  const [currentChannel, setCurrentChannel] = useState<string>('general');
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [input, setInput] = useState<string>('');
  const [newChannelInput, setNewChannelInput] = useState<string>('');
  const [ws, setWs] = useState<WebSocket | null>(null);
  const API_BASE = process.env.REACT_APP_API_BASE || 'http://localhost:8000';

  useEffect(() => {
    if (!serverId || !joinedServers[serverId]) return;
    const { memberToken } = joinedServers[serverId];
    connectWS(serverId, memberToken);
    return () => { if (ws) ws.close(); };
  }, [serverId]);

  const connectWS = (server_id: string, member_token: string) => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const w = new WebSocket(`${protocol}//${host}/ws/${server_id}?member_token=${member_token}`);
    w.onopen = () => console.log('WS connected');
    w.onclose = () => console.log('WS closed');
    w.onmessage = handleMessage;
    setWs(w);
  };

  // handleMessage, sendPrivate, sendMessage, createChannel functions (unchanged from previous App.tsx)
  // ... (copy the functions here)

  if (!serverId || !joinedServers[serverId]) return <div>Server not found</div>;

  return (
    <div style={{ padding: '20px' }}>
      <h1>Server: {serverId.slice(0, 8)}...</h1>
      Channels: {joinedServers[serverId].channels.map(c => <button key={c} onClick={() => setCurrentChannel(c)}>{c}</button>)}
      {joinedServers[serverId].admin && (
        <div>
          <input value={newChannelInput} onChange={e => setNewChannelInput(e.target.value)} placeholder="New Channel Name" />
          <button onClick={createChannel}>Create Channel</button>
        </div>
      )}
      <div>
        <h3>Messages in {currentChannel}</h3>
        <div style={{ border: '1px solid #ccc', height: '200px', overflowY: 'scroll', padding: '10px' }}>
          {(messages[currentChannel] || []).map((m, i) => <div key={i}><strong>{m.sender.slice(0, 8)}:</strong> {m.text}</div>)}
        </div>
      </div>
      <input value={input} onChange={e => setInput(e.target.value)} placeholder="Type message..." />
      <button onClick={sendMessage}>Send</button>
    </div>
  );
};

export default Server;
