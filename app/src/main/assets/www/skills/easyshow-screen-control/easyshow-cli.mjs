#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";

const DEFAULT_BASE = process.env.EASYSHOW_BASE_URL || "https://easyshow.beundredig.eu.org";
const DEFAULT_KEY = process.env.EASYSHOW_ADMIN_KEY || "easyshow-admin-fixed-key-2026";

function printHelp() {
  console.log(`easyshow-cli

Usage:
  node skills/easyshow-screen-control/easyshow-cli.mjs push --type <text|image|video|html|svg|bilibili|youtube|pdf> [--url ...] [--allow-control] [--room ...]
  node skills/easyshow-screen-control/easyshow-cli.mjs upload --file <path> [--room ...]
  node skills/easyshow-screen-control/easyshow-cli.mjs playlist --file <manifest.json> --index <0-based> [--room ...]
  node skills/easyshow-screen-control/easyshow-cli.mjs clear [--room ...]
  node skills/easyshow-screen-control/easyshow-cli.mjs state [--room ...]
  node skills/easyshow-screen-control/easyshow-cli.mjs doctor [--room ...] [--push]
  node skills/easyshow-screen-control/easyshow-cli.mjs health [--room ...] [--stale-sec 10] [--heal]
  node skills/easyshow-screen-control/easyshow-cli.mjs self-heal [--room ...]

Playlist manifest (JSON array):
  [{"type":"bilibili","url":"https://...","name":"item1"},{"type":"pdf","url":"/api/...","name":"item2"}]

Options:
  --base <url>       API base URL (default: ${DEFAULT_BASE})
  --key <key>        Admin key (default from EASYSHOW_ADMIN_KEY or built-in)
  --room <roomId>    Room id (default: PPT002)
  --fit <contain|cover>
  --push            For doctor only: actively push a marker to screen (default off)
  --safe-inline      Allow non-ASCII inline text/content (otherwise must use --text-file/--content-file)
  --unicode-safe     Convert non-ASCII to \\uXXXX before push (anti-garbled)
`);
}

function toUnicodeSafe(input) {
  return String(input || "").replace(/[^\x00-\x7F]/g, (ch) =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

function toBase64Utf8(input) {
  return Buffer.from(String(input || ""), "utf8").toString("base64");
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input || ""), "utf8").digest("hex");
}

