// pages/Server.tsx
import React, { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import {
  LocalStorageStore,
  GroupSessionBuilder,
  GroupCipher,
  base64ToArrayBuffer,
  arrayBufferToBase64,
  padPlaintext,
  unpadPlaintext
} from '../encryption';
import * as libsignal from 'libsignal-protocol-javascript';

interface Message {
  sender: string;
  text: string;
  channel: string;
  timestamp?: number;
}

interface Props {
  store: LocalStorageStore | null;
  userId: string;
}

const Server: React.FC<Props> = ({ store, userId }) => {
  const { serverId } = useParams<{ serverId: string }>();
  const [joinedServers, setJoinedServers] = useState<Record<string, { memberToken: string; admin: boolean; channels: string[] }>>(
    JSON.parse(localStorage.getItem('joinedServers') || '{}')
  );
  const [currentChannel, setCurrentChannel] = useState<string>('general');
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [input, setInput] = useState<string>('');
  const [newChannelInput, setNewChannelInput] = useState<string>('');
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [status, setStatus] = useState<string>('Connecting...');

  const API_BASE = process.env.REACT_APP_API_BASE || 'http://localhost:8000';
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Connect WebSocket when serverId changes
  useEffect(() => {
    if (!serverId || !joinedServers[serverId] || !store) return;

    const { memberToken } = joinedServers[serverId];
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const url = `${protocol}//${host}/ws/${serverId}?member_token=${memberToken}`;

    const websocket = new WebSocket(url);

    websocket.onopen = () => {
      setStatus('Connected');
      console.log('WebSocket connected');
    };

    websocket.onclose = () => {
      setStatus('Disconnected');
      console.log('WebSocket closed');
    };

    websocket.onerror = (err) => {
      console.error('WebSocket error:', err);
      setStatus('Connection error');
    };

    websocket.onmessage = handleMessage;

    setWs(websocket);

    return () => {
      websocket.close();
    };
  }, [serverId, joinedServers, store]);

  const handleMessage = async (e: MessageEvent) => {
    if (!store || !serverId) return;
    const data = JSON.parse(e.data);
    const type = data.type;
    const sender = data.sender;

    if (type === 'join_notification') {
      const newUser = data.user_id;
      const membersKey = `members_${serverId}`;
      let members = JSON.parse(localStorage.getItem(membersKey) || '[]');
      if (!members.includes(newUser)) {
        members.push(newUser);
        localStorage.setItem(membersKey, JSON.stringify(members));
      }

      let prekeys = JSON.parse(localStorage.getItem(`prekeys_${serverId}`) || '{}');
      if (!prekeys[newUser]) {
        try {
          const res = await fetch(`${API_BASE}/get_prekey/${serverId}/${newUser}`);
          const b = await res.json();
          prekeys[newUser] = b;
          localStorage.setItem(`prekeys_${serverId}`, JSON.stringify(prekeys));
          await initSession(newUser, b);
        } catch (err) {
          console.error('Failed to fetch prekey for new user', err);
        }
      }

      // Send channel_list
      const channels = joinedServers[serverId].channels;
      const payload = JSON.stringify({ type: 'channel_list', channels });
      await sendPrivate(newUser, payload);

      // Send sender key distribution
      const groupId = serverId;
      const senderKeyName = new libsignal.SenderKeyName(groupId, new libsignal.ProtocolAddress(userId, 1));
      const builder = new GroupSessionBuilder(store);
      const dist = builder.create(senderKeyName);
      const distPayload = JSON.stringify({ type: 'sender_dist', dist: arrayBufferToBase64(dist.serialize()) });
      await sendPrivate(newUser, distPayload);
    }

    else if (type === 'private') {
      const address = new libsignal.ProtocolAddress(sender, 1);
      const sessionCipher = new libsignal.SessionCipher(store, address);
      let plaintext: string;

      try {
        if (data.ciphertext.type === 3) {
          const prekeyMsg = new libsignal.PreKeySignalMessage(base64ToArrayBuffer(data.ciphertext.body));
          plaintext = await sessionCipher.decryptPreKeyWhisperMessage(prekeyMsg.serialize(), 'utf8');
        } else {
          const msg = new libsignal.SignalMessage(base64ToArrayBuffer(data.ciphertext.body));
          plaintext = await sessionCipher.decryptWhisperMessage(msg.serialize(), 'utf8');
        }
      } catch (err) {
        console.error('Private message decryption failed:', err);
        return;
      }

      const json = JSON.parse(plaintext);

      if (json.type === 'channel_list') {
        const currentChannels = joinedServers[serverId]?.channels || ['general'];
        const newChannels = [...new Set([...currentChannels, ...json.channels])];
        const updated = { ...joinedServers, [serverId]: { ...joinedServers[serverId], channels: newChannels } };
        setJoinedServers(updated);
        localStorage.setItem('joinedServers', JSON.stringify(updated));

        // Respond with our sender key dist
        const groupId = serverId;
        const senderKeyName = new libsignal.SenderKeyName(groupId, new libsignal.ProtocolAddress(userId, 1));
        const builder = new GroupSessionBuilder(store);
        const dist = builder.create(senderKeyName);
        const distPayload = JSON.stringify({ type: 'sender_dist', dist: arrayBufferToBase64(dist.serialize()) });
        await sendPrivate(sender, distPayload);
      }

      else if (json.type === 'sender_dist') {
        const groupId = serverId;
        const senderKeyName = new libsignal.SenderKeyName(groupId, new libsignal.ProtocolAddress(sender, 1));
        const builder = new GroupSessionBuilder(store);
        const distMsg = new libsignal.SenderKeyDistributionMessage(base64ToArrayBuffer(json.dist));
        builder.process(senderKeyName, distMsg);
      }
    }

    else if (type === 'group') {
      const groupId = serverId;
      const senderKeyName = new libsignal.SenderKeyName(groupId, new libsignal.ProtocolAddress(sender, 1));
      const groupCipher = new GroupCipher(store, senderKeyName);
      let padded: Uint8Array;

      try {
        padded = groupCipher.decrypt(base64ToArrayBuffer(data.ciphertext));
      } catch (err) {
        console.error('Group decryption failed:', err);
        return;
      }

      const plaintext = new TextDecoder().decode(unpadPlaintext(padded));
      const json = JSON.parse(plaintext);

      if (json.type === 'text') {
        const msg: Message = { sender, text: json.text, channel: json.channel, timestamp: Date.now() };
        setMessages(prev => {
          const chanMsgs = prev[json.channel] || [];
          return { ...prev, [json.channel]: [...chanMsgs, msg] };
        });
      }

      else if (json.type === 'new_channel') {
        const newChan = json.name;
        const channels = joinedServers[serverId].channels;
        if (!channels.includes(newChan)) {
          const updatedChannels = [...channels, newChan];
          const updated = { ...joinedServers, [serverId]: { ...joinedServers[serverId], channels: updatedChannels } };
          setJoinedServers(updated);
          localStorage.setItem('joinedServers', JSON.stringify(updated));
        }
      }
    }
  };

  const initSession = async (u: string, b: any) => {
    if (!store) return;
    const address = new libsignal.ProtocolAddress(u, 1);
    if (await store.loadSession(address.toString())) return;
    const builder = new libsignal.SessionBuilder(store, address);
    const bundleObj = new libsignal.PreKeyBundle(
      b.registration_id,
      1,
      5,
      libsignal.curve.decodePoint(base64ToArrayBuffer(b.one_time_prekey)),
      1,
      libsignal.curve.decodePoint(base64ToArrayBuffer(b.signed_prekey)),
      base64ToArrayBuffer(b.signed_prekey_sig),
      libsignal.curve.decodePoint(base64ToArrayBuffer(b.identity))
    );
    await builder.processPreKeyBundle(bundleObj);
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
      ciphertext: { type: ciphertext.type, body: arrayBufferToBase64(ciphertext.body) }
    };
    ws.send(JSON.stringify(msg));
  };

  const sendMessage = async () => {
    if (!ws || !store || !serverId || !input.trim()) return;

    const groupId = serverId;
    const senderKeyName = new libsignal.SenderKeyName(groupId, new libsignal.ProtocolAddress(userId, 1));
    const groupCipher = new GroupCipher(store, senderKeyName);
    const payload = JSON.stringify({ type: 'text', channel: currentChannel, text: input });
    const padded = padPlaintext(new TextEncoder().encode(payload));
    const senderKeyMsg = groupCipher.encrypt(padded);
    const msg = {
      type: 'group',
      sender: userId,
      ciphertext: arrayBufferToBase64(senderKeyMsg)
    };
    ws.send(JSON.stringify(msg));
    setInput('');
  };

  const createChannel = async () => {
    if (!ws || !store || !serverId || !newChannelInput.trim()) return;
    if (!joinedServers[serverId].admin) return;

    const groupId = serverId;
    const senderKeyName = new libsignal.SenderKeyName(groupId, new libsignal.ProtocolAddress(userId, 1));
    const groupCipher = new GroupCipher(store, senderKeyName);
    const payload = JSON.stringify({ type: 'new_channel', name: newChannelInput.trim() });
    const padded = padPlaintext(new TextEncoder().encode(payload));
    const senderKeyMsg = groupCipher.encrypt(padded);
    const msg = {
      type: 'group',
      sender: userId,
      ciphertext: arrayBufferToBase64(senderKeyMsg)
    };
    ws.send(JSON.stringify(msg));
    setNewChannelInput('');
  };

  if (!serverId || !joinedServers[serverId]) {
    return <div style={{ padding: '20px' }}>Server not found or not joined</div>;
  }

  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto' }}>
      <h1>Server: {serverId.slice(0, 8)}... • {status}</h1>

      <div style={{ marginBottom: '20px' }}>
        <strong>Channels:</strong>
        {joinedServers[serverId].channels.map(c => (
          <button
            key={c}
            onClick={() => setCurrentChannel(c)}
            style={{
              margin: '0 8px 8px 0',
              padding: '6px 12px',
              background: currentChannel === c ? '#007bff' : '#eee',
              color: currentChannel === c ? 'white' : 'black',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            {c}
          </button>
        ))}
      </div>

      {joinedServers[serverId].admin && (
        <div style={{ marginBottom: '20px' }}>
          <input
            value={newChannelInput}
            onChange={e => setNewChannelInput(e.target.value)}
            placeholder="New channel name..."
            style={{ padding: '8px', marginRight: '8px' }}
          />
          <button
            onClick={createChannel}
            disabled={!newChannelInput.trim()}
            style={{ padding: '8px 16px' }}
          >
            Create Channel
          </button>
        </div>
      )}

      <div
        style={{
          border: '1px solid #ccc',
          height: '400px',
          overflowY: 'auto',
          padding: '16px',
          background: '#f9f9f9',
          borderRadius: '8px',
          marginBottom: '16px'
        }}
      >
        {(messages[currentChannel] || []).map((m, i) => (
          <div key={i} style={{ marginBottom: '12px' }}>
            <strong style={{ color: '#0066cc' }}>{m.sender.slice(0, 8)}...</strong>
            <span style={{ color: '#555', fontSize: '0.85em', marginLeft: '8px' }}>
              {new Date(m.timestamp || 0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
            <div>{m.text}</div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div style={{ display: 'flex' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Type a message..."
          onKeyDown={e => e.key === 'Enter' && sendMessage()}
          style={{ flex: 1, padding: '10px', borderRadius: '4px 0 0 4px', border: '1px solid #ccc', borderRight: 'none' }}
        />
        <button
          onClick={sendMessage}
          disabled={!input.trim() || !ws || ws.readyState !== WebSocket.OPEN}
          style={{ padding: '10px 20px', background: '#28a745', color: 'white', border: 'none', borderRadius: '0 4px 4px 0', cursor: 'pointer' }}
        >
          Send
        </button>
      </div>
    </div>
  );
};

export default Server;
