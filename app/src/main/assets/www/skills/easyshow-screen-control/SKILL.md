---
name: easyshow-screen-control
description: Use this skill when controlling EasyShow remote screens �?including uploading user files (PDF/Word/Excel/MP3/MP4) or directly pushing AI-generated content (SVG/HTML/text/Bilibili/YouTube) to the remote display. Also handles music/video search on Bilibili by name. Keywords: 显示/展示/推�?演示/播放/上传/清屏/下一�?上一�?切换/搜索/播放音乐/放歌.
---

# EasyShow Screen Control �?AI Agent Skill

Control the EasyShow remote screen at `https://easyshow.beundredig.eu.org`.  
**Two distinct channels** depending on content origin.

---

## Auth & Constants

| Item | Value |
|------|-------|
| Base URL | `https://easyshow.beundredig.eu.org` |
| Admin API Key | `easyshow-admin-fixed-key-2026` (Header: `x-admin-key`) |
| Admin Token | `576257` (Cookie: `auth_token_ppt`, for file upload) |
| Preview Token | `Allow_Public_Preview_Access_2025` |
| Fixed Room ID | `3eb42d69d8b226abe22024d648975f8a/PPT002` |
| Agent Folder | `agent-show/` (WebDAV, permanent storage) |
| CLI | `node ./easyshow-cli.mjs` (run from `skills/easyshow-screen-control/`) |

> [!CAUTION]
> **ROOM ID ALIAS TRAP**: If the user says their room is "admin" (or accesses `?room=admin`), DO NOT pass `--room "admin"` to the CLI. The frontend translates `admin` back to the default `3eb42d69d8b226abe22024d648975f8a/PPT002`. Always use the Fixed Room ID unless explicitly pushing to a totally isolated channel.

---

## ─── CHANNEL A: User File Upload ──────────────────────────

**For**: PDF · Word · Excel · PPT · MP4 · MP3 · Images uploaded by the user.

This channel **fully replicates the Admin "演示" double-click flow**:
1. Upload file �?`agent-show/` WebDAV folder (permanent, browseable in Admin UI)
2. Build file-proxy URL
3. Detect content type �?push to screen with the right renderer

### CLI Command
```bash
node ./easyshow-cli.mjs upload \
  --file "./slides.pdf" \
  --room "3eb42d69d8b226abe22024d648975f8a/PPT002"
```

**Auto type routing:**

| File extension | Screen type | Renderer |
|----------------|-------------|----------|
| `.pdf` | `pdf` | pdf.js built-in |
| `.doc .docx .xls .xlsx .ppt .pptx` | `doc` | KKFileView iframe |
| `.mp4 .webm .mov .avi` | `video` | HTML5 video |
| `.mp3 .aac .wav .m4a` | `video` | HTML5 audio player |
| `.jpg .png .gif .webp .svg` | `image` | Native image |

### 翻页控制 (Viewer Control)
**默认状态：所有推送内容（upload / push / playlist）默认 `vc: false`（关闭大屏翻页按钮）。**
*   **开启**：使用 `--allow-control`。适用于 PDF、PPT 等需要手动翻页的内容。
*   **示例**：
    ```bash
    node ./easyshow-cli.mjs upload --file "./slides.pdf" --allow-control
    ```

### Optional: upload to a custom subfolder
```bash
node ./easyshow-cli.mjs upload --file "./report.xlsx" --folder "agent-show/reports"
```

---

## ─── CHANNEL B: AI Direct Push ─────────────────────────────

**For**: SVG · HTML · Text · Bilibili links · YouTube links  
(AI-generated content that has no local file to upload)

### Push SVG
> [!WARNING]
> **CRITICAL**: Never push an SVG wrapped in `<!DOCTYPE html>` or `<body>`. The frontend uses `innerHTML` injection. Pushing a full HTML document skeleton will cause modern browsers to strip/hide the tags, resulting in a black screen. Push ONLY the pure `<svg>...</svg>` code.

```bash
node ./easyshow-cli.mjs push --type svg --content-file "./diagram.svg" \
  --room "3eb42d69d8b226abe22024d648975f8a/PPT002"
```