function hasNonAscii(input) {
  return /[^\x00-\x7F]/.test(String(input || ""));
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function apiFetch(path, { method = "GET", base, key, body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "x-admin-key": key,
      ...headers
    },
    body
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const base = (args.base || DEFAULT_BASE).replace(/\/+$/, "");
  const key = args.key || DEFAULT_KEY;
  const roomId = args.room;

  if (cmd === "push") {
    const autoVideoUrl = args["video-url"] || "";
    const inferredType = autoVideoUrl ? "html" : "";
    const type = args.type || inferredType;
    if (!type) throw new Error("push requires --type (or use --video-url for auto bili/youtube)");
    const textFromFile = args["text-file"] ? fs.readFileSync(args["text-file"], "utf8") : "";
    const contentFromFile = args["content-file"] ? fs.readFileSync(args["content-file"], "utf8") : "";
    const inlineText = args.text || "";
    const inlineContent = args.content || "";
    const allowSafeInline = !!args["safe-inline"];
    if (!textFromFile && hasNonAscii(inlineText) && !allowSafeInline) {
      throw new Error("Non-ASCII inline --text is blocked. Use --text-file (recommended) or add --safe-inline.");
    }
    if (!contentFromFile && hasNonAscii(inlineContent) && !allowSafeInline) {
      throw new Error("Non-ASCII inline --content is blocked. Use --content-file (recommended) or add --safe-inline.");
    }
    let pushText = textFromFile || args.text || "";
    let pushContent = contentFromFile || args.content || "";
    // 当 --type html/iframe + --url 时，自动构建 iframe 内容（worker 会清空 url 字段）
    if ((type === "html" || type === "iframe") && args.url && !pushContent) {
      pushContent = `<iframe src="${args.url}" style="width:100%;height:100%;border:none;" allow="autoplay; fullscreen" allowfullscreen></iframe>`;
    }
    if (args["unicode-safe"]) {
      pushText = toUnicodeSafe(pushText);
      pushContent = toUnicodeSafe(pushContent);
    }
    const payload = {
      roomId,
      type,
      text: pushText,
      text_b64: toBase64Utf8(pushText),
      text_sha256: sha256Hex(pushText),
      url: args.url || autoVideoUrl || "",
      content: pushContent,
      content_b64: toBase64Utf8(pushContent),
      content_sha256: sha256Hex(pushContent),
      fit: args.fit || "contain",
      source: "agent",
      viewerControlEnabled: !!(args["allow-control"] || args.c)
    };
    if (autoVideoUrl) payload.videoUrl = autoVideoUrl;
    if (args["bili-url"]) payload.bilibiliUrl = args["bili-url"];
    if (args["yt-url"]) payload.youtubeUrl = args["yt-url"];
    const data = await apiFetch("/api/admin/screen/push", {
      method: "POST",
      base,
      key,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (cmd === "clear") {
    const data = await apiFetch("/api/admin/screen/clear", {
      method: "POST",
      base,
      key,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId })
    });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (cmd === "state") {
    const qs = roomId ? `?roomId=${encodeURIComponent(roomId)}` : "";
    const res = await fetch(`${base}/api/screen/state${qs}`);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (cmd === "upload") {
    // === Admin Upload Channel ===
    // Upload to agent-show/ folder (real WebDAV, same as admin UI)
    // then push to screen using the correct type — replicates admin "演示" double-click.
    const file = args.file;
    if (!file) throw new Error("upload requires --file");
    const ADMIN_TOKEN = process.env.EASYSHOW_ADMIN_TOKEN || "576257";
    const PREVIEW_TOKEN = "Allow_Public_Preview_Access_2025";
    const folder = args.folder || "agent-show";
    const filename = (args.filename || file.split(/[\\/]/).pop()).replace(/[\\/:*?"<>|]/g, "_");
    const remotePath = `${folder}/${filename}`;

    // Step 1: ensure folder exists
    await fetch(`${base}/api/mkdir?path=${encodeURIComponent(folder)}&token=${ADMIN_TOKEN}`, {
      headers: { Cookie: `auth_token_ppt=${ADMIN_TOKEN}` }
    });

    // Step 2: upload file to WebDAV folder
    const bytes = fs.readFileSync(file);
    const upRes = await fetch(`${base}/api/upload?path=${encodeURIComponent(remotePath)}&token=${ADMIN_TOKEN}`, {
      method: "POST",
      headers: { Cookie: `auth_token_ppt=${ADMIN_TOKEN}`, "Content-Type": "application/octet-stream" },
      body: bytes
    });
    const upData = await upRes.json();
    if (!upData.success) throw new Error(`Upload failed: ${JSON.stringify(upData)}`);
    console.log(`✓ Uploaded → ${remotePath}`);

    // Step 3: build file-proxy URL (same as admin uses)
    const ext = filename.split(".").pop().toLowerCase();
    const fileProxyUrl = `/api/file-proxy/${encodeURIComponent(filename)}?path=${encodeURIComponent("/" + remotePath)}&token=${PREVIEW_TOKEN}`;
    const PREVIEW_BASE = `${base}${fileProxyUrl}`;

    // Step 4: determine content type (same logic as admin buildAutoScreenState)
    const officeExts = new Set(["doc","docx","xls","xlsx","ppt","pptx"]);
    const videoExts  = new Set(["mp4","webm","ogg","mov","avi","mkv"]);
    const audioExts  = new Set(["mp3","aac","wav","flac","ogg","m4a"]);
    const imageExts  = new Set(["jpg","jpeg","png","gif","bmp","webp","svg"]);

    let pushType = "image";
    let pushUrl  = fileProxyUrl;
    if (ext === "pdf")             { pushType = "pdf"; }
    else if (officeExts.has(ext))  { pushType = "doc"; pushUrl = `${base}/api/kkfileview/onlinePreview?url=${encodeURIComponent(Buffer.from(PREVIEW_BASE).toString("base64"))}&fullfilename=${encodeURIComponent(filename)}`; }
    else if (videoExts.has(ext))   { pushType = "video"; }
    else if (audioExts.has(ext))   { pushType = "video"; }  // audio → video player
    else if (imageExts.has(ext))   { pushType = "image"; }

    // Step 5: push to screen — complete admin 演示 flow
    const payload = {
      roomId,
      type: pushType,
      url: pushUrl,
      title: filename,
      fit: args.fit || "contain",
      source: "agent",
      viewerControlEnabled: !!(args["allow-control"])
    };
    const pushRes = await apiFetch("/api/admin/screen/push", {
      method: "POST", base, key,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    console.log(JSON.stringify({ uploaded: remotePath, type: pushType, url: pushUrl, push: pushRes }, null, 2));
    return;
  }

  if (cmd === "doctor") {
    const pushMode = !!args.push;
    let targetRoom = roomId || "";
    if (!targetRoom) {
      const active = await apiFetch("/api/screen/active-room", { method: "GET", base, key });
      targetRoom = active && active.activeRoom ? active.activeRoom.roomId : "";
    }
    if (!targetRoom) {
      throw new Error("roomId is empty. Use --room or open remote page once to report active room.");
    }

    const marker = `doctor-${Date.now()}`;
    if (pushMode) {
      await apiFetch("/api/admin/screen/push", {
        method: "POST",
        base,
        key,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: targetRoom, type: "text", text: marker })
      });
    }

    const state = await apiFetch(`/api/screen/state?roomId=${encodeURIComponent(targetRoom)}`, {
      method: "GET",
      base,
      key
    });
    const ok = pushMode ? (state && state.state && state.state.text === marker) : true;
    console.log(JSON.stringify({
      success: !!ok,
      mode: pushMode ? "push" : "read-only",
      roomId: targetRoom,
      marker: pushMode ? marker : null,
      state: state.state || null
    }, null, 2));
    if (!ok) process.exit(2);
    return;
  }

  if (cmd === "health") {
    const staleSec = Number(args["stale-sec"] || 10);
    const qs = new URLSearchParams();
    if (roomId) qs.set("roomId", roomId);
    qs.set("staleSec", String(staleSec));
    if (args.heal) qs.set("autoHeal", "1");
    const data = await apiFetch(`/api/admin/screen/health?${qs.toString()}`, {
      method: "GET",
      base,
      key
    });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (cmd === "self-heal") {
    const qs = new URLSearchParams();
    if (roomId) qs.set("roomId", roomId);
    const data = await apiFetch(`/api/screen/self-heal?${qs.toString()}`, {
      method: "POST",
      base,
      key
    });
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (cmd === "bili-search") {
    const keyword = args.keyword || args.q || args._[1];
    if (!keyword) throw new Error("bili-search requires --keyword \"歌名 歌手\"");
    const topN = Number(args.top || 1); // --top 3 选第3热门
    const catId = args.cat || "3"; // 默认音乐分区 tid=3

    console.log(`🔍 搜索 Bilibili：${keyword} (音乐分区，按热度排序)`);

    // Bilibili 搜索 API：按综合热度 + 音乐分区
    const searchUrl = `https://api.bilibili.com/x/web-interface/search/type?` +
      `search_type=video&keyword=${encodeURIComponent(keyword)}&order=totalrank&tids=${catId}&page=1`;

    const searchRes = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": "https://www.bilibili.com/",
        "Origin": "https://www.bilibili.com",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Cookie": `buvid3=${crypto.randomUUID()}; SESSDATA=; bili_jct=`
      }
    });
    if (!searchRes.ok) throw new Error(`Bilibili API HTTP ${searchRes.status}`);
    const searchData = await searchRes.json();

    const videos = searchData?.data?.result || [];
    if (videos.length === 0) throw new Error(`未找到"${keyword}"相关视频`);

    // 综合热度 = 收藏×3 + 弹幕×2 + 播放×1（归一化防止播放量碾压）
    const scored = videos.map(v => ({
      bvid: v.bvid,
      title: (v.title || "").replace(/<[^>]+>/g, ""),
      author: v.author,
      play: v.play || 0,
      favorites: v.favorites || 0,
      danmaku: v.video_review || 0,
      score: (v.favorites || 0) * 3 + (v.video_review || 0) * 2 + Math.min(v.play || 0, 5000000)
    })).sort((a, b) => b.score - a.score);

    // 显示 top 5 候选
    console.log("\n🎵 热度 Top 5：");
    scored.slice(0, 5).forEach((v, i) => {
      console.log(`  ${i + 1}. [${v.bvid}] ${v.title}`);
      console.log(`     👤 ${v.author}  ▶️ ${v.play.toLocaleString()}  ⭐ ${v.favorites.toLocaleString()}  💬 ${v.danmaku.toLocaleString()}`);
    });

    const pick = scored[topN - 1];
    if (!pick) throw new Error(`--top ${topN} 超出结果数量`);
    console.log(`\n✅ 选择 #${topN}：${pick.title}`);
    console.log(`   https://www.bilibili.com/video/${pick.bvid}`);

    // 构建 Bilibili 嵌入播放器
    const iframeHtml = `<iframe src="https://player.bilibili.com/player.html?bvid=${pick.bvid}&page=1&high_quality=1&danmaku=0&autoplay=1" style="width:100%;height:100%;border:0" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;

    const payload = {
      roomId,
      type: "html",
      content: iframeHtml,
      content_b64: toBase64Utf8(iframeHtml),
      content_sha256: sha256Hex(iframeHtml),
      title: pick.title,
      source: "agent"
    };

    const data = await apiFetch("/api/admin/screen/push", {
      method: "POST", base, key,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    console.log("\n🎬 已推送到大屏：", JSON.stringify({ bvid: pick.bvid, title: pick.title, result: data }, null, 2));
    return;
  }

  if (cmd === "playlist") {
    const manifestFile = args.file;
    if (!manifestFile) throw new Error("playlist requires --file <manifest.json>");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (!Array.isArray(manifest) || manifest.length === 0) throw new Error("Manifest must be a non-empty JSON array");
    const idx = Number(args.index ?? 0);
    if (idx < 0 || idx >= manifest.length) throw new Error(`--index ${idx} out of range (0-${manifest.length - 1})`);
    const item = manifest[idx];
    console.log(`▶ Playlist [${idx + 1}/${manifest.length}]: ${item.name || item.url}`);
    const payload = {
      roomId,
      type: item.type,
      url: item.url || "",
      text: item.text || "",
      content: item.content || "",
      title: item.name || "",
      fit: item.fit || args.fit || "contain",
      source: "agent",
      viewerControlEnabled: !!(item.viewerControlEnabled || args["allow-control"])
    };
    if (item.type === "bilibili") { payload.bilibiliUrl = item.url; }
    if (item.type === "youtube")  { payload.youtubeUrl  = item.url; }
    if (payload.content) {
      payload.content_b64 = toBase64Utf8(payload.content);
      payload.content_sha256 = sha256Hex(payload.content);
    }
    const data = await apiFetch("/api/admin/screen/push", {
      method: "POST", base, key,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    console.log(JSON.stringify({ index: idx, total: manifest.length, item, result: data }, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
