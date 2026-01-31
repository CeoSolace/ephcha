// App.tsx (Complete, with index.html for simple serve)
import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { LocalStorageStore, GroupSessionBuilder, GroupCipher, initSignalStore, getPrekeyBundle, base64ToArrayBuffer, arrayBufferToBase64, padPlaintext, unpadPlaintext } from './encryption';
import { v4 as uuidv4 } from 'uuid';
import * as libsignal from 'libsignal-protocol-javascript';

const API_BASE = process.env.REACT_APP_API_BASE || 'http://localhost:8000'; // Use env var for prod

interface Message {
  sender: string;
  text: string;
  channel: string;
}

const App: React.FC = () => {
  const [store, setStore] = useState<LocalStorageStore | null>(null);
  const [userId, setUserId] = useState<string>(localStorage.getItem('userId') || uuidv4());
  const [joinedServers, setJoinedServers] = useState<Record<string, { memberToken: string, admin: boolean, channels: string[] }>>(JSON.parse(localStorage.getItem('joinedServers') || '{}'));
  const [currentServer, setCurrentServer] = useState<string>('');
  const [currentChannel, setCurrentChannel] = useState<string>('general');
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [input, setInput] = useState<string>('');
  const [serverIdInput, setServerIdInput] = useState<string>('');
  const [joinTokenInput, setJoinTokenInput] = useState<string>('');
  const [newChannelInput, setNewChannelInput] = useState<string>('');
  const [ws, setWs] = useState<WebSocket | null>(null);

  useEffect(() => {
    const s = new LocalStorageStore();
    initSignalStore(s).then(() => setStore(s));
    localStorage.setItem('userId', userId);
  }, [userId]);

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
    if (!res.ok) return; // Handle error
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

    // Init sessions for others
    for (const u in others) {
      await initSession(u, others[u]);
    }

    // Connect WS
    connectWS(server_id, member_token);
  };

  const initSession = async (u: string, b: any) => {
    if (!store) return;
    const address = new libsignal.ProtocolAddress(u, 1);
    if (await store.loadSession(address.toString())) return; // Already have
    const builder = new libsignal.SessionBuilder(store, address);
    const bundleObj = new libsignal.PreKeyBundle(
      b.registration_id,
      1,
      5,
      libsignal.curve.decodePoint(base64ToArrayBuffer(b.one_time_prekey)),
      1,
      libsignal.curve.decodePoint(base64ToArrayBuffer(b.signed_prekey)),
      base64ToArrayBuffer(b.signed_prekey_sig),
      libsignal.curve.decodePoint(base64ToArrayBuffer(b.identity)),
    );
    await builder.processPreKeyBundle(bundleObj);
  };

  const connectWS = (server_id: string, member_token: string) => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host; // For prod, matches backend
    const w = new WebSocket(`${protocol}//${host}/ws/${server_id}?member_token=${member_token}`);
    w.onopen = () => console.log('WS connected');
    w.onclose = () => console.log('WS closed');
    w.onmessage = handleMessage;
    setWs(w);
  };

  const handleMessage = async (e: MessageEvent) => {
    if (!store) return;
    const data = JSON.parse(e.data);
    const type = data.type;
    const sender = data.sender;
    if (type === 'join_notification') {
      const newUser = data.user_id;
      const members = JSON.parse(localStorage.getItem(`members_${currentServer}`) || '[]');
      if (!members.includes(newUser)) {
        members.push(newUser);
        localStorage.setItem(`members_${currentServer}`, JSON.stringify(members));
      }
      let prekeys = JSON.parse(localStorage.getItem(`prekeys_${currentServer}`) || '{}');
      if (!prekeys[newUser]) {
        const res = await fetch(`${API_BASE}/get_prekey/${currentServer}/${newUser}`);
        const b = await res.json();
        prekeys[newUser] = b;
        localStorage.setItem(`prekeys_${currentServer}`, JSON.stringify(prekeys));
        await initSession(newUser, b);
      }
      // Send channel_list
      const channels = joinedServers[currentServer].channels;
      const payload = JSON.stringify({ type: 'channel_list', channels });
      await sendPrivate(newUser, payload);
      // Send dist
      const groupId = currentServer;
      const senderKeyName = new libsignal.SenderKeyName(groupId, new libsignal.ProtocolAddress(userId, 1));
      const builder = new GroupSessionBuilder(store);
      const dist = builder.create(senderKeyName);
      const distPayload = JSON.stringify({ type: 'sender_dist', dist: arrayBufferToBase64(dist.serialize()) });
      await sendPrivate(newUser, distPayload);
    } else if (type === 'private') {
      const address = new libsignal.ProtocolAddress(sender, 1);
      const sessionCipher = new libsignal.SessionCipher(store, address);
      let plaintext: string;
      if (data.ciphertext.type === 3) {
        const prekeyMsg = new libsignal.PreKeySignalMessage(base64ToArrayBuffer(data.ciphertext.body));
        plaintext = await sessionCipher.decryptPreKeyWhisperMessage(prekeyMsg.serialize(), 'utf8');
      } else {
        const msg = new libsignal.SignalMessage(base64ToArrayBuffer(data.ciphertext.body));
        plaintext = await sessionCipher.decryptWhisperMessage(msg.serialize(), 'utf8');
      }
      const json = JSON.parse(plaintext);
      if (json.type === 'channel_list') {
        const currentChannels = joinedServers[currentServer]?.channels || ['general'];
        const newChannels = [...new Set([...currentChannels, ...json.channels])];
        const updated = { ...joinedServers, [currentServer]: { ...joinedServers[currentServer], channels: newChannels } };
        setJoinedServers(updated);
        localStorage.setItem('joinedServers', JSON.stringify(updated));
        // Send dist back
        const groupId = currentServer;
        const senderKeyName = new libsignal.SenderKeyName(groupId, new libsignal.ProtocolAddress(userId, 1));
        const builder = new GroupSessionBuilder(store);
        const dist = builder.create(senderKeyName);
        const distPayload = JSON.stringify({ type: 'sender_dist', dist: arrayBufferToBase64(dist.serialize()) });
        await sendPrivate(sender, distPayload);
      } else if (json.type === 'sender_dist') {
        const groupId = currentServer;
        const senderKeyName = new libsignal.SenderKeyName(groupId, new libsignal.ProtocolAddress(sender, 1));
        const builder = new GroupSessionBuilder(store);
        const distMsg = new libsignal.SenderKeyDistributionMessage(base64ToArrayBuffer(json.dist));
        builder.process(senderKeyName, distMsg);
      }
    } else if (type === 'group') {
      const groupId = currentServer;
      const senderKeyName = new libsignal.SenderKeyName(groupId, new libsignal.ProtocolAddress(sender, 1));
      const groupCipher = new GroupCipher(store, senderKeyName);
      let padded;
      try {
        padded = groupCipher.decrypt(base64ToArrayBuffer(data.ciphertext));
      } catch (e) {
        console.error('Decryption failed', e);
        return;
      }
      const plaintext = new TextDecoder().decode(unpadPlaintext(padded));
      const json = JSON.parse(plaintext);
      if (json.type === 'text') {
        const msg = { sender, text: json.text, channel: json.channel };
        const chanMsgs = messages[json.channel] || [];
        setMessages({ ...messages, [json.channel]: [...chanMsgs, msg] });
      } else if (json.type === 'new_channel') {
        const newChan = json.name;
        const channels = joinedServers[currentServer].channels;
        if (!channels.includes(newChan)) {
          const updatedChannels = [...channels, newChan];
          const updated = { ...joinedServers, [currentServer]: { ...joinedServers[currentServer], channels: updatedChannels } };
          setJoinedServers(updated);
          localStorage.setItem('joinedServers', JSON.stringify(updated));
        }
      }
    }
  };

  const sendPrivate = async (to: string, payload: string) => {
    if (!ws || !store) return;
    const address = new libsignal.ProtocolAddress(to, 1);
    const sessionCipher = new libsignal.SessionCipher(store, address);
    const ciphertext = await sessionCipher.encrypt(new TextEncoder().encode(payload));
    const msg = {
      type: 'private',
      to,
      sender: userId,
      ciphertext: { type: ciphertext.type, body: arrayBufferToBase64(ciphertext.body) },
    };
    ws.send(JSON.stringify(msg));
  };

  const sendMessage = async () => {
    if (!ws || !store || !currentServer) return;
    const groupId = currentServer;
    const senderKeyName = new libsignal.SenderKeyName(groupId, new libsignal.ProtocolAddress(userId, 1));
    const groupCipher = new GroupCipher(store, senderKeyName);
    const payload = JSON.stringify({ type: 'text', channel: currentChannel, text: input });
    const padded = padPlaintext(new TextEncoder().encode(payload));
    const senderKeyMsg = groupCipher.encrypt(padded);
    const msg = {
      type: 'group',
      sender: userId,
      ciphertext: arrayBufferToBase64(senderKeyMsg),
    };
    ws.send(JSON.stringify(msg));
    setInput('');
  };

  const createChannel = async () => {
    if (!ws || !store || !currentServer) return;
    const groupId = currentServer;
    const senderKeyName = new libsignal.SenderKeyName(groupId, new libsignal.ProtocolAddress(userId, 1));
    const groupCipher = new GroupCipher(store, senderKeyName);
    const payload = JSON.stringify({ type: 'new_channel', name: newChannelInput });
    const padded = padPlaintext(new TextEncoder().encode(payload));
    const senderKeyMsg = groupCipher.encrypt(padded);
    const msg = {
      type: 'group',
      sender: userId,
      ciphertext: arrayBufferToBase64(senderKeyMsg),
    };
    ws.send(JSON.stringify(msg));
    setNewChannelInput('');
  };

  return (
    <div style={{ padding: '20px' }}>
      <h1>E2EE Chat App</h1>
      <button onClick={createServer}>Create Server</button>
      <input value={serverIdInput} onChange={e => setServerIdInput(e.target.value)} placeholder="Server ID" />
      <input value={joinTokenInput} onChange={e => setJoinTokenInput(e.target.value)} placeholder="Join Token" />
      <button onClick={() => joinServer(serverIdInput, joinTokenInput)}>Join Server</button>
      <div>
        Servers: {Object.keys(joinedServers).map(s => <button key={s} onClick={() => setCurrentServer(s)}>{s.slice(0, 8)}...</button>)}
      </div>
      {currentServer && (
        <div>
          <h2>Server: {currentServer.slice(0, 8)}...</h2>
          Channels: {joinedServers[currentServer].channels.map(c => <button key={c} onClick={() => setCurrentChannel(c)}>{c}</button>)}
          {joinedServers[currentServer].admin && (
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
      )}
    </div>
  );
};

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<App />);
