# backend.py (Complete, no changes from previous)
import os
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, HTTPException, Request
from fastapi.responses import JSONResponse
import uuid
import base64
import time
from typing import Dict
import asyncio
from datetime import datetime
import motor.motor_asyncio

app = FastAPI()

# MongoDB setup
MONGO_URI = os.environ.get("MONGO_URI", "mongodb://localhost:27017")
client = motor.motor_asyncio.AsyncIOMotorClient(MONGO_URI)
db = client.chat_app

servers_col = db.servers  # { _id: server_id, join_token: str, admin_user_id: str, members: {user_id: {registration_id: int, identity: bytes, ...}}, created_at: datetime }
member_tokens_col = db.member_tokens  # { _id: server_id, tokens: {user_id: member_token} }

# Create TTL index for ephemerality (expire servers after 24h inactivity)
async def setup_ttl():
    await servers_col.create_index("last_activity", expireAfterSeconds=86400)  # 24 hours
    await member_tokens_col.create_index("last_activity", expireAfterSeconds=86400)

@app.on_event("startup")
async def startup_event():
    await setup_ttl()

# In-memory runtime state
connected: Dict[str, Dict[str, WebSocket]] = {}  # {server_id: {user_id: WebSocket}}
rate_limits: Dict[str, Dict] = {}  # {ip or user_id: {'messages': list[float]}}
ip_connections: Dict[str, int] = {}  # {ip: count}

# Rate limiting config
MESSAGE_LIMIT = 10
WINDOW_SEC = 60
SIZE_LIMIT = 4096
CONN_LIMIT_PER_IP = 5

# Helper for rate limiting
def is_rate_limited(key: str, now: float):
    if key not in rate_limits:
        rate_limits[key] = {'messages': []}
    messages = rate_limits[key]['messages']
    messages = [t for t in messages if now - t < WINDOW_SEC]
    rate_limits[key]['messages'] = messages
    if len(messages) >= MESSAGE_LIMIT:
        return True
    messages.append(now)
    return False

# Update last_activity
async def update_activity(server_id: str):
    now = datetime.utcnow()
    await servers_col.update_one({"_id": server_id}, {"$set": {"last_activity": now}})
    await member_tokens_col.update_one({"_id": server_id}, {"$set": {"last_activity": now}})

# Create server
@app.post("/create_server")
async def create_server():
    server_id = str(uuid.uuid4())
    join_token = str(uuid.uuid4())
    now = datetime.utcnow()
    await servers_col.insert_one({
        "_id": server_id,
        "join_token": join_token,
        "admin_user_id": None,
        "members": {},
        "created_at": now,
        "last_activity": now
    })
    await member_tokens_col.insert_one({
        "_id": server_id,
        "tokens": {},
        "created_at": now,
        "last_activity": now
    })
    if server_id not in connected:
        connected[server_id] = {}
    return {"server_id": server_id, "join_token": join_token}