### Push HTML (animations, dashboards, custom layouts)
> [!WARNING]
> **CRITICAL**: Just like SVG, push ONLY pure HTML UI snippets (like `<div style="...">...</div>`). Do NOT include `<!DOCTYPE>`, `<html>`, or `<head>` tags. If you need a full page, host it somewhere and use the iframe method below.

```bash
node ./easyshow-cli.mjs push --type html --content-file "./animation.html" \
  --room "3eb42d69d8b226abe22024d648975f8a/PPT002"
```

### Push text
```bash
# ASCII only ?inline is fine
node ./easyshow-cli.mjs push --type text --text "System Ready" \
  --room "3eb42d69d8b226abe22024d648975f8a/PPT002"

# Chinese / non-ASCII (Thai, etc.) MUST use --text-file AND --safe-inline
echo "今日议程" > /tmp/msg.txt
node ./easyshow-cli.mjs push --type text --text-file /tmp/msg.txt \
  --room "3eb42d69d8b226abe22024d648975f8a/PPT002" --safe-inline
```

### Push Bilibili video
```bash
node ./easyshow-cli.mjs push --type bilibili \
  --url "https://www.bilibili.com/video/BV1D9d9B3Exr/" \
  --room "3eb42d69d8b226abe22024d648975f8a/PPT002"
```
The worker auto-extracts the BV ID and builds the embed URL.

### Push YouTube video
```bash
node ./easyshow-cli.mjs push --type youtube \
  --url "https://www.youtube.com/watch?v=dQw4w9WgXcQ" \
  --room "3eb42d69d8b226abe22024d648975f8a/PPT002"
```

### Push a website (iframe)
```bash
node ./easyshow-cli.mjs push --type html \
  --url "https://example.com" \
  --room "3eb42d69d8b226abe22024d648975f8a/PPT002"
```
The CLI auto-wraps the URL into a full-screen iframe.

### 🎵 Search Bilibili by song/keyword (bili-search)
When the user says a song name or artist ?do NOT manually search the web. Use `bili-search` directly:
```bash
# 播放热度最高的版本（默认）
node ./easyshow-cli.mjs bili-search \
  --keyword "周杰?夜曲" \
  --room "3eb42d69d8b226abe22024d648975f8a/PPT002"

# 如果?结果不理想，选第2热门
node ./easyshow-cli.mjs bili-search --keyword "夜曲" --top 2

# 不限音乐分区（搜索非歌曲内容如唐诗讲解、科学实验时必须使用）
node ./easyshow-cli.mjs bili-search --keyword "唐诗讲解" --cat 0
```

**热度算法**：收藏? + 弹幕×2 + 播放×1 ?代表"大家觉得好听"，而非只看播放量? 
命令会列?Top 5 候选，自动选最高热度版本推送到大屏?
---

## ─── Playlist (Multi-item Sequence) ────────────────────────

When the user provides multiple items, build a **playlist manifest** (JSON) and navigate with `--index`.

### Step 1: Prepare items

For **user files** ?upload each first to get the permanent URL:
```bash
# Each upload shows and prints the file-proxy URL
node ./easyshow-cli.mjs upload --file "./photo1.jpg"
# ?save the returned "url" field

node ./easyshow-cli.mjs upload --file "./report.pdf"
# ?save the returned "url" field
```

For **Bilibili / YouTube / AI content** ?use the URL/content directly.

### Step 2: Build manifest `scripts/agent-playlist.json`
```json
[
  {
    "type": "bilibili",
    "url": "https://www.bilibili.com/video/BV1D9d9B3Exr/",
    "name": "B站视?
  },
  {
    "type": "pdf",
    "url": "/api/file-proxy/si548-datasheet.pdf?path=%2Fagent-show%2Fsi548-datasheet.pdf&token=Allow_Public_Preview_Access_2025",
    "name": "si548 PDF",
    "viewerControlEnabled": true
  },
  {
    "type": "image",
    "url": "/api/file-proxy/photo.jpg?path=%2Fagent-show%2Fphoto.jpg&token=Allow_Public_Preview_Access_2025",
    "name": "照片"
  },
  {
    "type": "video",
    "url": "/api/file-proxy/demo.mp4?path=%2Fagent-show%2Fdemo.mp4&token=Allow_Public_Preview_Access_2025",
    "name": "演示视频"
  }
]
```

