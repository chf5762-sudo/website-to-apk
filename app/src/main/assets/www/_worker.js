/**
 * Project-PPT-V2 Cloudflare Worker
 * Clean UTF-8 version for Pages deployment
 */

const CONFIG = {
    WEBDAV: {
        URL: "https://ajiro.infini-cloud.net/dav/",
        USER: "chf5762",
        PASS: "piNdCJ4EPiw5Wtgn"
    },
    PREVIEW_TOKEN: "Allow_Public_Preview_Access_2025",
    // Fixed admin key for AI agent automation. Change this before production use.
    ADMIN_FIXED_KEY: "easyshow-admin-fixed-key-2026"
};

// ========== HTTP Chat System (replaces MQTT for messages & presence) ==========
// Storage mode priority: D1 -> KV -> in-memory fallback.
const chatRooms = new Map(); // roomId -> { messages: [], users: Map<sessionId, {name, time, role}> }
const MAX_MESSAGES = 200;
const USER_TIMEOUT = 35000; // 35 seconds
const ADMIN_CMD_TTL = 5 * 60 * 1000;
const adminCommandQueues = new Map(); // roomId -> [{ id, action, ... , ts }]
const adminRoomStates = new Map(); // roomId -> { ...state, ts }
const screenStates = new Map(); // roomId -> { type, content/url, ... , ts }
const activeScreenRooms = new Map(); // key -> { roomId, ts, source }
const screenRenderAcks = new Map(); // roomId -> { roomId, hash, ts, clientTs, ok, reason, source }
const screenHealLocks = new Map(); // roomId -> lastHealTs
const ACTIVE_SCREEN_ROOM_KEY = "default";

function getChatRoom(roomId) {
    if (!chatRooms.has(roomId)) {
        chatRooms.set(roomId, { messages: [], users: new Map() });
    }
    return chatRooms.get(roomId);
}

function cleanupRoom(room) {
    // Remove old messages (keep last MAX_MESSAGES)
    if (room.messages.length > MAX_MESSAGES) {
        room.messages = room.messages.slice(-MAX_MESSAGES);
    }
    // Remove timed-out users
    const now = Date.now();
    for (const [sid, user] of room.users) {
        if (now - user.time > USER_TIMEOUT) {
            room.users.delete(sid);
        }
    }
}

function getChatStorageMode(env) {
    if (env && env.CHAT_DB) return "d1";
    return "memory";
}

async function ensureChatSchemaD1(env) {
    if (!env || !env.CHAT_DB) return;
    await env.CHAT_DB.batch([
        env.CHAT_DB.prepare(`CREATE TABLE IF NOT EXISTS chat_messages (
            id TEXT PRIMARY KEY,
            room_id TEXT NOT NULL,
            payload TEXT NOT NULL,
            ts INTEGER NOT NULL
        )`),
        env.CHAT_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_messages_room_ts
            ON chat_messages(room_id, ts)`),
        env.CHAT_DB.prepare(`CREATE TABLE IF NOT EXISTS chat_presence (
            room_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            name TEXT NOT NULL,
            role TEXT NOT NULL,
            ts INTEGER NOT NULL,
            PRIMARY KEY (room_id, session_id)
        )`),
        env.CHAT_DB.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_presence_room_ts
            ON chat_presence(room_id, ts)`),
        env.CHAT_DB.prepare(`CREATE TABLE IF NOT EXISTS screen_states (
            room_id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            ts INTEGER NOT NULL
        )`),
        env.CHAT_DB.prepare(`CREATE TABLE IF NOT EXISTS active_rooms (
            id TEXT PRIMARY KEY,
            room_id TEXT NOT NULL,
            source TEXT,
            ts INTEGER NOT NULL
        )`),
        env.CHAT_DB.prepare(`CREATE TABLE IF NOT EXISTS screen_acks (
            room_id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            ts INTEGER NOT NULL
        )`)
    ]);
}

async function chatPersistMessage(env, roomId, msg) {
    const mode = getChatStorageMode(env);
    if (mode === "d1") {
        await ensureChatSchemaD1(env);
        await env.CHAT_DB.prepare(
            "INSERT OR REPLACE INTO chat_messages (id, room_id, payload, ts) VALUES (?, ?, ?, ?)"
        ).bind(msg.id, roomId, JSON.stringify(msg), msg.timestamp).run();

        const oldRows = await env.CHAT_DB.prepare(
            `SELECT id FROM chat_messages WHERE room_id = ? ORDER BY ts DESC LIMIT -1 OFFSET ?`
        ).bind(roomId, MAX_MESSAGES).all();
        if (oldRows && oldRows.results && oldRows.results.length > 0) {
            const stmts = oldRows.results.map(r =>
                env.CHAT_DB.prepare("DELETE FROM chat_messages WHERE id = ?").bind(r.id)
            );
            await env.CHAT_DB.batch(stmts);
        }
        return;
    }
    const room = getChatRoom(roomId);
    room.messages.push(msg);
    cleanupRoom(room);
}

async function chatReadMessages(env, roomId, since, sessionId) {
    const mode = getChatStorageMode(env);
    if (mode === "d1") {
        await ensureChatSchemaD1(env);
        const rows = await env.CHAT_DB.prepare(
            "SELECT payload FROM chat_messages WHERE room_id = ? AND ts > ? ORDER BY ts ASC"
        ).bind(roomId, since).all();
        const out = [];
        for (const row of (rows.results || [])) {
            try {
                const msg = JSON.parse(row.payload);
                if (!sessionId || msg.sessionId !== sessionId) out.push(msg);
            } catch (e) {}
        }
        return out;
    }
    const room = getChatRoom(roomId);
    cleanupRoom(room);
    return room.messages.filter(m => m.timestamp > since && m.sessionId !== sessionId);
}

async function chatHeartbeatPersist(env, roomId, sessionId, name, role) {
    const now = Date.now();
    const room = getChatRoom(roomId);
    room.users.set(sessionId, { name: name || 'Anonymous', role: role || 'viewer', time: now });
    cleanupRoom(room);
    const users = [];
    for (const [sid, user] of room.users) users.push({ sessionId: sid, name: user.name, role: user.role });
    return users;
}

