pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

window.BEMFA_KEY = '3eb42d69d8b226abe22024d648975f8a';
            window.MQTT_URL = 'ws://broker.emqx.io:8083/mqtt';
            window.CONTROL_TOPIC = window.BEMFA_KEY + '/PPT001';
            window.STATUS_TOPIC = window.BEMFA_KEY + '/PPT002';
            let BEMFA_KEY = window.BEMFA_KEY;
            let MQTT_URL = window.MQTT_URL;
            let CONTROL_TOPIC = window.CONTROL_TOPIC;
            let STATUS_TOPIC = window.STATUS_TOPIC;

            // 每个标签页独立 Session ID（避免同浏览器多标签共用身份）
            if (!sessionStorage.getItem('sync_viewer_id')) {
                sessionStorage.setItem('sync_viewer_id', 'remote_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5));
            }
            let SESSION_ID = sessionStorage.getItem('sync_viewer_id');

            let mqttClient = null;
            let isConnected = false;
            let currentPage = 0;
            let totalPages = 0;
            let pdfDoc = null;
            let currentFilePath = null;
            let viewerControlEnabled = false;
            let pendingVideoUrl = null;
            let lastRemoteFlipAt = 0;
            let screenStatePollTimer = null;
            let lastScreenStateTs = 0;
            let lastRenderedScreenState = null;
            let manualDisplayPriority = false;
            let activeRoomReportTimer = null;
            let screenSelfHealTimer = null;


            // --- UI 基础功能 (优先定义) ---

            // 全屏切换功能
            function toggleFullscreen() {
                console.log('🚀 [Fullscreen] 尝试切换全屏...');

                // 视觉反馈：点击瞬间变红边，确认点击到了
                const btn = document.querySelector('.btn-fullscreen');
                if (btn) {
                    btn.style.outline = '3px solid red';
                    setTimeout(() => btn.style.outline = 'none', 500);
                }

                if (!document.fullscreenEnabled && !document.webkitFullscreenEnabled && !document.mozFullScreenEnabled && !document.msFullscreenEnabled) {
                    alert('当前浏览器或环境禁用了全屏功能，请检查权限。');
                    return;
                }

                try {
                    const isFull = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
                    const elem = document.documentElement;

                    if (!isFull) {
                        // 尝试所有可能的进入方法
                        const request = elem.requestFullscreen || elem.webkitRequestFullscreen || elem.mozRequestFullScreen || elem.msRequestFullscreen;
                        if (request) {
                            const p = request.call(elem);
                            if (p && p.catch) {
                                p.catch(err => {
                                    console.error('❌ [Fullscreen] 拦截:', err);
                                    alert('全屏请求被拦截: ' + err.message + '\n\n提示：浏览器通常要求在页面上先有点任何位置的操作，然后再点全屏。');
                                });
                            }
                        } else {
                            alert('当前浏览器版本过低，不支持全屏功能。');
                        }
                    } else {
                        // 退出逻辑
                        const exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
                        if (exit) exit.call(document);
                    }
                } catch (e) {
                    console.error('💥 [Fullscreen] 异常:', e);
                    alert('全屏逻辑异常: ' + e.message);
                }
            }
            window.toggleFullscreen = toggleFullscreen;

            function hideAgentScreenLayer() {
                const layer = document.getElementById('agentScreenLayer');
                if (!layer) return;
                layer.style.display = 'none';
                layer.innerHTML = '';
            }

            function setManualDisplayPriority(active) {
                manualDisplayPriority = !!active;
                if (manualDisplayPriority) {
                    hideAgentScreenLayer();
                } else {
                    pollScreenState();
                }
            }

            function renderAgentScreenState(state, isIdle) {
                const layer = document.getElementById('agentScreenLayer');
                const idleBadge = document.getElementById('screenIdleBadge');
                if (!layer) return;

                if (idleBadge) {
                    idleBadge.style.display = isIdle ? 'block' : 'none';
                }

                if (manualDisplayPriority) {
                    layer.style.display = 'none';
                    if (idleBadge) idleBadge.style.display = 'none';
                    lastRenderedScreenState = null;
                    return;
                }
                if (!state || !state.type) {
                    hideAgentScreenLayer();
                    lastRenderedScreenState = null;
                    return;
                }

                const fit = state.fit === 'cover' ? 'cover' : 'contain';
                let html = '';
                if (state.type === 'text') {
                    const text = state.text || state.content || '';
                    html = `<div class="screen-text">${String(text).replace(/[&<>]/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[s]))}</div>`;
                } else if (state.type === 'image') {
                    const src = state.url || state.content || '';
                    html = `<img class="screen-media" style="object-fit:${fit};" src="${src}" alt="">`;
                } else if (state.type === 'video') {
                    const src = state.url || state.content || '';
                    html = `<video class="screen-media" style="object-fit:${fit};" src="${src}" controls autoplay playsinline></video>`;
                } else if (state.type === 'svg') {
                    let svgContent = String(state.content || '');
                    if (!/preserveAspectRatio\s*=/.test(svgContent)) {
                        const fitMode = (state.fit === 'cover') ? 'slice' : 'meet';
                        svgContent = svgContent.replace(/<svg(\s|>)/i, `<svg preserveAspectRatio="xMidYMid ${fitMode}" $1`);
                    }
                    if (!/width\s*=/.test(svgContent)) {
                        svgContent = svgContent.replace(/<svg(\s|>)/i, '<svg width="100%" height="100%" $1');
                    }
                    html = `<div class="screen-frame" style="width:100%;height:100%;background:#000;overflow:hidden;display:flex;align-items:center;justify-content:center;">${svgContent}</div>`;
                } else if (state.type === 'html' || state.type === 'iframe') {
                    if (state.url) {
                        html = `<iframe class="screen-frame" src="${state.url}" style="width:100%;height:100%;border:none;background:#fff;"></iframe>`;
                    } else {
                        html = `<div class="screen-frame" style="width:100%;height:100%;background:#000;">${state.content || ''}</div>`;
                    }
                } else if (state.type === 'pdf' || state.type === 'doc') {
                    const src = state.url || '';
                    html = `<iframe class="screen-frame" src="${src}"></iframe>`;
                }

                layer.innerHTML = html;
                layer.style.display = html ? 'flex' : 'none';
                lastRenderedScreenState = state;
                reportScreenRenderAck(state);
            }

            function hashScreenState(state) {
                if (!state) return '';
                const raw = [
                    String(state.roomId || ''),
                    String(state.type || ''),
                    String(state.text || ''),
                    String(state.content || ''),
                    String(state.url || ''),
                    String(state.fit || '')
                ].join('|');
                let h = 2166136261;
                for (let i = 0; i < raw.length; i++) {
                    h ^= raw.charCodeAt(i);
                    h = Math.imul(h, 16777619);
                }
                return (h >>> 0).toString(16);
            }

            async function reportScreenRenderAck(state) {
                try {
                    if (!state || !state.type) return;
                    const roomId = window.STATUS_TOPIC || STATUS_TOPIC || (BEMFA_KEY + '/PPT002');
                    await fetch('/api/screen/render-ack', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            roomId,
                            hash: hashScreenState(state),
                            clientTs: Date.now(),
                            ok: true,
                            source: 'remote'
                        })
                    });
                } catch (e) { }
            }

            async function pollScreenState() {
                try {
                    const roomId = window.STATUS_TOPIC || STATUS_TOPIC || (BEMFA_KEY + '/PPT002');
                    const res = await fetch(`/api/screen/state?roomId=${encodeURIComponent(roomId)}`);
                    if (!res.ok) return;
                    const data = await res.json();
                    const state = data ? data.state : null;
                    const ts = state && state.ts ? Number(state.ts) : 0;
                    if (ts === lastScreenStateTs && state) return;

                    // 最新时间戳覆盖优先策略
                    // 如果存在有效的 Push，并且它的时间戳晚于最后一次 PPT 活跃操作的时间戳
                    if (ts > 0 && ts !== lastScreenStateTs) {
                        const pptTs = window._pptLastTs || 0;
                        // 允许 2000ms 的时钟误差
                        if (ts > pptTs - 2000) {
                            console.log('🔄 [Priority] Push 时间戳更新，主动解除 PPT 锁定。Push:', ts, 'PPT:', pptTs);
                            manualDisplayPriority = false;
                        }
                    }

                    lastScreenStateTs = ts;
                    renderAgentScreenState(state, data.isIdle);
                } catch (e) { }
            }

            async function reportActiveScreenRoom() {
                try {
                    const roomId = window.STATUS_TOPIC || STATUS_TOPIC || (BEMFA_KEY + '/PPT002');
                    await fetch('/api/screen/active-room', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ roomId, source: 'remote' })
                    });
                } catch (e) { }
            }

            async function triggerScreenSelfHeal() {
                try {
                    const roomId = window.STATUS_TOPIC || STATUS_TOPIC || (BEMFA_KEY + '/PPT002');
                    if (lastRenderedScreenState && lastRenderedScreenState.type) {
                        await reportScreenRenderAck(lastRenderedScreenState);
                    }
                    await fetch(`/api/screen/self-heal?roomId=${encodeURIComponent(roomId)}`, { method: 'POST' });
                } catch (e) { }
            }

            function startScreenStatePolling() {
                if (screenStatePollTimer) clearInterval(screenStatePollTimer);
                pollScreenState();
                screenStatePollTimer = setInterval(pollScreenState, 1000);
                reportActiveScreenRoom();
                if (activeRoomReportTimer) clearInterval(activeRoomReportTimer);
                activeRoomReportTimer = setInterval(reportActiveScreenRoom, 10000);
                triggerScreenSelfHeal();
                if (screenSelfHealTimer) clearInterval(screenSelfHealTimer);
                screenSelfHealTimer = setInterval(triggerScreenSelfHeal, 3000);
            }

            function stopScreenStatePolling() {
                if (screenStatePollTimer) {
                    clearInterval(screenStatePollTimer);
                    screenStatePollTimer = null;
                }
                if (activeRoomReportTimer) {
                    clearInterval(activeRoomReportTimer);
                    activeRoomReportTimer = null;
                }
                if (screenSelfHealTimer) {
                    clearInterval(screenSelfHealTimer);
                    screenSelfHealTimer = null;
                }
            }

            function stopStatusPolling() {
                stopScreenStatePolling();
            }

            function topicSig(input) {
                let h = 2166136261;
                const text = String(input || '');
                for (let i = 0; i < text.length; i++) {
                    h ^= text.charCodeAt(i);
                    h = Math.imul(h, 16777619);
                }
                return (h >>> 0).toString(16).padStart(8, '0');
            }

            function buildTopicSuffix(baseName) {
                if (!baseName || baseName === 'admin') return '';
                const sig = topicSig(`${BEMFA_KEY}:${baseName}`).slice(0, 8);
                return `_${baseName}_${sig}`;
            }



            // 页面加载后自动连接
            window.addEventListener('load', () => {
                const params = new URLSearchParams(window.location.search);
                // 兼容 ?room=xxx 和 ?u=xxx 两种链接格式
                const room = params.get('room') || params.get('u');
                const suffix = buildTopicSuffix(room);
                CONTROL_TOPIC = BEMFA_KEY + '/PPT001' + suffix;
                STATUS_TOPIC = BEMFA_KEY + '/PPT002' + suffix;
                window.STATUS_TOPIC = STATUS_TOPIC; // Expose globally for screen share conflict check
                startScreenStatePolling();

                // Force stable Chinese labels to avoid any source-file encoding pollution.
                try {
                    const headerLabel = document.querySelector('.discussion-header span span');
                    if (headerLabel) headerLabel.textContent = '讨论屏';
                    const onlineBadge = document.getElementById('online-count-badge');
                    if (onlineBadge && !onlineBadge.textContent.trim()) onlineBadge.textContent = '1 人';
                    const fileBtn = document.querySelector('.discussion-input-area button[type="button"]');
                    if (fileBtn) {
                        fileBtn.title = '发送文件';
                        fileBtn.textContent = '📎';
                    }
                    const msgInput = document.getElementById('discussion-input');
                    if (msgInput) msgInput.placeholder = '输入消息...';
                    const sendBtn = document.querySelector('.discussion-input-area button[onclick="sendChatMessage()"]');
                    if (sendBtn) sendBtn.textContent = '发送';
                    const chatFab = document.getElementById('chat-fab');
                    if (chatFab) {
                        chatFab.title = '聊天';
                        chatFab.textContent = '💬';
                    }
                    const fsBtn = document.querySelector('.btn-fullscreen');
                    if (fsBtn) fsBtn.title = '全屏';
                } catch (e) { }

                // Default close discussion panel.
                const sidebar = document.getElementById('discussion-sidebar');
                if (sidebar) sidebar.classList.remove('active');

                // Ensure remote bottom-right control panel is collapsed by default.
                const tryCollapse = () => {
                    if (typeof window.agoraCollapseCtrlPanel === 'function') {
                        window.agoraCollapseCtrlPanel(true);
                    }
                };
                tryCollapse();
                setTimeout(tryCollapse, 300);
                setTimeout(tryCollapse, 1000);

                const displayName = room || 'admin';
                document.getElementById('welcome-title').textContent = room ? `HELLO, ${displayName.toUpperCase()}` : 'SYSTEM ONLINE';

                // 显示昵称弹窗，让观众选择名字后再连接
                // (connectMQTT 由 confirmNickname / skipNickname 触发)
                document.getElementById('nickname-modal').classList.remove('hidden');
                // 自动聚焦昵称输入框
                setTimeout(() => { const el = document.getElementById('nickname-input'); if (el) el.focus(); }, 100);
            });

            // --- 全局安全防护 (显示端强制开启) ---
            document.addEventListener('contextmenu', e => e.preventDefault());
            document.addEventListener('keydown', e => {
                // 禁止 F12, Ctrl+Shift+I/J/C, Ctrl+U, Ctrl+S
                if (e.key === 'F12' ||
                    (e.ctrlKey && e.shiftKey && ['I', 'J', 'C'].includes(e.key)) ||
                    (e.ctrlKey && e.key === 'u') ||
                    (e.ctrlKey && e.key === 's')
                ) {
                    e.preventDefault();
                }
            });

            // --- 互动讨论逻辑 ---
            const onlineUsers = new Map();
            let isIdAssigned = false;

            // --- 昵称弹窗逻辑 ---
            function confirmNickname() {
                const input = document.getElementById('nickname-input');
                const name = input.value.trim();
                if (name) {
                    window.sessionUsername = name;
                } else {
                    skipNickname();
                    return;
                }
                document.getElementById('nickname-modal').classList.add('hidden');
                connectMQTT();
            }

            function skipNickname() {
                // 随机可爱动物名称 + 4位字母数字
                const animals = ["百灵鸟", "小海豚", "胖达", "小白兔", "小柯基", "小花猫", "小仓鼠", "小企鹅", "长颈鹿", "小松鼠", "小刺猬", "小考拉", "小狐狸", "小斑马", "小浣熊"];
                const animal = animals[Math.floor(Math.random() * animals.length)];
                const rand = Math.random().toString(36).substr(2, 4).toUpperCase();
                window.sessionUsername = animal + '_' + rand;
                document.getElementById('nickname-modal').classList.add('hidden');
                connectMQTT();
            }

            window.chatUnreadCount = 0;
            window.updateChatUnreadCount = function (count) {
                window.chatUnreadCount = count;
                const buttons = [
                    document.getElementById('chat-fab'),
                    document.getElementById('btn-toggle-discussion'),
                    document.getElementById('agora-chat-btn')
                ];

                buttons.forEach(btn => {
                    if (!btn) return;
                    let badge = btn.querySelector('.chat-unread-badge');
                    if (count > 0) {
                        if (!badge) {
                            badge = document.createElement('div');
                            badge.className = 'chat-unread-badge';
                            badge.style.cssText = 'position:absolute; top:-4px; right:-4px; background:#f56c6c; color:white; font-size:10px; font-weight:bold; padding:2px 5px; border-radius:10px; z-index:10; pointer-events:none; box-shadow:0 2px 4px rgba(0,0,0,0.3); line-height:1; min-width:14px; text-align:center; box-sizing:border-box;';
                            if (window.getComputedStyle(btn).position === 'static') {
                                btn.style.position = 'relative';
                            }
                            btn.appendChild(badge);
                        }
                        badge.innerText = count > 99 ? '99+' : count;
                    } else {
                        if (badge) badge.remove();
                    }
                });
            };

            let discussionHideTimer = null;
            function initDiscussionSidebarEvents() {
                const sidebar = document.getElementById('discussion-sidebar');
                if (!sidebar) return;
                sidebar.addEventListener('mouseleave', () => {
                    discussionHideTimer = setTimeout(() => {
                        if (sidebar.classList.contains('active')) {
                            sidebar.classList.remove('active');
                            const icon = document.getElementById('toggle-icon');
                            if (icon) icon.innerText = '<';
                            if (window.updateChatUnreadCount) window.updateChatUnreadCount(0);
                        }
                    }, 500);
                });
                sidebar.addEventListener('mouseenter', () => {
                    if (discussionHideTimer) {
                        clearTimeout(discussionHideTimer);
                        discussionHideTimer = null;
                    }
                });
            }
            document.addEventListener('DOMContentLoaded', initDiscussionSidebarEvents);

            function toggleDiscussion() {
                const sidebar = document.getElementById('discussion-sidebar');
                sidebar.classList.toggle('active');
                const icon = document.getElementById('toggle-icon');
                if (icon) icon.innerText = sidebar.classList.contains('active') ? '>' : '<';
                if (sidebar.classList.contains('active')) {
                    if (window.updateChatUnreadCount) window.updateChatUnreadCount(0);
                }
            }
            window.toggleDiscussion = toggleDiscussion;

            function sendChatMessage() {
                const input = document.getElementById('discussion-input');
                const text = input.value.trim();
                if (!text) return;

                const chatMsg = {
                    roomId: STATUS_TOPIC,
                    action: 'chat',
                    sender: window.sessionUsername || '观众',
                    sessionId: SESSION_ID,
                    text: text,
                    timestamp: Date.now()
                };

                if (window.mqttClient) {
                    window.mqttClient.publish(STATUS_TOPIC, JSON.stringify(chatMsg));
                }
                input.value = '';
                addMessageToUI(chatMsg, true);
            }

            async function handleDiscussionFileUpload(input) {
                const file = input.files[0];
                if (!file) return;
                input.value = ''; // reset so same file can be re-uploaded

                addMessageToUI({ text: `正在上传文件: ${file.name}...`, sender: '系统', action: 'chat', timestamp: Date.now() }, false);

                try {
                    const arrayBuffer = await file.arrayBuffer();
                    // Use the auth-free /api/chat/upload endpoint (handles WebDAV internally)
                    const resp = await fetch(`/api/chat/upload?filename=${encodeURIComponent(file.name)}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/octet-stream' },
                        body: arrayBuffer
                    });
                    const result = await resp.json();
                    if (result.success && result.url) {
                        const fileUrl = result.url;

                        const imgExts = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
                        const ext = file.name.split('.').pop().toLowerCase();
                        const isImage = imgExts.includes(ext);

                        const fileMsg = {
                            roomId: STATUS_TOPIC,
                            action: isImage ? 'chat_image' : 'file_link',
                            sender: window.sessionUsername || '观众',
                            sessionId: SESSION_ID,
                            fileName: file.name,
                            fileSize: (file.size / 1024).toFixed(1) + ' KB',
                            url: fileUrl,
                            imageUrl: isImage ? fileUrl : undefined,
                            timestamp: Date.now()
                        };
                        if (window.mqttClient) {
                            window.mqttClient.publish(STATUS_TOPIC, JSON.stringify(fileMsg));
                        }
                        addMessageToUI(fileMsg, true);
                    } else {
                        addMessageToUI({ text: `文件上传失败 (${result.error || resp.status})`, sender: '系统', action: 'chat', timestamp: Date.now() }, false);
                    }
                } catch (e) {
                    console.error('文件上传失败:', e);
                    addMessageToUI({ text: '文件分享失败', sender: '系统', action: 'chat', timestamp: Date.now() }, false);
                }
            }

            function stringToColor(str) {
                let hash = 0;
                for (let i = 0; i < str.length; i++) {
                    hash = str.charCodeAt(i) + ((hash << 5) - hash);
                }
                const h = Math.abs(hash) % 360;
                return `hsl(${h}, 70%, 50%)`;
            }

            function toggleUserList() {
                const list = document.getElementById('discussion-user-list');
                const arrow = document.getElementById('user-list-arrow');
                if (list.style.display === 'block') {
                    list.style.display = 'none';
                    arrow.textContent = '▼';
                } else {
                    list.style.display = 'block';
                    arrow.textContent = '▲';
                    renderUserList();
                }
            }

            function closePresentation() {
                console.log('🎬 演示已结束，返回欢迎界面');
                const canvas = document.getElementById('pdfCanvas');
                if (canvas) canvas.style.display = 'none';
                const drawCanvas = document.getElementById('drawCanvas');
                if (drawCanvas) drawCanvas.style.display = 'none';
                const imgDisplay = document.getElementById('imageDisplay');
                if (imgDisplay) { imgDisplay.style.display = 'none'; imgDisplay.src = ''; }
                const videoDisplay = document.getElementById('videoDisplay');
                if (videoDisplay) {
                    try { videoDisplay.pause(); } catch (e) { }
                    videoDisplay.style.display = 'none';
                    videoDisplay.src = '';
                }
                const videoIframe = document.getElementById('videoIframe');
                if (videoIframe) {
                    videoIframe.style.display = 'none';
                    videoIframe.src = '';
                }
                const officeIframe = document.getElementById('officeIframe');
                if (officeIframe) {
                    officeIframe.style.display = 'none';
                    officeIframe.src = '';
                }
                const videoPrompt = document.getElementById('video-prompt');
                if (videoPrompt) videoPrompt.style.display = 'none';
                const placeholder = document.getElementById('placeholder');
                if (placeholder) placeholder.style.display = 'flex';
                const infoScreen = document.getElementById('info-screen');
                if (infoScreen) infoScreen.style.display = 'none';
                const pageInfo = document.getElementById('pageInfo');
                if (pageInfo) pageInfo.style.display = 'none';

                currentFilePath = null;
                pdfDoc = null;
                currentPage = 0;
                totalPages = 0;
                _mediaCleared = false; // 重置，下次演示时重新清理媒体
                updatePageInfo();
                clearRemoteDrawing();
                // 演示结束，恢复 Agora 控制面板到默认位置
                if (typeof window.agoraSetCtrlPanelBottom === 'function') {
                    window.agoraSetCtrlPanelBottom(window._agoraCtrlBaseBottom || 90);
                } else {
                    const p = document.getElementById('agora-global-ctrl');
                    if (p) p.style.bottom = '90px';
                }
            }

            function renderUserList() {
                const list = document.getElementById('discussion-user-list');
                if (!list || list.style.display === 'none') return;

                let html = '';
                const seenNames = new Set();

                // 1. 演示者 (Master)
                const master = Array.from(onlineUsers.values()).find(u => u.role === 'master');
                const masterName = master ? master.name : (window.isPresenterOnline ? '演示者' : null);

                if (masterName) {
                    seenNames.add(masterName);
                    html += `
                        <div class="user-item">
                            <div class="user-avatar" style="background:${stringToColor(masterName)}">${masterName.charAt(0)}</div>
                            <div class="user-name">${masterName} <span style="font-size:10px; color:#c0dfff;">(主持人)</span></div>
                            <div class="user-status-dot"></div>
                        </div>
                    `;
                }

                // 2. 本人 (观众端加上自己)
                const myName = window.sessionUsername || '观众';
                if (!seenNames.has(myName)) {
                    seenNames.add(myName);
                    html += `
                        <div class="user-item">
                            <div class="user-avatar" style="background:${stringToColor(myName)}">${myName.charAt(0)}</div>
                            <div class="user-name">${myName} <span style="font-size:10px; color:#4facfe;">(本人)</span></div>
                            <div class="user-status-dot"></div>
                        </div>
                    `;
                }

                // 3. 其他在线用户 (过滤掉已显示的演示者和本人)
                onlineUsers.forEach((user, sid) => {
                    if (user.role === 'master' || seenNames.has(user.name)) return;
                    seenNames.add(user.name);
                    html += `
                        <div class="user-item">
                            <div class="user-avatar" style="background:${stringToColor(user.name)}">${user.name.charAt(0)}</div>
                            <div class="user-name">${user.name}</div>
                            <div class="user-status-dot"></div>
                        </div>
                    `;
                });

                list.innerHTML = html;
            }

            function addMessageToUI(msg, isMe) {
                const list = document.getElementById('message-list');
                if (!list) return;

                const sidebar = document.getElementById('discussion-sidebar');
                if (!isMe && sidebar && !sidebar.classList.contains('active')) {
                    if (window.updateChatUnreadCount) {
                        window.updateChatUnreadCount((window.chatUnreadCount || 0) + 1);
                    }
                }

                const wrapper = document.createElement('div');
                wrapper.className = `message-with-avatar ${isMe ? 'me' : 'others'}`;

                const bgColor = stringToColor(msg.sender || '观众');
                const avatarChar = (msg.sender || '观').charAt(0);

                // Format timestamp
                const tsMs = msg.timestamp || Date.now();
                const d = new Date(tsMs);
                const pad = n => String(n).padStart(2, '0');
                const timeStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

                let innerHTML = `
                    <div class="user-avatar" style="background:${bgColor}">${avatarChar}</div>
                    <div class="message-bubble">
                        <div style="font-size:11px; opacity:0.6; margin-bottom:4px;">${msg.sender || '观众'}</div>
                `;

                if (msg.action === 'chat_image' && (msg.imageUrl || msg.url)) {
                    innerHTML += `<img src="${msg.imageUrl || msg.url}" style="max-width:180px; max-height:180px; border-radius:8px; cursor:pointer; margin-top:4px;" onclick="window.open(this.src)" />`;
                } else if (msg.action === 'file_link') {
                    innerHTML += `
                        <a href="${msg.url}" target="_blank" class="file-card" download>
                            <span class="file-card-icon">📄</span>
                            <div class="file-card-info">
                                <span class="file-card-name">${msg.fileName}</span>
                                <span class="file-card-size">${msg.fileSize}</span>
                            </div>
                        </a>
                    `;
                } else {
                    innerHTML += `<div>${msg.text}</div>`;
                }

                innerHTML += `<div style="font-size:10px; opacity:0.4; margin-top:5px; text-align:right;">${timeStr}</div>`;
                innerHTML += `</div>`;
                wrapper.innerHTML = innerHTML;
                list.appendChild(wrapper);
                list.scrollTop = list.scrollHeight;
            }

            function updateOnlineStatusUI() {
                const badge = document.getElementById('online-count-badge');

                // 计算在线人数：演示者(master)单独算一个，其余每个 sessionId 算一个
                let totalCount = 0;
                let hasMaster = false;
                let hasSelf = false;
                onlineUsers.forEach(u => {
                    if (u.role === 'master') hasMaster = true;
                    if (u.name === window.sessionUsername) hasSelf = true;
                    totalCount++;
                });
                // 如果 master 未通过 MQTT 上报但已知在线，则额外补一个
                if (!hasMaster && window.isPresenterOnline) totalCount++;
                // 确保本人也被统计进去
                if (!hasSelf && window.sessionUsername) totalCount++;

                if (badge) badge.innerText = totalCount + ' 人';
                renderUserList();
            }

            // MQTT-based heartbeat
            function startMqttPresenceHeartbeat() {
                setInterval(() => {
                    if (!STATUS_TOPIC || !window.mqttClient) return;
                    window.mqttClient.publish(STATUS_TOPIC, JSON.stringify({
                        action: 'presence',
                        sessionId: SESSION_ID,
                        name: window.sessionUsername || '观众',
                        role: 'viewer'
                    }));

                    // Cleanup stale users (>15s)
                    const now = Date.now();
                    let changed = false;
                    for (const [sid, user] of onlineUsers.entries()) {
                        if (now - user.time > 15000) {
                            onlineUsers.delete(sid);
                            changed = true;
                        }
                    }
                    if (changed) updateOnlineStatusUI();
                }, 5000);
            }
            setTimeout(startMqttPresenceHeartbeat, 2000);

            function connectMQTT() {
                if (mqttClient) {
                    mqttClient.end();
                }

                updateStatus('连接中...', false);

                try {
                    // 只要具备随机 SESSION_ID 充当了身份，在 EMQX 上多端独立
                    const urlParams = new URLSearchParams(window.location.search);
                    let sessionUsername = window.sessionUsername || urlParams.get('u') || urlParams.get('room');
                    if (!sessionUsername) {
                        const animals = ["百灵鸟", "小海豚", "胖达", "小白兔", "小柯基"];
                        const animal = animals[Math.floor(Math.random() * animals.length)];
                        const rand = Math.random().toString(36).substr(2, 4).toUpperCase();
                        sessionUsername = animal + '_' + rand;
                    }
                    window.sessionUsername = sessionUsername;



                    window.mqttClient = mqttClient = mqtt.connect(MQTT_URL, {
                        clientId: SESSION_ID,
                        clean: true,
                        connectTimeout: 4000,
                        reconnectPeriod: 3000,
                        protocolVersion: 4
                    });

                    mqttClient.on('connect', () => {
                        updateStatus('已连接', true);
                        startScreenStatePolling();
                        mqttClient.subscribe(STATUS_TOPIC, (err) => {
                            if (!err) {
                                isConnected = true;
                                enableControls(viewerControlEnabled);
                                requestStatus();

                                // 首先请求分配一个唯一编号
                                console.log('📢 正在请求席位编号...');
                                mqttClient.publish(STATUS_TOPIC, JSON.stringify({
                                    action: 'request_id',
                                    sessionId: SESSION_ID
                                }), { qos: 0 });

                                // 如果 1.5 秒后没人分配（比如展示者不在线），则自行抢坑
                                setTimeout(() => {
                                    if (!isIdAssigned) {
                                        console.log('⚠️ 未收到编号分配，开始自行计算编号...');
                                        const usedIds = new Set();
                                        onlineUsers.forEach(u => {
                                            const m = u.name.match(/_(\d+)$/);
                                            if (m) usedIds.add(parseInt(m[1]));
                                        });
                                        let assigned = 2; // 自行抢坑从 02 开始
                                        while (usedIds.has(assigned)) assigned++;
                                        const assignedStr = assigned < 10 ? '0' + assigned : '' + assigned;
                                        completeIdAssignment(assignedStr);
                                    }
                                }, 1500);
                            } else {
                                updateStatus('订阅失败', false);
                            }
                        });
                    });

                    function completeIdAssignment(idStr) {
                        if (isIdAssigned) return;
                        isIdAssigned = true;
                        // 不再强制修改用户的昵称
                        console.log('✅ 席位确认:', window.sessionUsername);
                    }

                    // --- 权限管理逻辑 ---
                    window.isPresenterOnline = false;
                    window.isViewerSharingAllowed = true; // 默认允许，直到演示者下达禁令
                    window.isViewerMicAllowed = true;
                    window.isViewerVideoAllowed = true;

                    function updateSharingPermission() {
                        if (window.agoraModule && typeof window.agoraModule.setSharingPermission === 'function') {
                            window.agoraModule.setSharingPermission(window.isPresenterOnline, window.isViewerSharingAllowed);
                        }
                        if (window.agoraModule && typeof window.agoraModule.setMediaPermission === 'function') {
                            window.agoraModule.setMediaPermission(window.isViewerMicAllowed, window.isViewerVideoAllowed);
                        }
                    }
                    // 定期清理主控在线状态（心跳超时）
                    setInterval(() => {
                        window.isPresenterOnline = false;
                        // 检查在线列表中是否有 master
                        for (let user of onlineUsers.values()) {
                            if (user.role === 'master') {
                                window.isPresenterOnline = true;
                                break;
                            }
                        }
                        updateSharingPermission();
                    }, 5000);



                    mqttClient.on('message', (topic, message) => {
                        if (topic === STATUS_TOPIC) {
                            try {
                                const status = JSON.parse(message.toString());

                                // Chat actions
                                if (status.action === 'chat' || status.action === 'file_link' || status.action === 'chat_image') {
                                    if (status.sessionId && status.sessionId !== SESSION_ID) {
                                        const senderName = status.sender || '观众';
                                        const existing = onlineUsers.get(status.sessionId) || {};
                                        onlineUsers.set(status.sessionId, { name: senderName, role: existing.role || 'viewer', time: Date.now() });
                                        updateOnlineStatusUI();
                                    }
                                    if (status.sessionId !== SESSION_ID) {
                                        addMessageToUI(status, false);
                                    }
                                    return;
                                }
                                if (status.action === 'presence') {
                                    if (status.sessionId !== SESSION_ID) {
                                        onlineUsers.set(status.sessionId, { name: status.name, role: status.role, time: Date.now() });
                                        if (status.role === 'master') window.isPresenterOnline = true;
                                        updateOnlineStatusUI();
                                    }
                                    return;
                                }

                                // 投屏权限配置
                                if (status.action === 'config_sharing') {
                                    window.isViewerSharingAllowed = status.allowed;
                                    updateSharingPermission();
                                    return;
                                }
                                if (status.action === 'config_mic') {
                                    window.isViewerMicAllowed = status.allowed;
                                    updateSharingPermission();
                                    return;
                                }
                                if (status.action === 'config_video') {
                                    window.isViewerVideoAllowed = status.allowed;
                                    updateSharingPermission();
                                    return;
                                }

                                if (status.action === 'screen_share_started') {
                                    setManualDisplayPriority(true);
                                    if (window.agoraModule && typeof window.agoraModule.ensureViewerJoined === 'function') {
                                        window.agoraModule.ensureViewerJoined();
                                    }
                                    if (window.agoraModule && typeof window.agoraModule.handleScreenShareLock === 'function') {
                                        window.agoraModule.handleScreenShareLock(status.uid);
                                    }
                                    const stage = document.getElementById('agora-video-stage');
                                    if (stage) stage.style.display = 'flex';

                                    // 【互斥逻辑】正在演示PPT时开启了屏幕分享，自动关闭/隐藏PPT
                                    if (typeof closePresentation === 'function') {
                                        // 停止并清理当前所有的显示（重置为无文档状态）
                                        closePresentation();
                                    }

                                    // 额外确保隐藏所有显示画布
                                    const pdfCanvas = document.getElementById('pdfCanvas');
                                    if (pdfCanvas) pdfCanvas.style.display = 'none';
                                    const imageDisplay = document.getElementById('imageDisplay');
                                    if (imageDisplay) imageDisplay.style.display = 'none';
                                    const officeIframe = document.getElementById('officeIframe');
                                    if (officeIframe) officeIframe.style.display = 'none';
                                    const videoDisplay = document.getElementById('videoDisplay');
                                    if (videoDisplay) videoDisplay.style.display = 'none';

                                    const ph = document.getElementById('placeholder');
                                    if (ph) {
                                        ph.style.display = 'none'; // 确保 placeholder 隐藏，不遮挡屏幕分享
                                    }
                                    return;
                                }

                                if (status.action === 'screen_share_stopped') {
                                    setManualDisplayPriority(false);
                                    console.log('屏幕共享已结束，请求恢复演示状态...');
                                    if (window.agoraModule && typeof window.agoraModule.exitPresenterPreviewMode === 'function') {
                                        window.agoraModule.exitPresenterPreviewMode();
                                    }
                                    requestStatus(); // 立即拉取主讲当前状态
                                    return;
                                }

                                // === LEAN STATUS FORMAT HANDLER ===
                                // Ultra-light page change: {a:'pg', p:N, t:T}
                                if (status.a === 'pg') {
                                    window._pptLastTs = status.t || Date.now();
                                    setManualDisplayPriority(true); // 活跃翻页，强制切回 PPT
                                    if (status.p !== undefined && (currentPage !== status.p || totalPages !== status.t)) {
                                        currentPage = status.p;
                                        totalPages = status.t;
                                        updatePageInfo();
                                        if (pdfDoc && currentPage > 0) {
                                            renderPage(currentPage);
                                        }
                                    }
                                    return;
                                }

                                // Full status: {p, t, u, s, vs}
                                if (status.t) window._pptLastTs = status.t;

                                if (status.s === 'idle' && !status.u) {
                                    setManualDisplayPriority(false);
                                    closePresentation();
                                    return;
                                }

                                // Handle URL change (new file or initial load)
                                const statusUrl = status.u || status.pdfUrl;
                                const statusPage = status.p !== undefined ? status.p : status.currentPage;
                                const statusTotal = status.t_total !== undefined ? status.t_total : (status.totalPages !== undefined ? status.totalPages : status.t);
                                const statusViewerControl = status.vc !== undefined ? !!status.vc : status.viewerControlEnabled;
                                const statusViewerSharing = status.vs !== undefined ? !!status.vs : status.viewerSharingAllowed;
                                const statusViewerMic = status.vm !== undefined ? !!status.vm : status.viewerMicAllowed;
                                const statusViewerVideo = status.vv !== undefined ? !!status.vv : status.viewerVideoAllowed;

                                if (statusUrl && statusUrl !== currentFilePath) {
                                    // 仅在 PPT 时间戳更新时抢占焦点，防止覆盖正在展示的最新 Push
                                    if (!window._pptLastTs || lastScreenStateTs < window._pptLastTs) {
                                        setManualDisplayPriority(true);
                                    }
                                    currentFilePath = statusUrl;
                                    loadPDF(statusUrl);
                                } else if (status.action === 'refresh') {
                                    setManualDisplayPriority(true);
                                    loadPDF(currentFilePath);
                                }

                                if (statusPage !== undefined && statusTotal !== undefined) {
                                    if (currentPage !== statusPage || totalPages !== statusTotal) {
                                        // 发现内容/页码变化，代表这是活跃状态，抢占优先级
                                        if (status.t) window._pptLastTs = status.t;
                                        setManualDisplayPriority(true);

                                        currentPage = statusPage;
                                        totalPages = statusTotal;
                                        updatePageInfo();
                                        if (pdfDoc && currentPage > 0) {
                                            renderPage(currentPage);
                                        }
                                    }
                                }

                                if (statusViewerControl !== undefined) {
                                    viewerControlEnabled = !!statusViewerControl;
                                    const ctrls = document.querySelector('.controls-container');
                                    if (ctrls) ctrls.style.display = viewerControlEnabled ? 'flex' : 'none';
                                    enableControls(isConnected && viewerControlEnabled);
                                }

                                // Sync viewer sharing permission
                                if (statusViewerSharing !== undefined) {
                                    window.isViewerSharingAllowed = statusViewerSharing;
                                    updateSharingPermission();
                                }
                                if (statusViewerMic !== undefined) {
                                    window.isViewerMicAllowed = statusViewerMic;
                                    updateSharingPermission();
                                }
                                if (statusViewerVideo !== undefined) {
                                    window.isViewerVideoAllowed = statusViewerVideo;
                                    updateSharingPermission();
                                }

                                const videoEl = document.getElementById('videoDisplay');
                                if (videoEl && videoEl.style.display !== 'none') {
                                    handleVideoSync(videoEl, status);
                                }

                                // 主题发布逻辑
                                if (status.action === 'info') {
                                    setManualDisplayPriority(true);
                                    console.log('📥 收到主题信息:', status);
                                    document.getElementById('info-topic').textContent = status.topic;
                                    document.getElementById('info-speaker').textContent = '主讲人: ' + (status.speaker || '未知');
                                    document.getElementById('info-date').textContent = '时间: ' + (status.date || '');
                                    document.getElementById('info-url').textContent = status.url;
                                    const qrContainer = document.getElementById('info-qrcode');
                                    qrContainer.innerHTML = '';
                                    try { new QRCode(qrContainer, { text: status.url, width: 256, height: 256 }); } catch (e) { }
                                    document.getElementById('info-screen').style.display = 'flex';
                                    document.getElementById('pdfCanvas').style.display = 'none';
                                    document.getElementById('imageDisplay').style.display = 'none';
                                    document.getElementById('videoDisplay').style.display = 'none';
                                    document.getElementById('video-prompt').style.display = 'none';
                                    const ph = document.getElementById('placeholder');
                                    if (ph) ph.style.display = 'none';
                                    return;
                                }

                                // 涂鸦数据处理
                                if (status.action === 'draw_state_sync') { applyDrawStateSync(status); return; }
                                if (status.action === 'draw' || status.action === 'clear' || status.action === 'draw_begin' || status.action === 'draw_chunk' || status.action === 'draw_end' || status.action === 'draw_clear') { handleIncomingDraw(status); return; }
                                if (status.action === 'draw_resync_data') { applyDrawResyncData(status); return; }

                                if (status.action === 'mute_all') {
                                    if (window.agoraModule && typeof window.agoraModule.forceMuteLocal === 'function') window.agoraModule.forceMuteLocal();
                                    return;
                                }
                                if (status.action === 'unmute_all') {
                                    if (window.agoraModule && typeof window.agoraModule.forceUnmuteLocal === 'function') window.agoraModule.forceUnmuteLocal();
                                    return;
                                }

                                if (status.action === 'enable_control') {
                                    const ctrls = document.querySelector('.controls-container');
                                    if (ctrls) ctrls.style.display = status.enabled ? 'flex' : 'none';
                                    viewerControlEnabled = !!status.enabled;
                                    enableControls(isConnected && viewerControlEnabled);
                                    return;
                                }

                            } catch (e) {
                                console.error('解析状态消息失败:', e);
                            }
                        }
                    });

                    mqttClient.on('error', (err) => {
                        console.error('MQTT 错误:', err);
                        updateStatus('连接失败', false);
                    });

                    mqttClient.on('close', () => {
                        isConnected = false;
                        updateStatus('未连接', false);
                        enableControls(false);
                    });

                    mqttClient.on('reconnect', () => {
                        updateStatus('重连中... (3秒)', false);
                    });

                } catch (e) {
                    console.error('连接异常:', e);
                    updateStatus('连接失败', false);
                }
            }



            // 视频同步处理函数
            function handleVideoSync(video, cmd) {
                console.log('🎬 收到视频指令:', cmd);
                // 允许 0.5s 的误差
                if (Math.abs(video.currentTime - cmd.time) > 0.5) {
                    video.currentTime = cmd.time;
                }
                if (cmd.state === 'play') {
                    video.play().catch(e => console.log('自动播放受限:', e));
                } else if (cmd.state === 'pause') {
                    video.pause();
                }
            }

            function disconnect() {
                if (mqttClient) {
                    mqttClient.end(true);
                    mqttClient = null;
                }
                isConnected = false;
                updateStatus('已断开', false);
                enableControls(false);

                // 停止轮询
                stopStatusPolling();
            }

            function toggleConnection() {
                if (isConnected) {
                    disconnect();
                } else {
                    connectMQTT();
                }
            }

            function updateStatus(text, connected) {
                const dot = document.getElementById('statusDot');

                // 移除所有状态类
                dot.classList.remove('connected', 'connecting', 'error');

                if (connected) {
                    dot.classList.add('connected');  // 绿色
                } else if (text.includes('连接中') || text.includes('重连')) {
                    dot.classList.add('connecting');  // 黄色闪烁
                } else {
                    dot.classList.add('error');  // 红色
                }
            }

            // 主动请求函数（保留但不自动调用）
            // 可在需要时手动调用，例如添加手动刷新按钮

            function requestStatus() {
                if (!mqttClient || !mqttClient.connected) return;

                const requestMsg = {
                    action: 'request_status',
                    source: SESSION_ID,
                    t: Date.now()
                };

                mqttClient.publish(CONTROL_TOPIC, JSON.stringify(requestMsg), { qos: 0 });
                console.log('📤 已发送状态请求');
            }

            function enableControls(enabled) {
                document.getElementById('btnPrev').disabled = !enabled;
                document.getElementById('btnNext').disabled = !enabled;
                document.getElementById('btnGoto').disabled = true;
                document.getElementById('gotoInput').disabled = true;
            }

            function updatePageInfo() {
                const pageInfo = document.getElementById('pageInfo');
                if (totalPages > 0) {
                    pageInfo.textContent = `${currentPage} / ${totalPages}`;
                    pageInfo.style.display = 'block';
                } else {
                    pageInfo.style.display = 'none';
                }
            }

            // 检测是否为图片或视频 URL
            // 检测是否为图片或视频 URL
            function isMediaUrl(url) {
                const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
                const videoExtensions = ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv'];
                try {
                    // 简单粗暴的字符串匹配，防止 URL 解析失败
                    const lowerUrl = decodeURIComponent(url).toLowerCase();

                    // 检查是否为流媒体网站的嵌入链接
                    if (lowerUrl.includes('bilibili.com') || lowerUrl.includes('youtube.com')) {
                        return { isImage: false, isVideo: true, isMedia: true };
                    }

                    // 检查 extension 是否在 url 中出现 (通常在末尾或者 ? 前面)
                    // 移除 query 参数
                    const urlNoQuery = lowerUrl.split('?')[0];

                    const isImage = imageExtensions.some(ext => urlNoQuery.endsWith('.' + ext));
                    const isVideo = videoExtensions.some(ext => urlNoQuery.endsWith('.' + ext));

                    // 保底：如果 split 失败，直接 match
                    if (!isImage && !isVideo) {
                        // 尝试在完整的 URL 中查找 .ext
                        return {
                            isImage: imageExtensions.some(ext => lowerUrl.includes('.' + ext)),
                            isVideo: videoExtensions.some(ext => lowerUrl.includes('.' + ext)),
                            isMedia: true
                        };
                    }

                    return { isImage, isVideo, isMedia: isImage || isVideo };
                } catch (e) {
                    console.error('URL解析错误:', e);
                    return { isImage: false, isVideo: false, isMedia: false };
                }
            }

            // 加载 PDF、图片或视频文件
            async function loadPDF(pdfUrl) {
                try {
                    console.log('📄 加载文件:', pdfUrl);

                    // 显示加载提示
                    const placeholder = document.getElementById('placeholder');
                    placeholder.innerHTML = '<div class="icon">⏳</div><div>加载中...</div>';
                    placeholder.style.display = 'flex';

                    // 隐藏之前的显示元素
                    document.getElementById('pdfCanvas').style.display = 'none';
                    document.getElementById('imageDisplay').style.display = 'none';
                    document.getElementById('videoDisplay').style.display = 'none';

                    // 隐藏可能存在的 iframe
                    const existingIframe = document.getElementById('officeIframe');
                    if (existingIframe) {
                        existingIframe.style.display = 'none';
                    }

                    // 隐藏可能存在的视频播放 iframe
                    const videoIframe = document.getElementById('videoIframe');
                    if (videoIframe) {
                        videoIframe.style.display = 'none';
                        videoIframe.src = '';
                    }
                    document.getElementById('video-prompt').style.display = 'none';

                    // 【互斥逻辑】如果正在呈现PPT，隐藏屏幕分享
                    const stage = document.getElementById('agora-video-stage');
                    if (stage) stage.style.display = 'none';

                    // 检测是否为 KKFileView 预览页面（Excel 等）
                    if (pdfUrl.includes('/onlinePreview')) {
                        console.log('🖼️ 检测到 KKFileView 预览页面，使用 iframe 显示');

                        // 创建或更新 iframe
                        let iframe = document.getElementById('officeIframe');
                        if (!iframe) {
                            iframe = document.createElement('iframe');
                            iframe.id = 'officeIframe';
                            iframe.style.cssText = 'width:100%; height:100%; border:none; background:white; display:none;';
                            document.getElementById('previewScreen').appendChild(iframe);
                        }

                        iframe.onload = () => {
                            console.log('✅ KKFileView 预览加载成功');
                            placeholder.style.display = 'none';
                            iframe.style.display = 'block';

                            // 设置页码信息
                            totalPages = 1;
                            currentPage = 1;
                            updatePageInfo();
                        };

                        iframe.onerror = () => {
                            console.error('❌ KKFileView 预览加载失败:', pdfUrl);
                            placeholder.innerHTML = '<div class="icon">❌</div><div>预览加载失败</div>';
                        };

                        iframe.src = pdfUrl;
                        pdfDoc = null;
                        return;
                    }

                    // 检测文件类型
                    const mediaType = isMediaUrl(pdfUrl);

                    if (mediaType.isVideo) {
                        console.log('🎬 检测到视频推送，尝试自动播放');
                        pendingVideoUrl = pdfUrl;

                        // 显示文件名提示
                        try {
                            const fname = decodeURIComponent(pdfUrl.split('/').pop().split('?')[0]);
                            document.getElementById('video-filename').textContent = fname;
                        } catch (e) { }

                        document.getElementById('placeholder').style.display = 'none';
                        document.getElementById('video-prompt').style.display = 'none';

                        // 视频只有一页
                        totalPages = 1;
                        currentPage = 1;
                        updatePageInfo();

                        pdfDoc = null;

                        // 自动播放
                        setTimeout(playVideoInIframe, 100);
                    } else if (mediaType.isImage) {
                        console.log('🖼️ 检测到图片文件，使用图片显示');
                        const imgEl = document.getElementById('imageDisplay');

                        imgEl.onload = () => {
                            console.log('✅ 图片加载成功');
                            placeholder.style.display = 'none';
                            imgEl.style.display = 'block';

                            // 图片只有一页
                            totalPages = 1;
                            currentPage = 1;
                            updatePageInfo();
                        };

                        imgEl.onerror = () => {
                            console.warn('图片加载失败（可能演示已结束）:', pdfUrl);
                            // 不再在 UI 上显示错误，演示结束时 closePresentation 会自动处理
                        };

                        imgEl.src = pdfUrl;
                        pdfDoc = null; // 清除 PDF 文档对象
                    } else {
                        // PDF 文件处理
                        console.log('📄 检测到 PDF 文件');
                        const loadingTask = pdfjsLib.getDocument(pdfUrl);
                        pdfDoc = await loadingTask.promise;
                        totalPages = pdfDoc.numPages;
                        if (!currentPage || currentPage < 1) currentPage = 1;
                        if (currentPage > totalPages) currentPage = totalPages;

                        console.log('✅ PDF 加载成功，共', pdfDoc.numPages, '页');

                        // 隐藏占位符，显示 Canvas
                        placeholder.style.display = 'none';
                        document.getElementById('pdfCanvas').style.display = 'block';
                        updatePageInfo();

                        // 渲染当前页
                        if (currentPage > 0) {
                            renderPage(currentPage);
                        }
                    }
                } catch (error) {
                    console.error('❌ 文件加载失败:', error);
                    const placeholder = document.getElementById('placeholder');
                    placeholder.innerHTML = '<div class="icon">❌</div><div>加载失败: ' + error.message + '</div>';
                    placeholder.style.display = 'flex';
                }
            }

            // 渲染防抖 + 取消机制：防止快速翻页崩溃
            let _viewerRenderRAF = null;
            let _viewerActiveRenderTask = null;
            let _mediaCleared = false; // 只清理一次其他媒体

            function renderPage(pageNum) {
                if (!pdfDoc || pageNum < 1 || pageNum > pdfDoc.numPages) return;

                // 取消之前排队的帧，只保留最新请求
                if (_viewerRenderRAF) {
                    cancelAnimationFrame(_viewerRenderRAF);
                    _viewerRenderRAF = null;
                }

                // 取消正在进行的渲染任务
                if (_viewerActiveRenderTask) {
                    try { _viewerActiveRenderTask.cancel(); } catch (e) { }
                    _viewerActiveRenderTask = null;
                }

                _viewerRenderRAF = requestAnimationFrame(() => {
                    _viewerRenderRAF = null;
                    _doViewerRenderPage(pageNum);
                });
            }

            async function _doViewerRenderPage(pageNum) {
                if (!pdfDoc || pageNum < 1 || pageNum > pdfDoc.numPages) return;

                // 首次渲染时清理其他媒体（只做一次，避免重复 DOM 操作）
                if (!_mediaCleared) {
                    _mediaCleared = true;
                    const imgDisplay = document.getElementById('imageDisplay');
                    if (imgDisplay) { imgDisplay.style.display = 'none'; imgDisplay.src = ''; }
                    const videoDisplay = document.getElementById('videoDisplay');
                    if (videoDisplay) { videoDisplay.style.display = 'none'; }
                    const videoPrompt = document.getElementById('video-prompt');
                    if (videoPrompt) videoPrompt.style.display = 'none';
                    const infoScreen = document.getElementById('info-screen');
                    if (infoScreen) infoScreen.style.display = 'none';
                    const officeIframe = document.getElementById('officeIframe');
                    if (officeIframe) officeIframe.style.display = 'none';
                    const videoIframe = document.getElementById('videoIframe');
                    if (videoIframe) { videoIframe.style.display = 'none'; videoIframe.src = ''; }
                    const placeholder = document.getElementById('placeholder');
                    if (placeholder) placeholder.style.display = 'none';
                }

                // Show canvas
                const canvas = document.getElementById('pdfCanvas');
                canvas.style.display = 'block';

                try {
                    const page = await pdfDoc.getPage(pageNum);
                    const ctx = canvas.getContext('2d');

                    const devicePixelRatio = window.devicePixelRatio || 1;
                    const container = document.getElementById('previewScreen');
                    const padding = document.fullscreenElement ? 0 : 40;
                    const containerWidth = container.clientWidth - padding;
                    const containerHeight = container.clientHeight - padding;

                    const viewport = page.getViewport({ scale: 1 });
                    const scaleX = containerWidth / viewport.width;
                    const scaleY = containerHeight / viewport.height;
                    const baseScale = Math.min(scaleX, scaleY);
                    const scale = Math.min(baseScale * devicePixelRatio, 3);
                    const scaledViewport = page.getViewport({ scale: scale });

                    canvas.width = scaledViewport.width;
                    canvas.height = scaledViewport.height;
                    canvas.style.width = (scaledViewport.width / devicePixelRatio) + 'px';
                    canvas.style.height = (scaledViewport.height / devicePixelRatio) + 'px';

                    const renderContext = {
                        canvasContext: ctx,
                        viewport: scaledViewport
                    };

                    _viewerActiveRenderTask = page.render(renderContext);
                    await _viewerActiveRenderTask.promise;
                    _viewerActiveRenderTask = null;
                    console.log('✓ 页面', pageNum, '渲染完成');
                } catch (error) {
                    _viewerActiveRenderTask = null;
                    if (error.name !== 'RenderingCancelledException') {
                        console.error('渲染失败:', error);
                    }
                }
            }
            // (Old playVideoInIframe removed as it's dead code, a newer version exists below)

            // 监听窗口大小变化（全屏/退出全屏时自动重绘）
            // (Moved to the end of file to handle all media types)

            // 设置纯净的页面标题，减少全屏提示干扰
            document.title = "PPT";

            function sendCommand(action, fromButton = false) {
                if (!mqttClient || !isConnected) {
                    alert('请先连接 MQTT 服务器');
                    return;
                }

                if (!viewerControlEnabled) return;
                if (action === 'next' || action === 'prev') {
                    if (!fromButton) return;
                    const now = Date.now();
                    if (now - lastRemoteFlipAt < 2000) return;
                    lastRemoteFlipAt = now;
                }

                const msgId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
                const command = {
                    action: action,
                    source: SESSION_ID,
                    msgId: msgId,
                    t: Date.now()
                };

                mqttClient.publish(CONTROL_TOPIC, JSON.stringify(command), { qos: 1 }, (err) => {
                    if (err) {
                        console.error('发送失败:', err);
                    } else {
                        console.log('✓ 指令已发送:', action);
                    }
                });
            }

            function sendGotoCommand() {
                return;
            }

            // 键盘快捷键支持
            document.addEventListener('keydown', (e) => {
                // F 键全屏随叫随到，不仅限于连接状态
                if (e.key === 'f' || e.key === 'F') {
                    e.preventDefault();
                    toggleFullscreen();
                    return;
                }

                // 其余业务操控（翻页等）需要连接状态才执行
                if (!isConnected) return;

                return;
            });

            // 复制会议链接
            function copyMeetingLink() {
                const urlElement = document.getElementById('info-url');
                const meetingUrl = urlElement.textContent;

                if (!meetingUrl) {
                    alert('没有可复制的会议链接');
                    return;
                }

                // 复制到剪贴板
                navigator.clipboard.writeText(meetingUrl).then(() => {
                    // 找到按钮元素
                    const button = event.target;
                    const originalText = button.innerHTML;

                    // 显示成功反馈
                    button.innerHTML = '✅ 已复制';
                    button.style.background = '#4caf50';

                    // 2秒后恢复原样
                    setTimeout(() => {
                        button.innerHTML = originalText;
                        button.style.background = '#1976d2';
                    }, 2000);
                }).catch(err => {
                    console.error('复制失败:', err);
                    alert('复制失败，请手动复制链接');
                });
            }

            // ==================== 涂鸦功能 ====================
            let remoteDrawCanvas, remoteDrawCtx;
            const seenDrawIds = new Map();
            const latestSnapshotSidByPage = new Map();
            const drawExpectedSeqByPage = new Map();
            const drawPendingByPage = new Map();
            const activeStrokeMeta = new Map();
            const drawResyncRequestedAt = new Map();
            const latestDrawStateVerByPage = new Map();
            let remoteCurrentPage = 0;

            function initRemoteDrawCanvas() {
                remoteDrawCanvas = document.getElementById('drawCanvas');
                let targetEl = document.getElementById('pdfCanvas');
                const imgEl = document.getElementById('imageDisplay');
                const videoEl = document.getElementById('videoDisplay'); // 本地视频元素
                const videoIframe = document.getElementById('videoIframe'); // 外部视频iframe

                if (imgEl && imgEl.style.display !== 'none') {
                    targetEl = imgEl;
                } else if (videoEl && videoEl.style.display !== 'none') {
                    targetEl = videoEl;
                } else if (videoIframe && videoIframe.style.display !== 'none') {
                    // iframe 无法覆盖涂鸦，暂时不支持
                    return;
                }

                if (!targetEl || getComputedStyle(targetEl).display === 'none') {
                    return;
                }

                // Use rect-based positioning to avoid offset drift under transforms/flex scaling.
                const container = document.getElementById('previewScreen');
                const targetRect = targetEl.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();

                remoteDrawCanvas.style.display = 'block';

                // 设置位置
                remoteDrawCanvas.style.left = (targetRect.left - containerRect.left) + 'px';
                remoteDrawCanvas.style.top = (targetRect.top - containerRect.top) + 'px';
                remoteDrawCanvas.style.width = targetRect.width + 'px';
                remoteDrawCanvas.style.height = targetRect.height + 'px';

                // 设置分辨率
                if (targetEl.tagName === 'CANVAS') {
                    remoteDrawCanvas.width = targetEl.width;
                    remoteDrawCanvas.height = targetEl.height;
                } else {
                    const dpr = window.devicePixelRatio || 1;
                    remoteDrawCanvas.width = Math.max(1, Math.round(targetRect.width * dpr));
                    remoteDrawCanvas.height = Math.max(1, Math.round(targetRect.height * dpr));
                }

                remoteDrawCtx = remoteDrawCanvas.getContext('2d');
                remoteDrawCtx.lineCap = 'round';
                remoteDrawCtx.lineJoin = 'round';

                console.log('✅ 涂鸦画布已初始化', targetEl.tagName);
            }

            function handleDrawData(data) {
                // Backward compatibility with old format draw events.
                if (!data || data.page !== currentPage) return;
                if (!remoteDrawCtx) initRemoteDrawCanvas();
                if (!remoteDrawCtx) return;

                const fromX = data.from.x * remoteDrawCanvas.width;
                const fromY = data.from.y * remoteDrawCanvas.height;
                const toX = data.to.x * remoteDrawCanvas.width;
                const toY = data.to.y * remoteDrawCanvas.height;

                remoteDrawCtx.beginPath();
                remoteDrawCtx.moveTo(fromX, fromY);
                remoteDrawCtx.lineTo(toX, toY);

                const rect = remoteDrawCanvas.getBoundingClientRect();
                const scaleX = remoteDrawCanvas.width / rect.width;
                const effectiveLineWidth = data.size * scaleX;

                if (data.tool === 'pen') {
                    remoteDrawCtx.strokeStyle = data.color;
                    remoteDrawCtx.lineWidth = effectiveLineWidth;
                    remoteDrawCtx.globalCompositeOperation = 'source-over';
                } else {
                    remoteDrawCtx.globalCompositeOperation = 'destination-out';
                    remoteDrawCtx.lineWidth = effectiveLineWidth * 10;
                }
                remoteDrawCtx.stroke();
            }

            function getExpectedSeq(page) {
                return Number(drawExpectedSeqByPage.get(page) || 1);
            }

            function setExpectedSeq(page, seq) {
                drawExpectedSeqByPage.set(page, Number(seq));
            }

            function requestDrawResync(page, fromSeq) {
                if (!mqttClient || !isConnected) return;
                const now = Date.now();
                const key = String(page) + ':' + String(fromSeq);
                const prev = Number(drawResyncRequestedAt.get(key) || 0);
                if (now - prev < 800) return;
                drawResyncRequestedAt.set(key, now);
                mqttClient.publish(STATUS_TOPIC, JSON.stringify({
                    action: 'draw_resync_request',
                    page,
                    fromSeq,
                    source: SESSION_ID,
                    t: now
                }), { qos: 1 });
            }

            function queuePendingDraw(page, msg) {
                const mp = drawPendingByPage.get(page) || new Map();
                mp.set(Number(msg.seq), msg);
                drawPendingByPage.set(page, mp);
            }

            function applyOneDrawMessage(msg) {
                const page = Number(msg.page || 0);
                if (page !== currentPage) return;
                if (!remoteDrawCtx) initRemoteDrawCanvas();
                if (!remoteDrawCtx || !remoteDrawCanvas) return;

                if (msg.action === 'draw_clear' || msg.action === 'clear') {
                    clearRemoteDrawing();
                    activeStrokeMeta.clear();
                    return;
                }

                if (msg.action === 'draw_begin') {
                    activeStrokeMeta.set(msg.strokeId, { tool: msg.tool, color: msg.color, size: msg.size });
                    const pts = Array.isArray(msg.points) ? msg.points : [];
                    if (pts.length >= 2) {
                        drawChunkWithMeta(msg, pts);
                    }
                    return;
                }

                if (msg.action === 'draw_chunk') {
                    const pts = Array.isArray(msg.points) ? msg.points : [];
                    if (pts.length >= 2) drawChunkWithMeta(msg, pts);
                    return;
                }

                if (msg.action === 'draw_end') {
                    activeStrokeMeta.delete(msg.strokeId);
                    return;
                }

                if (msg.action === 'draw') {
                    handleDrawData(msg);
                }
            }

            function drawChunkWithMeta(msg, pts) {
                const meta = activeStrokeMeta.get(msg.strokeId) || msg;
                const rect = remoteDrawCanvas.getBoundingClientRect();
                const scaleX = remoteDrawCanvas.width / rect.width;
                const effectiveLineWidth = Number(meta.size || msg.size || 3) * scaleX;

                remoteDrawCtx.beginPath();
                const p0 = pts[0];
                remoteDrawCtx.moveTo(p0.x * remoteDrawCanvas.width, p0.y * remoteDrawCanvas.height);
                for (let i = 1; i < pts.length; i++) {
                    const p = pts[i];
                    remoteDrawCtx.lineTo(p.x * remoteDrawCanvas.width, p.y * remoteDrawCanvas.height);
                }

                if ((meta.tool || msg.tool) === 'pen') {
                    remoteDrawCtx.strokeStyle = meta.color || msg.color || '#ff0000';
                    remoteDrawCtx.lineWidth = effectiveLineWidth;
                    remoteDrawCtx.globalCompositeOperation = 'source-over';
                } else {
                    remoteDrawCtx.globalCompositeOperation = 'destination-out';
                    remoteDrawCtx.lineWidth = effectiveLineWidth * 10;
                }
                remoteDrawCtx.stroke();
            }

            function drainPending(page) {
                const mp = drawPendingByPage.get(page);
                if (!mp) return;
                let exp = getExpectedSeq(page);
                while (mp.has(exp)) {
                    const m = mp.get(exp);
                    mp.delete(exp);
                    applyOneDrawMessage(m);
                    exp++;
                }
                setExpectedSeq(page, exp);
            }

            function handleIncomingDraw(msg) {
                const page = Number(msg.page || 0);
                if (!page) return;
                const seq = Number(msg.seq || 0);
                if (!seq) {
                    applyOneDrawMessage(msg);
                    return;
                }

                const expected = getExpectedSeq(page);
                if (seq < expected) return;
                if (seq > expected) {
                    queuePendingDraw(page, msg);
                    requestDrawResync(page, expected);
                    return;
                }

                applyOneDrawMessage(msg);
                setExpectedSeq(page, expected + 1);
                drainPending(page);
            }

            function applyDrawResyncData(payload) {
                const page = Number(payload.page || 0);
                if (!page) return;
                const events = Array.isArray(payload.events) ? payload.events.slice() : [];
                events.sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
                for (const e of events) {
                    handleIncomingDraw(e);
                }
            }

            function applyDrawStateSync(payload) {
                const page = Number(payload.page || 0);
                if (!page || page !== currentPage) return;
                const ver = Number(payload.ver || 0);
                const lastVer = Number(latestDrawStateVerByPage.get(page) || 0);
                if (ver && ver < lastVer) return;
                if (ver) latestDrawStateVerByPage.set(page, ver);

                if (!remoteDrawCtx) initRemoteDrawCanvas();
                if (!remoteDrawCtx || !remoteDrawCanvas) return;

                const strokes = Array.isArray(payload.strokes) ? payload.strokes : [];
                clearRemoteDrawing();
                activeStrokeMeta.clear();

                for (const s of strokes) {
                    const pts = Array.isArray(s.points) ? s.points : [];
                    if (pts.length < 2) continue;
                    drawChunkWithMeta({
                        strokeId: 'sync_' + Math.random().toString(36).slice(2, 7),
                        tool: s.tool,
                        color: s.color,
                        size: s.size
                    }, pts);
                }
            }


            function applyDrawSnapshot(data) { }

            function clearRemoteDrawing() {
                if (remoteDrawCtx) {
                    remoteDrawCtx.clearRect(0, 0, remoteDrawCanvas.width, remoteDrawCanvas.height);
                }
            }

            // 监听页面切换，重新初始化涂鸦画布
            let remotePreviousPage = 0;
            setInterval(() => {
                if (currentPage !== remotePreviousPage) {
                    clearRemoteDrawing();
                    // 只要有内容显示，就尝试初始化涂鸦层
                    const pdfVisible = document.getElementById('pdfCanvas').style.display !== 'none';
                    const imgVisible = document.getElementById('imageDisplay').style.display !== 'none';
                    const videoVisible = document.getElementById('videoDisplay').style.display !== 'none';

                    if (pdfVisible || imgVisible || videoVisible) {
                        setTimeout(initRemoteDrawCanvas, 200); // 延迟初始化
                    }
                    remotePreviousPage = currentPage;
                }
            }, 100);

            // 监听窗口大小变化
            window.addEventListener('resize', () => {
                // PDF重绘
                if (pdfDoc && currentPage > 0) {
                    clearTimeout(window.resizeTimer);
                    window.resizeTimer = setTimeout(() => {
                        renderPage(currentPage);
                        // PDF渲染后会自动调用 sizes，但为了保险：
                        setTimeout(initRemoteDrawCanvas, 50);
                    }, 100);
                } else {
                    // 图片/视频模式下也要重新调整涂鸦层大小
                    setTimeout(initRemoteDrawCanvas, 100);
                }
            });

// Add playVideoInIframe function
            function playVideoInIframe() {
                const prompt = document.getElementById('video-prompt');
                prompt.style.display = 'none';

                if (!pendingVideoUrl) return;

                // 视频开始时，自动折叠右侧控制图标，避免遮挡播放器控制栏
                if (typeof window.agoraCollapseCtrlPanel === 'function') {
                    window.agoraCollapseCtrlPanel(true);
                }


                // 隐藏其他层
                document.getElementById('pdfCanvas').style.display = 'none';
                document.getElementById('imageDisplay').style.display = 'none';
                const officeIframe = document.getElementById('officeIframe');
                if (officeIframe) officeIframe.style.display = 'none';

                // 判断是否是外部链接 (Bilibili/YouTube)
                const isExternal = pendingVideoUrl.includes('player.bilibili.com') || pendingVideoUrl.includes('youtube.com');

                if (isExternal) {
                    let videoIframe = document.getElementById('videoIframe');
                    if (!videoIframe) {
                        videoIframe = document.createElement('iframe');
                        videoIframe.id = 'videoIframe';
                        videoIframe.style.cssText = 'width:100%; height:100%; border:none; background:black; position:absolute; top:0; left:0; z-index:200;';
                        videoIframe.allow = "autoplay; fullscreen";
                        document.body.appendChild(videoIframe);
                    }
                    videoIframe.src = pendingVideoUrl;
                    videoIframe.style.display = 'block';
                } else {
                    // MP4 / WebM
                    const videoEl = document.getElementById('videoDisplay');
                    videoEl.src = pendingVideoUrl;
                    videoEl.style.display = 'block';
                    videoEl.muted = false; // 确保有声

                    const playPromise = videoEl.play();
                    if (playPromise !== undefined) {
                        playPromise.catch(error => {
                            console.log('Auto-play failed, showing prompt:', error);
                            prompt.style.display = 'flex';
                            prompt.style.zIndex = '99999';
                        });
                    }
                }
            }

            if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                    navigator.serviceWorker.register('./sw.js')
                        .then(registration => {
                            console.log('ServiceWorker registration successful with scope: ', registration.scope);
                        })
                        .catch(err => {
                            console.log('ServiceWorker registration failed: ', err);
                        });
                });
            }