### Step 3: Navigate (AI-driven prev/next)
```bash
# Show item 1 (index 0)
node ./easyshow-cli.mjs playlist --file scripts/agent-playlist.json --index 0

# Show item 2 (index 1)
node ./easyshow-cli.mjs playlist --file scripts/agent-playlist.json --index 1

# Show item 3 (index 2)
node ./easyshow-cli.mjs playlist --file scripts/agent-playlist.json --index 2
```

Each `playlist` command pushes exactly one item, just like admin double-clicking "演示".  
When user says "下一?/ next / 上一?/ prev", increment/decrement the index and run again.

---

## ─── Utility Commands ───────────────────────────────────────

```bash
# Clear screen (standby)
node ./easyshow-cli.mjs clear --room "3eb42d69d8b226abe22024d648975f8a/PPT002"

# Check current screen state
node ./easyshow-cli.mjs state --room "3eb42d69d8b226abe22024d648975f8a/PPT002"

# Self-heal (force re-push last state)
node ./easyshow-cli.mjs self-heal --room "3eb42d69d8b226abe22024d648975f8a/PPT002"
```

---

## ─── Decision Tree ──────────────────────────────────────────

```
User gives you a FILE (PDF / Word / Excel / MP3 / MP4 / image)?
  └─ CHANNEL A: upload --file <path>
       ?Automatically uploaded to agent-show/ folder
       ?Automatically displayed with correct renderer
       ?Add --allow-control for PDF page-flip buttons

User says a song name / "播放xxx" / "放一首xxx"?
  └─ CHANNEL B: bili-search --keyword "歌名 歌手"
                (auto-picks most popular version on Bilibili)

User gives you a Bilibili or YouTube LINK?
  └─ CHANNEL B: push --type bilibili --url <link>
                push --type youtube  --url <link>

User gives you a website URL to show?
  └─ CHANNEL B: push --type html --url <https://...>

AI generates SVG / HTML / animated content?
  └─ CHANNEL B: push --type svg  --content-file <file>
                push --type html --content-file <file>

AI generates a text message?
  └─ CHANNEL B: push --type text --text <msg>  (ASCII)
                push --type text --text-file <file>  (Chinese)

Multiple items to show in sequence?
  └─ Build agent-playlist.json ?playlist --index N

Clear / stop display?
  └─ clear
```

---

## ─── Important Rules ────────────────────────────────────────

> [!IMPORTANT]
> **File uploads always go to `agent-show/` folder** (permanent WebDAV storage).  
> This is the same storage the Admin UI browses ?files will appear in the admin file list.

> [!IMPORTANT]
> **Non-ASCII content (Chinese, Thai, etc.) MUST use `--text-file` AND `--safe-inline`**.  
> Inline `--text "中文"` will fail. Using `--text-file` without `--safe-inline` may cause encoding issues.

> [!WARNING]
> **Do NOT use `type:html` with embedded iframes for playlist navigation.**  
> Iframes capture all pointer events ?navigation buttons become unclickable.  
> Always use the `playlist --index N` approach instead (one item per push).

> [!TIP]
> **Complex AI Content (SVG/Animations)**: **MUST use `type: html`** and wrap the content in a `<div>` with a background color and Flexbox centering. 
> Direct `type: svg` often results in "invisible" content or sizing issues.


> [!IMPORTANT]
> **观众翻页按钮（⬅️ ➡️）默认关闭。** 
> 仅在需要用户/学生手动交互（如阅读 PDF、翻页 PPT）时，显式添加 `--allow-control`。

> [!TIP]
> **Agent 行为准则：直接执行，不纠结。**
> 用户说"播放《忘情水》" -> 直接 `bili-search --keyword "忘情水"` 推送热度最高版本。
> 不需要先问"哪位歌手？""MV 还是现场？"
> 如果结果不满意，用户会说"换第2个"或"换一首"，Agent 再用 --top 2 重新搜索。