async function handleChatSend(request, env) {
    const body = await request.json();
    const { roomId, action, sender, sessionId, text, fileName, fileSize, url, timestamp, role, imageUrl } = body;
    if (!roomId || !sessionId) return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });

    const msg = { action: action || 'chat', sender, sessionId, text, fileName, fileSize, url, imageUrl, timestamp: timestamp || Date.now(), id: Date.now() + '_' + Math.random().toString(36).substr(2, 5) };
    await chatPersistMessage(env, roomId, msg);
    const storageMode = getChatStorageMode(env);

    return new Response(JSON.stringify({ success: true, id: msg.id, storageMode }), { headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
}

async function handleChatPoll(request, env) {
    const url = new URL(request.url);
    const roomId = url.searchParams.get('roomId');
    const since = parseInt(url.searchParams.get('since') || '0');
    const sessionId = url.searchParams.get('sessionId');
    if (!roomId) return new Response(JSON.stringify({ error: 'Missing roomId' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });

    const newMessages = await chatReadMessages(env, roomId, since, sessionId);
    const storageMode = getChatStorageMode(env);

    return new Response(JSON.stringify({ messages: newMessages, timestamp: Date.now(), storageMode }), { headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
}

async function handleChatHeartbeat(request, env) {
    const body = await request.json();
    const { roomId, sessionId, name, role } = body;
    if (!roomId || !sessionId) return new Response(JSON.stringify({ error: 'Missing params' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });

    const users = await chatHeartbeatPersist(env, roomId, sessionId, name, role);
    const storageMode = getChatStorageMode(env);

    return new Response(JSON.stringify({ users, count: users.length, storageMode }), { headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
}
// ========== End HTTP Chat System ==========

// ========== Admin HTTP Control API ==========
function getAdminRoomId(roomId) {
    return (roomId || "PPT002").toString();
}

function getAdminQueue(roomId) {
    const rid = getAdminRoomId(roomId);
    if (!adminCommandQueues.has(rid)) adminCommandQueues.set(rid, []);
    return adminCommandQueues.get(rid);
}

function cleanupAdminQueue(queue) {
    const now = Date.now();
    while (queue.length && (now - Number(queue[0].ts || 0) > ADMIN_CMD_TTL)) {
        queue.shift();
    }
    if (queue.length > 500) {
        queue.splice(0, queue.length - 500);
    }
}

async function handleAdminCommandPush(request) {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const action = (body.action || "").toString().trim();
    if (!action) {
        return new Response(JSON.stringify({ error: "Missing action" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
    }
    const now = Date.now();
    const command = {
        id: body.id || ("cmd_" + now + "_" + Math.random().toString(36).slice(2, 8)),
        roomId: getAdminRoomId(body.roomId),
        action,
        page: body.page,
        value: body.value,
        source: body.source || "api",
        ts: now
    };
    const queue = getAdminQueue(command.roomId);
    queue.push(command);
    cleanupAdminQueue(queue);
    return new Response(JSON.stringify({ success: true, command }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function handleAdminCommandPoll(request) {
    const url = new URL(request.url);
    const roomId = getAdminRoomId(url.searchParams.get("roomId"));
    const since = Number(url.searchParams.get("since") || 0);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 200);
    const queue = getAdminQueue(roomId);
    cleanupAdminQueue(queue);
    const commands = queue.filter(c => Number(c.ts || 0) > since).slice(0, limit);
    const latestTs = commands.length ? Number(commands[commands.length - 1].ts || since) : since;
    return new Response(JSON.stringify({ success: true, roomId, commands, latestTs }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function handleAdminStateSet(request) {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const roomId = getAdminRoomId(body.roomId);
    const now = Date.now();
    const state = {
        roomId,
        page: Number(body.page || 0),
        totalPages: Number(body.totalPages || 0),
        status: body.status || "unknown",
        isConnected: !!body.isConnected,
        isPresentation: !!body.isPresentation,
        fileName: body.fileName || "",
        source: body.source || "human",
        ts: now
    };
    adminRoomStates.set(roomId, state);

    // 人优先逻辑：如果当前屏幕显示的是 Agent 推送的内容，人一操作就强制清空屏幕状态
    const screenState = screenStates.get(roomId);
    if (screenState && screenState.source === "agent") {
        console.log(`[Priority] Human activity detected in room ${roomId}, clearing agent screen state.`);
        screenStates.delete(roomId);
    }

    return new Response(JSON.stringify({ success: true, state }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function handleAdminStateGet(request) {
    const url = new URL(request.url);
    const roomId = getAdminRoomId(url.searchParams.get("roomId"));
    const state = adminRoomStates.get(roomId) || {
        roomId,
        page: 0,
        totalPages: 0,
        status: "unknown",
        isConnected: false,
        isPresentation: false,
        fileName: "",
        ts: 0
    };
    return new Response(JSON.stringify({ success: true, state }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}
// ========== End Admin HTTP Control API ==========

// ========== Remote Screen Push API ==========
function getScreenRoomId(roomId) {
    return (roomId || "PPT002").toString();
}

function decodeUtf8Base64Strict(input) {
    if (!input) return { ok: true, value: "" };
    let b64 = String(input).trim();
    if (!b64) return { ok: true, value: "" };
    b64 = b64.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    try {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return { ok: true, value };
    } catch (e) {
        return { ok: false, value: "", error: e && e.message ? e.message : "Invalid base64/utf8" };
    }
}

function hasNonAsciiText(input) {
    return /[^\x00-\x7F]/.test(String(input || ""));
}

async function sha256HexUtf8(input) {
    const bytes = new TextEncoder().encode(String(input || ""));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const arr = Array.from(new Uint8Array(digest));
    return arr.map(b => b.toString(16).padStart(2, "0")).join("");
}

function hashScreenState(state) {
    if (!state) return "";
    const raw = [
        String(state.roomId || ""),
        String(state.type || ""),
        String(state.text || ""),
        String(state.content || ""),
        String(state.url || ""),
        String(state.fit || "")
    ].join("|");
    let h = 2166136261;
    for (let i = 0; i < raw.length; i++) {
        h ^= raw.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
}

async function saveActiveScreenRoom(roomId, env, source = "remote") {
    const payload = { roomId: getScreenRoomId(roomId), ts: Date.now(), source };
    const payloadStr = JSON.stringify(payload);
    if (env && env.CHAT_DB) {
        try {
            await ensureChatSchemaD1(env);
            await env.CHAT_DB.prepare(
                "INSERT OR REPLACE INTO active_rooms (id, room_id, source, ts) VALUES (?, ?, ?, ?)"
            ).bind(ACTIVE_SCREEN_ROOM_KEY, payload.roomId, source, payload.ts).run();
        } catch (e) {}
    }
    activeScreenRooms.set(ACTIVE_SCREEN_ROOM_KEY, payload);
    return payload;
}

async function readActiveScreenRoom(env) {
    if (env && env.CHAT_DB) {
        try {
            await ensureChatSchemaD1(env);
            const row = await env.CHAT_DB.prepare(
                "SELECT room_id, ts, source FROM active_rooms WHERE id = ?"
            ).bind(ACTIVE_SCREEN_ROOM_KEY).first();
            if (row) return { roomId: row.room_id, ts: row.ts, source: row.source };
        } catch (e) {}
    }
    return activeScreenRooms.get(ACTIVE_SCREEN_ROOM_KEY) || null;
}

async function resolveScreenRoomId(roomId, env) {
    const explicit = (roomId || "").toString().trim();
    if (explicit) return getScreenRoomId(explicit);
    const active = await readActiveScreenRoom(env);
    if (active && active.roomId) return getScreenRoomId(active.roomId);
    return getScreenRoomId("");
}

function toBilibiliEmbedUrl(input) {
    const raw = (input || "").toString().trim();
    if (!raw) return null;
    const bvidMatch = raw.match(/BV[0-9A-Za-z]{10}/);
    if (!bvidMatch) return null;
    const bvid = bvidMatch[0];
    let page = 1;
    try {
        const u = new URL(raw);
        const p = Number(u.searchParams.get("p") || "1");
        if (Number.isFinite(p) && p > 0) page = Math.floor(p);
    } catch (e) {}
    return `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&page=${page}&high_quality=1&danmaku=0&autoplay=1`;
}

function toYouTubeEmbedUrl(input) {
    const raw = (input || "").toString().trim();
    if (!raw) return null;
    let videoId = null;
    let start = 0;
    try {
        const u = new URL(raw);
        const host = (u.hostname || "").toLowerCase();
        if (host.includes("youtu.be")) {
            videoId = u.pathname.replace(/^\/+/, "").split("/")[0] || null;
        } else if (host.includes("youtube.com")) {
            if (u.pathname.startsWith("/watch")) videoId = u.searchParams.get("v");
            if (!videoId && u.pathname.startsWith("/shorts/")) videoId = u.pathname.split("/")[2] || null;
            if (!videoId && u.pathname.startsWith("/embed/")) videoId = u.pathname.split("/")[2] || null;
        }
        const t = u.searchParams.get("t") || u.searchParams.get("start") || "";
        if (/^\d+$/.test(t)) start = Number(t);
    } catch (e) {}
    if (!videoId) {
        const m = raw.match(/[?&]v=([a-zA-Z0-9_-]{6,})/) || raw.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/) || raw.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{6,})/);
        videoId = m ? m[1] : null;
    }
    if (!videoId) return null;
    const base = `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&rel=0&modestbranding=1`;
    return start > 0 ? `${base}&start=${start}` : base;
}

async function handleScreenPush(request, env) {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const roomId = await resolveScreenRoomId(body.roomId, env);
    let type = (body.type || "").toString().trim().toLowerCase();
    const bilibiliInput = body.bilibiliUrl || body.biliUrl || body.videoUrl || "";
    const bilibiliEmbed = toBilibiliEmbedUrl(bilibiliInput || body.url || "");
    const youtubeInput = body.youtubeUrl || body.ytUrl || body.videoUrl || "";
    const youtubeEmbed = toYouTubeEmbedUrl(youtubeInput || body.url || "");
    if (!type && bilibiliEmbed) type = "html";
    if (!type && youtubeEmbed) type = "html";
    if (!type) {
        return new Response(JSON.stringify({ error: "Missing type" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
    }
    if (type === "bilibili") type = "html";
    if (type === "youtube") type = "html";
    if (!["text", "image", "video", "html", "svg", "iframe", "pdf", "doc"].includes(type)) {
        return new Response(JSON.stringify({ error: "Unsupported type" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
    }

    const textB64 = body.text_b64 || body.textBase64 || "";
    const contentB64 = body.content_b64 || body.contentBase64 || "";
    const hasTextB64 = !!String(textB64).trim();
    const hasContentB64 = !!String(contentB64).trim();
    const plainText = body.text || "";
    const plainContent = body.content || "";
    if (!hasTextB64 && hasNonAsciiText(plainText)) {
        return new Response(JSON.stringify({ error: "Non-ASCII text must use text_b64 (UTF-8 base64)." }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
    }
    if (!hasContentB64 && hasNonAsciiText(plainContent)) {
        return new Response(JSON.stringify({ error: "Non-ASCII content must use content_b64 (UTF-8 base64)." }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
    }

    const decodedTextRes = decodeUtf8Base64Strict(textB64);
    if (hasTextB64 && !decodedTextRes.ok) {
        return new Response(JSON.stringify({ error: "Invalid text_b64", detail: decodedTextRes.error || "" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
    }
    const decodedContentRes = decodeUtf8Base64Strict(contentB64);
    if (hasContentB64 && !decodedContentRes.ok) {
        return new Response(JSON.stringify({ error: "Invalid content_b64", detail: decodedContentRes.error || "" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
    }

    const decodedText = decodedTextRes.value || "";
    const decodedContent = decodedContentRes.value || "";
    let content = decodedContent || plainContent;
    let url = body.url || "";

    const textSha = (body.text_sha256 || body.textSha256 || "").toString().trim().toLowerCase();
    const contentSha = (body.content_sha256 || body.contentSha256 || "").toString().trim().toLowerCase();
    if (hasTextB64 && textSha) {
        const actual = await sha256HexUtf8(decodedText);
        if (actual !== textSha) {
            return new Response(JSON.stringify({ error: "text_sha256 mismatch" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
        }
    }
    if (hasContentB64 && contentSha) {
        const actual = await sha256HexUtf8(decodedContent);
        if (actual !== contentSha) {
            return new Response(JSON.stringify({ error: "content_sha256 mismatch" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
        }
    }

    if (type === "html" && !content) {
        const embed = bilibiliEmbed || youtubeEmbed;
        if (embed) content = `<iframe src="${embed}" style="width:100%;height:100%;border:0" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
        url = "";
    }

    const state = {
        roomId,
        type,
        text: decodedText || plainText,
        content,
        url,
        title: body.title || "",
        fit: body.fit || "contain",
        source: body.source || "agent",
        ts: Date.now()
    };
    
    // 1. 保存状态 (D1 优先)
    await saveScreenState(roomId, state, env);
    
    // 2. 联动 Chat 频道发送实时通知
    try {
        const msg = {
            action: 'screen_update',
            sender: 'System',
            sessionId: 'system_agent',
            text: `Screen updated: ${state.title || state.type}`,
            state: state,
            timestamp: Date.now(),
            id: 'sys_' + Date.now()
        };
        await chatPersistMessage(env, roomId, msg);
    } catch (e) {}

    // 3. 确定存储介质与健康检查 (调试用)
    let storageUsed = "memory";
    let dbStatus = "none";
    if (env && env.CHAT_DB) {
        storageUsed = "d1";
        dbStatus = "ok";
    }

    return new Response(JSON.stringify({ 
        success: true, 
        state, 
        storageUsed, 
        dbStatus,
        hint: storageUsed === "d1" ? "D1 Online" : "Memory Only"
    }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function handleScreenStateGet(request, env) {
    const url = new URL(request.url);
    const roomId = await resolveScreenRoomId(url.searchParams.get("roomId"), env);
    const state = await readScreenState(roomId, env);
    
    // 增加闲置判定：30 分钟无动作
    const isIdle = state && state.ts ? (Date.now() - state.ts > 30 * 60 * 1000) : false;
    
    return new Response(JSON.stringify({ success: true, roomId, state, isIdle }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function handleScreenClear(request, env) {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const roomId = await resolveScreenRoomId(body.roomId, env);
    const state = {
        roomId,
        type: "text",
        text: "WAITING SIGNAL",
        content: "",
        url: "",
        ts: Date.now()
    };
    await saveScreenState(roomId, state, env);
    return new Response(JSON.stringify({ success: true, roomId, state }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function handleScreenActiveRoomReport(request, env) {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const roomId = getScreenRoomId(body.roomId);
    if (!roomId) {
        return new Response(JSON.stringify({ error: "Missing roomId" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
    }
    const source = (body.source || "remote").toString().slice(0, 40);
    const saved = await saveActiveScreenRoom(roomId, env, source);
    return new Response(JSON.stringify({ success: true, activeRoom: saved }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function handleScreenActiveRoomGet(env) {
    const active = await readActiveScreenRoom(env);
    return new Response(JSON.stringify({ success: true, activeRoom: active || null }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function saveScreenRenderAck(roomId, ack, env) {
    const payload = {
        roomId,
        hash: String(ack.hash || ""),
        ts: Date.now(),
        clientTs: Number(ack.clientTs || 0),
        ok: ack.ok !== false,
        reason: String(ack.reason || ""),
        source: String(ack.source || "remote").slice(0, 40)
    };
    screenRenderAcks.set(roomId, payload);
    return payload;
}

async function readScreenRenderAck(roomId, env) {
    return screenRenderAcks.get(roomId) || null;
}

async function handleScreenRenderAck(request, env) {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const roomId = getScreenRoomId(body.roomId);
    if (!roomId) {
        return new Response(JSON.stringify({ error: "Missing roomId" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
    }
    const saved = await saveScreenRenderAck(roomId, body, env);
    return new Response(JSON.stringify({ success: true, ack: saved }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function handleAdminScreenHealth(request, env) {
    const url = new URL(request.url);
    const roomId = await resolveScreenRoomId(url.searchParams.get("roomId"), env);
    const staleSec = Math.min(Math.max(Number(url.searchParams.get("staleSec") || 10), 3), 300);
    const autoHeal = url.searchParams.get("autoHeal") === "1";
    const expected = await readScreenState(roomId, env);
    const ack = await readScreenRenderAck(roomId, env);
    const now = Date.now();

    let status = "ok";
    let reason = "";
    if (!expected) {
        status = "no_expected_state";
        reason = "screen state is empty";
    } else if (!ack) {
        status = "no_render_ack";
        reason = "remote has not reported render ack";
    } else if (now - Number(ack.ts || 0) > staleSec * 1000) {
        status = "stale_render_ack";
        reason = `last ack older than ${staleSec}s`;
    } else {
        const expectedHash = hashScreenState(expected);
        if (String(ack.hash || "") !== expectedHash) {
            status = "hash_mismatch";
            reason = "ack hash differs from expected state hash";
        }
    }

    const healDisabledForRoom = roomId === "admin";
    let healed = false;
    let healAction = "";
    if (autoHeal && status !== "ok" && expected && !healDisabledForRoom) {
        const healedState = { ...expected, ts: now };
        await saveScreenState(roomId, healedState, env);
        healed = true;
        healAction = "repush_state_with_new_ts";
    } else if (autoHeal && status !== "ok" && expected && healDisabledForRoom) {
        healAction = "disabled_for_admin_room";
    }

    return new Response(JSON.stringify({
        success: true,
        roomId,
        status,
        reason,
        staleSec,
        expectedHash: expected ? hashScreenState(expected) : "",
        expectedTs: expected ? Number(expected.ts || 0) : 0,
        ack: ack || null,
        healed,
        healAction
    }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function canRunScreenHeal(roomId, env, cooldownMs) {
    const now = Date.now();
    const last = Number(screenHealLocks.get(roomId) || 0);
    if (now - last < cooldownMs) return false;
    screenHealLocks.set(roomId, now);
    return true;
}

async function handleScreenSelfHeal(request, env) {
    const url = new URL(request.url);
    const roomId = await resolveScreenRoomId(url.searchParams.get("roomId"), env);
    const cooldownMs = 3000;
    const expected = await readScreenState(roomId, env);
    const ack = await readScreenRenderAck(roomId, env);
    const now = Date.now();

    let status = "ok";
    let reason = "";
    if (!expected) {
        status = "no_expected_state";
        reason = "screen state is empty";
    } else if (!ack) {
        status = "no_render_ack";
        reason = "remote has not reported render ack";
    } else if (now - Number(ack.ts || 0) > 6000) {
        status = "stale_render_ack";
        reason = "ack older than 6s";
    } else if (String(ack.hash || "") !== hashScreenState(expected)) {
        status = "hash_mismatch";
        reason = "ack hash differs";
    }

    const healDisabledForRoom = roomId === "admin";
    let healed = false;
    let skippedByCooldown = false;
    if (status !== "ok" && expected && !healDisabledForRoom) {
        const allowed = await canRunScreenHeal(roomId, env, cooldownMs);
        if (allowed) {
            await saveScreenState(roomId, { ...expected, ts: now }, env);
            healed = true;
        } else {
            skippedByCooldown = true;
        }
    }

    return new Response(JSON.stringify({
        success: true,
        roomId,
        status,
        reason,
        healed,
        skippedByCooldown,
        healDisabledForRoom
    }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function saveScreenState(roomId, state, env) {
    const payload = JSON.stringify(state);
    const now = Date.now();

    // 1. 写入 D1
    if (env && env.CHAT_DB) {
        try {
            await ensureChatSchemaD1(env);
            await env.CHAT_DB.prepare(
                "INSERT OR REPLACE INTO screen_states (room_id, payload, ts) VALUES (?, ?, ?)"
            ).bind(roomId, payload, now).run();
            if (roomId.includes("/")) {
                const shortId = roomId.split("/").pop();
                if (shortId && shortId !== roomId) {
                    await env.CHAT_DB.prepare(
                        "INSERT OR REPLACE INTO screen_states (room_id, payload, ts) VALUES (?, ?, ?)"
                    ).bind(shortId, JSON.stringify({ ...state, roomId: shortId }), now).run();
                }
            }
        } catch (e) { console.error("D1 Screen State Save Error:", e); }
    }

    // 2. 写入内存
    screenStates.set(roomId, state);
    if (roomId.includes("/")) {
        const shortId = roomId.split("/").pop();
        if (shortId && shortId !== roomId) {
            screenStates.set(shortId, { ...state, roomId: shortId });
        }
    }
}

async function readScreenState(roomId, env) {
    let result = null;

    // 1. D1 读取
    if (env && env.CHAT_DB) {
        try {
            await ensureChatSchemaD1(env);
            const row = await env.CHAT_DB.prepare(
                "SELECT payload FROM screen_states WHERE room_id = ?"
            ).bind(roomId).first();
            if (row && row.payload) result = JSON.parse(row.payload);

            if (!result && roomId.includes("/")) {
                const shortId = roomId.split("/").pop();
                if (shortId) {
                    const rowShort = await env.CHAT_DB.prepare("SELECT payload FROM screen_states WHERE room_id = ?").bind(shortId).first();
                    if (rowShort && rowShort.payload) result = JSON.parse(rowShort.payload);
                }
            }
        } catch (e) { console.error("D1 Screen State Read Error:", e); }
    }

    // 2. 内存读取
    if (!result) {
        result = screenStates.get(roomId) || null;
        if (!result && roomId.includes("/")) {
            const shortId = roomId.split("/").pop();
            result = shortId ? (screenStates.get(shortId) || null) : null;
        }
    }

    return result;
}

async function clearScreenState(roomId, env) {
    if (env && env.CHAT_DB) {
        try {
            await env.CHAT_DB.prepare("DELETE FROM screen_states WHERE room_id = ?").bind(roomId).run();
            if (roomId.includes("/")) {
                const shortId = roomId.split("/").pop();
                if (shortId) await env.CHAT_DB.prepare("DELETE FROM screen_states WHERE room_id = ?").bind(shortId).run();
            }
        } catch (e) {}
    }

    screenStates.delete(roomId);
    if (roomId.includes("/")) {
        const shortId = roomId.split("/").pop();
        if (shortId && shortId !== roomId) screenStates.delete(shortId);
    }
}

function sanitizeFileName(name) {
    return (name || "upload.bin").replace(/[\/\\:*?"<>|]/g, "_");
}

function getFileExt(name) {
    const m = /\.([a-zA-Z0-9]+)$/.exec(name || "");
    return m ? m[1].toLowerCase() : "";
}

function buildAutoScreenState(roomId, fileName, fileUrl, origin) {
    const ext = getFileExt(fileName);
    const imageExts = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg"]);
    const videoExts = new Set(["mp4", "webm", "ogg", "mov", "avi", "mkv"]);
    const officeExts = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx"]);

    if (imageExts.has(ext)) {
        return { roomId, type: "image", url: fileUrl, fit: "contain", title: fileName, ts: Date.now() };
    }
    if (videoExts.has(ext)) {
        return { roomId, type: "video", url: fileUrl, fit: "contain", title: fileName, ts: Date.now() };
    }
    if (ext === "pdf") {
        return { roomId, type: "pdf", url: fileUrl, title: fileName, ts: Date.now() };
    }
    if (officeExts.has(ext)) {
        const b64 = btoa(fileUrl);
        const previewUrl = `${origin}/api/kkfileview/onlinePreview?url=${encodeURIComponent(b64)}&fullfilename=${encodeURIComponent(fileName)}`;
        return { roomId, type: "doc", url: previewUrl, title: fileName, ts: Date.now() };
    }
    return { roomId, type: "text", text: `已上传文件: ${fileName}\n${fileUrl}`, title: fileName, ts: Date.now() };
}

async function handleScreenUploadDisplay(request, env) {
    const url = new URL(request.url);
    const rawName = url.searchParams.get("filename") || request.headers.get("x-filename") || "upload.bin";
    const safeName = sanitizeFileName(rawName);
    const roomId = await resolveScreenRoomId(url.searchParams.get("roomId"), env);
    const bodyBuffer = await request.arrayBuffer();
    if (!bodyBuffer || bodyBuffer.byteLength === 0) {
        return new Response(JSON.stringify({ error: "Empty body" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
    }

    const uploadPath = '/.screen_uploads/' + Date.now() + '_' + safeName;
    const fullWebdavPath = CONFIG.WEBDAV.URL + uploadPath.slice(1);
    try {
        await fetch(CONFIG.WEBDAV.URL + '.screen_uploads/', { method: 'MKCOL', headers: { 'Authorization': getAuthHeader() } });
    } catch (e) {}

    const uploadResp = await fetch(fullWebdavPath, {
        method: 'PUT',
        headers: { 'Authorization': getAuthHeader(), 'Content-Length': bodyBuffer.byteLength.toString() },
        body: bodyBuffer
    });
    if (!uploadResp.ok) {
        return new Response(JSON.stringify({ error: 'Upload failed', status: uploadResp.status }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
    }

    const fileUrl = `/api/file-proxy/${encodeURIComponent(safeName)}?path=${encodeURIComponent(uploadPath)}&token=${CONFIG.PREVIEW_TOKEN}`;
    const state = buildAutoScreenState(roomId, safeName, fileUrl, url.origin);
    await saveScreenState(roomId, state, env);
    return new Response(JSON.stringify({ success: true, roomId, path: uploadPath, fileUrl, state }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}
// ========== End Remote Screen Push API ==========

// ========== Chat File Upload (Anonymous) ==========
async function handleChatUpload(request) {
    const url = new URL(request.url);
    const filename = url.searchParams.get('filename');
    if (!filename) return new Response(JSON.stringify({ error: 'Missing filename' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });

    // Sanitize filename to prevent path traversal
    const safeName = filename.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff\u3400-\u4dbf]/g, '_');
    const uploadPath = '/.chat_uploads/' + Date.now() + '_' + safeName;
    const fullWebdavPath = CONFIG.WEBDAV.URL + uploadPath.slice(1); // remove leading /

    const bodyBuffer = await request.arrayBuffer();

    // Ensure the directory exists first
    try {
        await fetch(CONFIG.WEBDAV.URL + '.chat_uploads/', { method: 'MKCOL', headers: { 'Authorization': getAuthHeader() } });
    } catch(e) {}

    const response = await fetch(fullWebdavPath, {
        method: 'PUT',
        headers: { 'Authorization': getAuthHeader(), 'Content-Length': bodyBuffer.byteLength.toString() },
        body: bodyBuffer
    });

    if (!response.ok) {
        return new Response(JSON.stringify({ error: 'Upload failed', status: response.status }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
    }

    // Return the file-proxy URL for accessing the file
    const fileUrl = `/api/file-proxy/${encodeURIComponent(safeName)}?path=${encodeURIComponent(uploadPath)}&token=${CONFIG.PREVIEW_TOKEN}`;
    return new Response(JSON.stringify({ success: true, url: fileUrl, path: uploadPath }), { headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
}
// ========== End Chat File Upload ==========

function getAuthHeader() { 
    return "Basic " + btoa(CONFIG.WEBDAV.USER + ":" + CONFIG.WEBDAV.PASS); 
}

function corsHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, COPY, MOVE, OPTIONS, PROPFIND, MKCOL",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Depth, Destination, Overwrite",
        "Access-Control-Allow-Credentials": "true"
    };
}

async function getUserDb() {
    try {
        const res = await fetch(CONFIG.WEBDAV.URL + '.sys_users.json', { headers: { "Authorization": getAuthHeader() } });
        if (res.ok) return await res.json();
    } catch(e) {}
    return { users: {} };
}

async function saveUserDb(db) {
    await fetch(CONFIG.WEBDAV.URL + '.sys_users.json', {
        method: 'PUT',
        headers: { "Authorization": getAuthHeader(), "Content-Type": "application/json" },
        body: JSON.stringify(db)
    });
}

async function getAuthContext(request) {
    const cookie = request.headers.get("Cookie") || "";
    const match = cookie.match(/auth_token_ppt=([^;]+)/);
    let tokenStr = match ? match[1] : null;

    if (!tokenStr) {
        const url = new URL(request.url);
        tokenStr = url.searchParams.get("token");
    }

    if (!tokenStr) return null;

    try {
        const decoded = decodeURIComponent(tokenStr);
        if (decoded === '576257') return { role: 'admin', username: 'admin' };
        
        // Guest logic
        if (decoded.startsWith('guest::')) {
            const username = decoded.replace('guest::', '');
            return { role: 'guest', username, storagePath: `/.users/_temp_${username}` };
        }

        const parts = decoded.split('::');
        if (parts.length === 2) {
            const username = parts[0];
            const pass = parts[1];
            const db = await getUserDb();
            if (db.users[username] && db.users[username].password === pass) {
                return { role: 'user', username, storagePath: `/.users/${username}` };
            }
        }
    } catch(e) {}
    return null;
}

function getIsolatedPath(path, auth) {
    if (!auth) return null;
    if (auth.role === 'admin') return path || "";
    const prefix = auth.storagePath || `/.users/${auth.username}`;
    const cleanPath = (path && path !== '/') ? (path.startsWith('/') ? path : '/' + path) : "";
    return `${prefix}${cleanPath}`;
}

function hasFixedAdminKey(request, env) {
    const key = request.headers.get("x-admin-key")
        || request.headers.get("x-api-key")
        || new URL(request.url).searchParams.get("admin_key");
    const expected = (env && env.ADMIN_FIXED_KEY) || CONFIG.ADMIN_FIXED_KEY;
    return !!(key && expected && key === expected);
}

function isAdminRequestAuthorized(request, auth, env) {
    return (auth && auth.role === "admin") || hasFixedAdminKey(request, env);
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders() });
        }

        try {
            if (url.pathname.startsWith("/api/file-proxy")) return await handleFileProxy(request, ctx);
            if (url.pathname.startsWith("/api/kkfileview")) return await handleKKProxy(request, ctx);

            // HTTP Chat endpoints (no auth required for chat participation)
            if (url.pathname === "/api/chat/send" && request.method === "POST") return await handleChatSend(request, env);
            if (url.pathname === "/api/chat/poll") return await handleChatPoll(request, env);
            if (url.pathname === "/api/chat/heartbeat" && request.method === "POST") return await handleChatHeartbeat(request, env);
            if (url.pathname === "/api/chat/upload" && request.method === "POST") return await handleChatUpload(request);
                if (url.pathname === "/api/screen/state" && request.method === "GET") return await handleScreenStateGet(request, env);
                if (url.pathname === "/api/screen/render-ack" && request.method === "POST") return await handleScreenRenderAck(request, env);
                if (url.pathname === "/api/screen/self-heal" && request.method === "POST") return await handleScreenSelfHeal(request, env);
                if (url.pathname === "/api/screen/active-room") {
                    if (request.method === "POST") return await handleScreenActiveRoomReport(request, env);
                    if (request.method === "GET") return await handleScreenActiveRoomGet(env);
                    return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders() } });
                }

            if (url.pathname === "/api/login") return await handleLogin(request);
            if (url.pathname === "/api/register") return await handleRegister(request);
            if (url.pathname === "/api/logout") {
                return new Response(JSON.stringify({ success: true }), {
                    headers: {
                        "Content-Type": "application/json",
                        "Set-Cookie": "auth_token_ppt=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax",
                        ...corsHeaders()
                    }
                });
            }

            if (url.pathname === "/api/get_user") {
                const auth = await getAuthContext(request);
                return new Response(JSON.stringify(auth || { role: 'guest' }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
            }

            if (url.pathname.startsWith("/api/")) {
                const auth = await getAuthContext(request);
                const isAdminApi = url.pathname.startsWith("/api/admin/");
                if (!auth && !isAdminApi) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders() } });

                if (url.pathname === "/api/list") return await handleList(request, auth);
                if (url.pathname === "/api/upload") return await handleUpload(request, ctx, auth);
                if (url.pathname === "/api/download") return await handleDownload(request, auth);
                if (url.pathname === "/api/delete") return await handleDelete(request, auth);
                if (url.pathname === "/api/mkdir") return await handleMkdir(request, auth);
                if (url.pathname === "/api/move") return await handleMove(request, auth);
                if (url.pathname === "/api/copy") return await handleCopy(request, auth);
                if (url.pathname === "/api/create-link") return await handleCreateLink(request, auth);
                if (url.pathname === "/api/create-bili-topic") return await handleCreateBiliTopic(request, ctx, auth);
                if (url.pathname === "/api/admin/command") {
                    if (!isAdminRequestAuthorized(request, auth, env)) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders() } });
                    if (request.method === "POST") return await handleAdminCommandPush(request);
                    if (request.method === "GET") return await handleAdminCommandPoll(request);
                    return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders() } });
                }
                if (url.pathname === "/api/admin/state") {
                    if (!isAdminRequestAuthorized(request, auth, env)) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders() } });
                    if (request.method === "POST") return await handleAdminStateSet(request);
                    if (request.method === "GET") return await handleAdminStateGet(request);
                    return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders() } });
                }
                if (url.pathname === "/api/admin/screen/push") {
                    if (!isAdminRequestAuthorized(request, auth, env)) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders() } });
                    if (request.method === "POST") return await handleScreenPush(request, env);
                    return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders() } });
                }
                if (url.pathname === "/api/admin/screen/upload-display") {
                    if (!isAdminRequestAuthorized(request, auth, env)) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders() } });
                    if (request.method === "POST") return await handleScreenUploadDisplay(request, env);
                    return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders() } });
                }
                if (url.pathname === "/api/admin/screen/clear") {
                    if (!isAdminRequestAuthorized(request, auth, env)) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders() } });
                    if (request.method === "POST") return await handleScreenClear(request, env);
                    return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders() } });
                }
                if (url.pathname === "/api/admin/screen/health") {
                    if (!isAdminRequestAuthorized(request, auth, env)) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json", ...corsHeaders() } });
                    if (request.method === "GET") return await handleAdminScreenHealth(request, env);
                    return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers: { "Content-Type": "application/json", ...corsHeaders() } });
                }
                
                if (url.pathname === '/api/admin/users') {
                    if (!isAdminRequestAuthorized(request, auth, env)) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
                    if (request.method === 'GET') {
                        const db = await getUserDb();
                        const list = Object.entries(db.users).map(([name, info]) => ({
                            username: name,
                            created: info.created,
                            fileCount: info.fileCount || 0
                        }));
                        return new Response(JSON.stringify({ success: true, users: list }), { headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
                    }
                    if (request.method === 'DELETE') {
                        const username = url.searchParams.get('username');
                        if (!username || username === 'admin') return new Response(JSON.stringify({ error: 'Invalid' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
                        const db = await getUserDb();
                        delete db.users[username];
                        await saveUserDb(db);
                        // 同时删除 WebDAV 上的用户目录
                        await fetch(CONFIG.WEBDAV.URL + '.users/' + username + '/', { method: 'DELETE', headers: { 'Authorization': getAuthHeader() } });
                        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
                    }
                }

                return new Response(JSON.stringify({ error: "Unknown API endpoint" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders() } });

            }

            if (env.ASSETS) {
                const response = await env.ASSETS.fetch(request);
                if (response) return response;
            }
            
            return new Response("Not Found", { status: 404 });

        } catch (e) {
            return new Response(JSON.stringify({ error: e.message }), {
                status: 500,
                headers: { "Content-Type": "application/json", ...corsHeaders() }
            });
        }
    }
};

async function handleRegister(request) {
    if(request.method !== 'POST') return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
    const { username, password } = await request.json();
    if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) return new Response(JSON.stringify({ success: false, error: "Invalid username" }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });

    const db = await getUserDb();
    if (db.users[username]) return new Response(JSON.stringify({ success: false, error: "User exists" }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });

    db.users[username] = { password: btoa(password), fileCount: 0, created: Date.now() };
    await saveUserDb(db);
    
    await fetch(CONFIG.WEBDAV.URL + '.users/' + username + '/', { method: "MKCOL", headers: { "Authorization": getAuthHeader() } });

    const token = encodeURIComponent(`${username}::${btoa(password)}`);
    return new Response(JSON.stringify({ success: true, username: username, storagePath: `/.users/${username}` }), { 
        headers: { 
            "Content-Type": "application/json", 
            "Set-Cookie": `auth_token_ppt=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
            ...corsHeaders() 
        } 
    });
}

async function handleLogin(request) {
    if(request.method !== 'POST') return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return new Response(JSON.stringify({ success: false, error: "Malformed request body" }), { 
            status: 400, 
            headers: { "Content-Type": "application/json", ...corsHeaders() } 
        });
    }
    const { username, password } = body;
    let token = "";
    let storagePath = "/";
    if (password === '576257' && (!username || username === 'admin')) {
        token = "576257";
    } else {
        if (body.isGuest && body.username) {
            const guestToken = `guest::${body.username}`;
            return new Response(JSON.stringify({ success: true, username: body.username, storagePath: `/.users/_temp_${body.username}` }), {
                headers: {
                    'Content-Type': 'application/json',
                    'Set-Cookie': `auth_token_ppt=${encodeURIComponent(guestToken)}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`,
                    ...corsHeaders()
                }
            });
        }

        if (!body.username || !body.password) {
            return new Response(JSON.stringify({ success: false, error: "Username and password are required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() } });
        }

        const db = await getUserDb();
        if (!db.users[username] || db.users[username].password !== btoa(password)) {
            return new Response(JSON.stringify({ success: false, error: "Auth failed" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders() } });
        }
        token = encodeURIComponent(`${username}::${btoa(password)}`);
        storagePath = `/.users/${username}`;
    }

    return new Response(JSON.stringify({ success: true, username: (password === '576257') ? 'admin' : username, storagePath: storagePath }), {
        headers: {
            "Content-Type": "application/json",
            "Set-Cookie": `auth_token_ppt=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
            ...corsHeaders()
        }
    });
}

async function handleList(request, auth) {
    const url = new URL(request.url);
    const dir = url.searchParams.get("path") || "";
    const actualPath = getIsolatedPath(dir, auth);

    const response = await fetch(CONFIG.WEBDAV.URL + actualPath, {
        method: "PROPFIND",
        headers: { "Authorization": getAuthHeader(), "Depth": "1" }
    });

    let text = await response.text();
    text = text.replace(/<D:response>[\s\S]*?<D:href>[^<]*\/\.[^<]*<\/D:href>[\s\S]*?<\/D:response>/g, '');
    return new Response(text, { headers: { "Content-Type": "application/xml", ...corsHeaders() } });
}

async function handleUpload(request, ctx, auth) {
    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    const actualPath = getIsolatedPath(path, auth);

    // 修复上传块传输和0字节的问题，将 body 读成完整流并主动附带大小
    const bodyBuffer = await request.arrayBuffer();

    let response = await fetch(CONFIG.WEBDAV.URL + actualPath, {
        method: "PUT",
        headers: { 
            "Authorization": getAuthHeader(),
            "Content-Length": bodyBuffer.byteLength.toString()
        },
        body: bodyBuffer
    });

    // 修复：InfiniCloud 如果父目录不存在，返回的可能是 403 或 409。必须捕获 403。
    if (response.status === 403 || response.status === 409) {
        const parentDir = getIsolatedPath("", auth);
        if (parentDir && parentDir !== "/") {
            // 注意：网盘创建目录必须以 / 结尾
            const mkcolUrl = CONFIG.WEBDAV.URL + parentDir + (parentDir.endsWith('/') ? '' : '/');
            await fetch(mkcolUrl, {
                method: "MKCOL",
                headers: { "Authorization": getAuthHeader() }
            });
            // 再试一次
            response = await fetch(CONFIG.WEBDAV.URL + actualPath, {
                method: "PUT",
                headers: { 
                    "Authorization": getAuthHeader(),
                    "Content-Length": bodyBuffer.byteLength.toString()
                },
                body: bodyBuffer
            });
        }
    }

    if (response.ok) {
        const ext = path.split('.').pop().toLowerCase();
        if (['ppt', 'pptx', 'doc', 'docx'].includes(ext)) {
            const filename = path.split('/').pop();
            const publicUrl = `${url.origin}/api/file-proxy/${encodeURIComponent(filename)}?path=${encodeURIComponent(actualPath)}&token=${CONFIG.PREVIEW_TOKEN}`;
            const webhookUrl = "https://shadow-worker.beundredig.eu.org/convert";

            const task = fetch(webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename: filename, path: actualPath, publicUrl: publicUrl })
            }).then(res => console.log(`[Shadow] Trigger: ${res.status}`)).catch(e => console.error(e));

            if (ctx && ctx.waitUntil) ctx.waitUntil(task);
        }
    }

    // 如果依旧失败，必须把真实的错误 HTTP Status 发回给前端，避免前端误以为成功
    return new Response(JSON.stringify({ success: response.ok }), { 
        status: response.ok ? 200 : response.status,
        headers: { "Content-Type": "application/json", ...corsHeaders() } 
    });
}

async function handleDownload(request, auth) {
    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    const actualPath = getIsolatedPath(path, auth);
    const isInline = url.searchParams.get("inline") === "true";
    
    const response = await fetch(CONFIG.WEBDAV.URL + actualPath, { method: "GET", headers: { "Authorization": getAuthHeader() } });
    const filename = path.split('/').pop();
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    if (!isInline) headers.set("Content-Disposition", `attachment; filename="${filename}"`);

    return new Response(response.body, { headers: headers });
}

async function handleDelete(request, auth) {
    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    const actualPath = getIsolatedPath(path, auth);
    const response = await fetch(CONFIG.WEBDAV.URL + actualPath, { method: "DELETE", headers: { "Authorization": getAuthHeader() } });
    return new Response(JSON.stringify({ success: response.ok }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function handleMkdir(request, auth) {
    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    const actualPath = getIsolatedPath(path, auth);
    const fullPath = CONFIG.WEBDAV.URL + actualPath + (actualPath.endsWith('/') ? '' : '/');
    const response = await fetch(fullPath, { method: "MKCOL", headers: { "Authorization": getAuthHeader() } });
    return new Response(JSON.stringify({ success: response.ok || response.status === 405 }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function handleMove(request, auth) {
    const url = new URL(request.url);
    const source = getIsolatedPath(url.searchParams.get("source"), auth);
    const dest = getIsolatedPath(url.searchParams.get("dest"), auth);
    const response = await fetch(CONFIG.WEBDAV.URL + source, {
        method: "MOVE",
        headers: { "Authorization": getAuthHeader(), "Destination": CONFIG.WEBDAV.URL + dest, "Overwrite": "T" }
    });
    return new Response(JSON.stringify({ success: response.ok }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function handleCopy(request, auth) {
    const url = new URL(request.url);
    const source = getIsolatedPath(url.searchParams.get("source"), auth);
    const dest = getIsolatedPath(url.searchParams.get("dest"), auth);
    const response = await fetch(CONFIG.WEBDAV.URL + source, {
        method: "COPY",
        headers: { "Authorization": getAuthHeader(), "Destination": CONFIG.WEBDAV.URL + dest, "Overwrite": "T" }
    });
    return new Response(JSON.stringify({ success: response.ok }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function handleCreateLink(request, auth) {
    const url = new URL(request.url);
    const path = getIsolatedPath(url.searchParams.get("path"), auth);
    const targetUrl = await request.text();
    const response = await fetch(CONFIG.WEBDAV.URL + path, {
        method: "PUT", headers: { "Authorization": getAuthHeader(), "Content-Type": "text/plain" }, body: targetUrl
    });
    return new Response(JSON.stringify({ success: response.ok }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function handleCreateBiliTopic(request, ctx, auth) {
    const body = await request.json();
    const { name, url, currentDir } = body;
    const bvid = url.match(/BV[a-zA-Z0-9]+/) ? url.match(/BV[a-zA-Z0-9]+/)[0] : null;
    if (!bvid) return new Response("Invalid Bvid", { status: 400 });

    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: { 'User-Agent': userAgent, 'Referer': 'https://www.bilibili.com/' } });
    const biliData = await res.json();
    if (!biliData || biliData.code !== 0) return new Response("Bilibili Error", { status: 500 });
    
    const pages = biliData.data?.pages || [];
    const folderPath = currentDir ? `${currentDir}/${name}` : name;
    const actualFolderPath = getIsolatedPath(folderPath, auth);
    await fetch(CONFIG.WEBDAV.URL + actualFolderPath + "/", { method: "MKCOL", headers: { "Authorization": getAuthHeader() } });

    for (const p of pages) {
        const fileName = `${String(p.page).padStart(2, '0')}_${p.part.replace(/[\\\\/:*?"<>|]/g, '_')}.url`;
        const filePath = `${actualFolderPath}/${fileName}`;
        const targetUrl = `https://www.bilibili.com/video/${bvid}?p=${p.page}`;
        await fetch(CONFIG.WEBDAV.URL + filePath, {
            method: "PUT", headers: { "Authorization": getAuthHeader(), "Content-Type": "text/plain" }, body: `[InternetShortcut]\nURL=${targetUrl}`
        });
    }
    return new Response(JSON.stringify({ success: true, count: pages.length }), { headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

async function handleKKProxy(request, ctx) {
    const url = new URL(request.url);
    const KKFILEVIEW_SERVER = "http://vps1.beundredig.eu.org:8012";
    const targetPath = url.pathname.replace("/api/kkfileview", "");
    const targetUrl = KKFILEVIEW_SERVER + targetPath + url.search;
    
    try {
        const response = await fetch(targetUrl, { 
            method: request.method, 
            headers: request.headers, 
            body: request.method !== 'GET' ? request.body : undefined 
        });

        const contentType = response.headers.get("content-type") || "";
        const isText = contentType.includes("text") || contentType.includes("javascript") || contentType.includes("json");

        // 构建新的响应头，确保保留原始 Content-Type
        const newHeaders = new Headers(response.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        
        if (isText) {
            let bodyText = await response.text();
            // 将原始 KKFILEVIEW_SERVER 替换为我们的代理地址，实现“全量透传”
            bodyText = bodyText.replaceAll(KKFILEVIEW_SERVER, url.origin + "/api/kkfileview");
            return new Response(bodyText, { status: response.status, headers: newHeaders });
        } else {
            // 二进制数据直接透传
            return new Response(response.body, { status: response.status, headers: newHeaders });
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: "kk proxy error: " + e.message }), { 
            status: 500, 
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } 
        });
    }
}

async function handleFileProxy(request, ctx) {
    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    const token = url.searchParams.get("token");
    if (token !== CONFIG.PREVIEW_TOKEN) return new Response("Unauthorized", { status: 401 });
    
    let cleanPath = path.replace(/\/+/g, '/');
    if (cleanPath.startsWith('/')) cleanPath = cleanPath.slice(1);
    
    // Check if WEBDAV.URL already ends with /
    const baseUrl = CONFIG.WEBDAV.URL.endsWith('/') ? CONFIG.WEBDAV.URL : CONFIG.WEBDAV.URL + '/';
    
    const response = await fetch(baseUrl + cleanPath, { method: "GET", headers: { "Authorization": getAuthHeader() } });
    
    if (!response.ok) {
        return new Response("File not found or access denied: " + response.status, { status: response.status, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    
    const filename = path.split('/').pop();
    const ext = filename.split('.').pop().toLowerCase();
    const mimeMap = { 'pdf': 'application/pdf', 'ppt': 'application/vnd.ms-powerpoint', 'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
    return new Response(response.body, { headers: { "Content-Type": mimeMap[ext] || "application/octet-stream", "Access-Control-Allow-Origin": "*" } });
}