# Join server
@app.post("/join_server/{server_id}")
async def join_server(server_id: str, request: Request):
    await update_activity(server_id)
    body = await request.json()
    server = await servers_col.find_one({"_id": server_id})
    if not server:
        raise HTTPException(status_code=404, detail="Server not found")
    if body.get('join_token') != server['join_token']:
        raise HTTPException(status_code=401, detail="Invalid join token")
    user_id = body.get('user_id')
    if not user_id:
        raise HTTPException(status_code=400, detail="Missing user_id")
    prekey = body.get('prekey_bundle')
    if not prekey:
        raise HTTPException(status_code=400, detail="Missing prekey_bundle")

    # Decode base64 to bytes
    try:
        bundle = {
            'registration_id': int(prekey['registration_id']),
            'identity': base64.b64decode(prekey['identity']),
            'signed_prekey': base64.b64decode(prekey['signed_prekey']),
            'signed_prekey_sig': base64.b64decode(prekey['signed_prekey_sig']),
            'one_time_prekey': base64.b64decode(prekey['one_time_prekey']),
        }
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid prekey format")

    # Store in members subdict
    update = {"$set": {f"members.{user_id}": bundle}}
    if server['admin_user_id'] is None:
        update["$set"]["admin_user_id"] = user_id
    await servers_col.update_one({"_id": server_id}, update)

    # Generate member token
    member_token = str(uuid.uuid4())
    await member_tokens_col.update_one({"_id": server_id}, {"$set": {f"tokens.{user_id}": member_token}})

    # Return others' bundles (base64)
    server = await servers_col.find_one({"_id": server_id})  # Refresh
    others = {}
    for u, b in server['members'].items():
        if u != user_id:
            others[u] = {
                'registration_id': b['registration_id'],
                'identity': base64.b64encode(b['identity']).decode(),
                'signed_prekey': base64.b64encode(b['signed_prekey']).decode(),
                'signed_prekey_sig': base64.b64encode(b['signed_prekey_sig']).decode(),
                'one_time_prekey': base64.b64encode(b['one_time_prekey']).decode(),
            }

    response = {
        "member_token": member_token,
        "others": others,
        "admin_user_id": server['admin_user_id']
    }

    # Broadcast join_notification
    if server_id in connected:
        for ws in connected[server_id].values():
            await ws.send_json({'type': 'join_notification', 'user_id': user_id})

    return response

# Get prekey for user
@app.get("/get_prekey/{server_id}/{user_id}")
async def get_prekey(server_id: str, user_id: str):
    await update_activity(server_id)
    server = await servers_col.find_one({"_id": server_id})
    if not server or user_id not in server['members']:
        raise HTTPException(status_code=404, detail="Not found")
    b = server['members'][user_id]
    return {
        'registration_id': b['registration_id'],
        'identity': base64.b64encode(b['identity']).decode(),
        'signed_prekey': base64.b64encode(b['signed_prekey']).decode(),
        'signed_prekey_sig': base64.b64encode(b['signed_prekey_sig']).decode(),
        'one_time_prekey': base64.b64encode(b['one_time_prekey']).decode(),
    }

# WebSocket endpoint
@app.websocket("/ws/{server_id}")
async def websocket_endpoint(websocket: WebSocket, member_token: str = Query(...)):
    server_id = websocket.path_params['server_id']
    await update_activity(server_id)
    server = await servers_col.find_one({"_id": server_id})
    if not server:
        await websocket.close(code=1008)
        return

    # Auth: find user_id by member_token
    tokens_doc = await member_tokens_col.find_one({"_id": server_id})
    user_id = None
    if tokens_doc:
        for u, t in tokens_doc['tokens'].items():
            if t == member_token:
                user_id = u
                break
    if user_id is None:
        await websocket.close(code=1008)
        return

    # Get IP
    ip = websocket.headers.get('cf-connecting-ip', websocket.client.host)

    # Check IP conn limit
    if ip not in ip_connections:
        ip_connections[ip] = 0
    if ip_connections[ip] >= CONN_LIMIT_PER_IP:
        await websocket.close(code=1013)
        return
    ip_connections[ip] += 1

    await websocket.accept()

    # Add to connected
    if server_id not in connected:
        connected[server_id] = {}
    connected[server_id][user_id] = websocket

    try:
        while True:
            data = await websocket.receive_json()
            now = time.time()

            # Size limit
            if len(str(data)) > SIZE_LIMIT:
                continue

            # Rate limit per user
            if is_rate_limited(user_id, now):
                continue

            # Rate limit per IP
            if is_rate_limited(ip, now):
                continue

            # Update activity on message
            await update_activity(server_id)

            msg_type = data.get('type')

            if msg_type == 'private':
                to_user = data.get('to')
                if to_user and server_id in connected and to_user in connected[server_id]:
                    await connected[server_id][to_user].send_json(data)
            elif msg_type in ['group', 'join_notification']:
                # Broadcast
                for ws in connected[server_id].values():
                    await ws.send_json(data)
    except WebSocketDisconnect:
        pass
    finally:
        if server_id in connected and user_id in connected[server_id]:
            del connected[server_id][user_id]
        ip_connections[ip] -= 1
        if ip_connections[ip] == 0:
            del ip_connections[ip]
