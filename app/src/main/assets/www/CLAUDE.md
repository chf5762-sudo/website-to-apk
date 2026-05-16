# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

Since this is a vanilla JavaScript project without a `package.json` build system, development typically involves serving the files via a local HTTP server.

- **Serve Project**: `npx serve .` or any static file server.
- **Presenter Mode**: Access `index.html` (requires MQTT connection).
- **Audience Mode**: Access `remote.html` (syncs with index via MQTT).
- **PDF Conversion**: `node scripts/converter.js` (if applicable for processing assets).
- **Deployment**: `bash scripts/deploy_vps.sh` (specific to the user's infrastructure).

## Architecture & Logic

### 1. Communication Layer (MQTT)
- **Broker**: Uses EMQX public broker (`ws://broker.emqx.io:8083/mqtt`).
- **Topics**: 
  - `CONTROL_TOPIC`: Presenter sends commands (`prev`, `next`, `goto`, `draw`, `clear`).
  - `STATUS_TOPIC`: Syncs state (current page, total pages, file URL) and handles chat/presence.
- **Synchronization**: `remote.html` listens for `pg` (page change) and full status updates to stay in sync with the presenter.

### 2. Slide Rendering
- **Library**: `pdf.js` for PDF rendering.
- **Flow**: Presenter loads a file -> MQTT broadcasts URL -> Audience `remote.html` loads same URL -> `renderPage()` renders the specific canvas.
- **Media Support**: Automatically detects images and videos (MP4/Bilibili/YouTube) in URLs and switches display modes accordingly.

### 3. Audio/Video & Screen Sharing (Agora)
- **File**: [agora-call.js](agora-call.js)
- **Logic**: Encapsulates Agora RTC SDK. 
- **Screen Share**: Presenters can share their screen, which triggers a `screen_share_started` event via MQTT, causing audience members to switch from PDF view to the Agora video stage.

### 4. Interactive Features
- **Drawing/Graffiti**: Canvas overlay (`drawCanvas`) syncs relative coordinates (0-1) across clients via MQTT `draw` actions.
- **Discussion**: Sidebar chat and file sharing using MQTT. File uploads are handled via the Cloudflare Worker backend.

## Code Conventions
- **Vanilla JS**: No modern frameworks; favor direct DOM manipulation.
- **Event-Driven**: Heavily relies on MQTT message callbacks and DOM events.
- **CSS**: Uses CSS variables and backdrop filters for a "glassmorphism" UI style.
