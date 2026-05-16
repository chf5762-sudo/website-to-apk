
            function showStartNowModal() {
                // Requirement: Auto pause when clicking "Start Now" button to manage meetings
                if (window.agoraModule) window.agoraModule.setPresenterWatchPaused(true);
                openModal('start-now');
            }
        


        // ================= 配置区 =================
        const API_BASE_URL = window.location.origin; // 自动获取当前域名
        const CONFIG = {
            API_BASE: API_BASE_URL,
            // 注意：这里的 URL 是前端访问 Worker 代理的地址
            KKFILEVIEW: { URL: API_BASE_URL + "/api/kkfileview" },
            MQTT: { BEMFA_KEY: '3eb42d69d8b226abe22024d648975f8a', BROKER: 'ws://broker.emqx.io:8083/mqtt', TOPIC: 'PPT001', STATUS_TOPIC: 'PPT002' },
            PREVIEW_TOKEN: "Allow_Public_Preview_Access_2025"
        };
        // ============================================

        // 核心工具：Unicode 兼容的 Base64 编码
        function utf8_to_b64(str) {
            return window.btoa(unescape(encodeURIComponent(str)));
        }

        let currentPath = "", selectedFile = null, ctxFile = null, moveCopyMode = "", filesList = [], draggedFile = null, customOrders = {}, mqttClient = null, presentationFile = null, currentPage = 1, totalPages = 0, mqttStats = { sent: 0, received: 0 }, currentPdfUrl = null;
        let lastSyncedStateJson = '', lastSyncTime = 0;
        let presentationSessionToken = 0;
        let drawSeq = 0;
        const processedCommandIds = new Map();
        let isLoopMode = false;
        let isSecureMode = false; // 默认关闭防护 (调试模式)
        let isMuteAllMode = false; // 全体静音状态
        let isViewerCtrlMode = false; // 观众翻页状态
        let isViewerSharingMode = true; // 观众投屏状态
        let isViewerMicMode = true; // 观众麦克风权限
        let isViewerVideoMode = true; // 观众摄像头权限

        // 持久化 Session ID，防止刷新页面导致参会者列表堆积
        if (!localStorage.getItem('sync_master_id')) {
            localStorage.setItem('sync_master_id', 'master_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5));
        }
        const mySessionId = localStorage.getItem('sync_master_id');
        let adminCommandPollTimer = null;
        let adminStateSyncTimer = null;
        let adminCommandSince = 0;

        // --- 演示控制项配置 ---
        const PRESENTATION_CONFIG = [
            { id: 'settings-draw-visible', label: '开启涂鸦', icon: '🎨', toggle: 'toggleDrawToolsVisibility', getStatus: () => { const g = document.getElementById('draw-tools-group'); return g && g.style.display !== 'none'; } },
            { id: 'mute-all', label: '全体静音', icon: '🔇', toggle: 'muteAllRemote', getStatus: () => isMuteAllMode },
            { id: 'viewer-ctrl', label: '观众翻页', icon: '🎮', toggle: 'toggleViewerControl', getStatus: () => isViewerCtrlMode },
            { id: 'viewer-sharing', label: '观众投屏', icon: '🔒', toggle: 'toggleViewerSharing', getStatus: () => isViewerSharingMode },
            { id: 'viewer-mic', label: '观众麦克风', icon: '🎤', toggle: 'toggleViewerMic', getStatus: () => isViewerMicMode },
            { id: 'viewer-video', label: '观众摄像头', icon: '📷', toggle: 'toggleViewerVideo', getStatus: () => isViewerVideoMode },
            { id: 'qr-share', label: '分享二维码', icon: '📱', toggle: 'showMobileQRCode', getStatus: () => false },
            { id: 'loop', label: '循环播放', icon: '🔁', toggle: 'toggleLoopMode', getStatus: () => isLoopMode }
        ];

        function renderPresSettingsMenu() {
            const container = document.getElementById('pres-settings-menu');
            if (!container) return;
            container.innerHTML = PRESENTATION_CONFIG.map(item => {
                const active = item.getStatus();
                return `
                    <div class="pres-settings-item ${active ? 'active' : ''}" onclick="window['${item.toggle}'](); event.stopPropagation();">
                        <div style="display:flex; align-items:center;">
                            <div class="status-dot"></div>
                            <span class="toggle-label">${item.icon} ${item.label}</span>
                        </div>
                        <span class="status-text">${active ? '已开启' : '已关闭'}</span>
                    </div>
                `;
            }).join('');
        }

        function togglePresSettingsMenu() {
            const menu = document.getElementById('pres-settings-menu');
            const btn = document.getElementById('btn-pres-settings');
            if (menu.style.display === 'block') {
                menu.style.display = 'none';
                btn.classList.remove('active');
                document.removeEventListener('click', closePresSettingsMenu);
            } else {
                renderPresSettingsMenu();
                menu.style.display = 'block';
                btn.classList.add('active');
                setTimeout(() => {
                    document.addEventListener('click', closePresSettingsMenu);
                }, 10);
            }
        }

        function closePresSettingsMenu(e) {
            const menu = document.getElementById('pres-settings-menu');
            const btn = document.getElementById('btn-pres-settings');
            // 如果点击的是按钮本身，由 toggle 处理
            if (e && (btn.contains(e.target) || menu.contains(e.target))) return;
            
            if (menu) menu.style.display = 'none';
            if (btn) btn.classList.remove('active');
            document.removeEventListener('click', closePresSettingsMenu);
        }

        // --- MQTT 相关 ---
        function showStartNowModal() {
            openModal('start-now');
        }

        function startScreenShareDirectly() {
            closeModal('start-now');
            document.getElementById('presentation-mode').classList.add('active');

            // UI 状态切换为直播模式
            document.body.classList.add('is-live-streaming');
            document.getElementById('presentation-filename').textContent = "屏幕直播中";

            const pageInfo = document.getElementById('page-info');
            if (pageInfo) pageInfo.innerHTML = '<span style="color:#ff5c5c; font-weight:bold;">● LIVE</span>';

            const canvasContainer = document.getElementById('presentation-canvas-container');
            if(canvasContainer) {
                // 不再清空内部 DOM，改为隐藏子元素，保留 Canvas
                const children = canvasContainer.children;
                for (let i = 0; i < children.length; i++) {
                    children[i].style.display = 'none';
                }
                canvasContainer.style.display = 'flex';
                canvasContainer.style.background = '#000';
            }

            // 隐藏翻页按钮和涂鸦工具（直播时无效）
            const navOverlay = document.querySelector('.page-nav-overlay');
            if(navOverlay) navOverlay.style.display = 'none';
            const drawTools = document.getElementById('draw-tools-group');
            if(drawTools) drawTools.style.display = 'none';

            if (window.agoraModule && window.agoraModule.startScreenShare) {
                window.agoraModule.startScreenShare();
            }
        }

        function topicSig(input) {
            // Simple deterministic signature for room/topic names.
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
            const sig = topicSig(`${CONFIG.MQTT.BEMFA_KEY}:${baseName}`).slice(0, 8);
            return `_${baseName}_${sig}`;
        }

        function initMQTT(forceSlug = null) {
            if (forceSlug !== null) window.currentRoomSlug = forceSlug;
            
            try {
                if (mqttClient) {
                    try { mqttClient.end(true); } catch(e){}
                }
                const rawName = window.sessionUsername || 'admin';
                const uname = rawName.replace(/_\d+$/, ''); // 剥离 _01 编号
                
                let baseName = uname;
                if (window.currentRoomSlug) {
                    baseName += '_' + window.currentRoomSlug;
                }
                
                const suffix = buildTopicSuffix(baseName);
                // 使用 BEMFA_KEY 作为 Topic 前缀确保在公共 Broker 上的私密性
                CONFIG.MQTT.TOPIC = CONFIG.MQTT.BEMFA_KEY + '/PPT001' + suffix;
                CONFIG.MQTT.STATUS_TOPIC = CONFIG.MQTT.BEMFA_KEY + '/PPT002' + suffix;
                window.STATUS_TOPIC = CONFIG.MQTT.STATUS_TOPIC; // 暴露给音视频模块使用

                console.log('正在连接MQTT...', CONFIG.MQTT.BROKER, 'TOPIC:', CONFIG.MQTT.TOPIC);
                document.getElementById('mqtt-status-text').textContent = 'MQTT: 连接中...';

                // 使用随机 sessionId 作为 clientId，身份在协议层生效，多端不互踢
                window.mqttClient = mqttClient = mqtt.connect(CONFIG.MQTT.BROKER, {
                    clientId: mySessionId,
                    clean: true,
                    connectTimeout: 4000,
                    reconnectPeriod: 3000,
                    protocolVersion: 4
                });

                mqttClient.on('connect', () => {
                    console.log('✅ WebSocket连接成功,正在订阅主题...');
                    document.getElementById('mqtt-status-text').textContent = 'MQTT: 订阅中...';

                    mqttClient.subscribe(CONFIG.MQTT.TOPIC, { qos: 0 }, (err) => {
                        if (!err) {
                            console.log('✅ 成功订阅主题:', CONFIG.MQTT.TOPIC);
                            document.getElementById('mqtt-indicator').classList.add('connected');
                            document.getElementById('mqtt-status-text').textContent = 'MQTT: 已连接';
                            
                            // 也订阅状态主题，以接收其他人共享屏幕等广播
                            mqttClient.subscribe(CONFIG.MQTT.STATUS_TOPIC, { qos: 0 });

                            // 发送踢人广播
                            console.log('📢 发送登录广播 (Kick others)...');
                            mqttClient.publish(CONFIG.MQTT.TOPIC, JSON.stringify({ action: 'kick_presence', sessionId: mySessionId }), { qos: 0 });

                            // 刷新后也主动加入 Agora 观看通道，确保能继续看到 remote 正在进行的投屏
                            if (window.agoraModule && typeof window.agoraModule.ensureViewerJoined === 'function') {
                                window.agoraModule.ensureViewerJoined().catch(e => console.warn('[Presenter] ensureViewerJoined failed:', e));
                            }

                            // 立即发送当前状态（如果正在演示）
                            if (presentationFile && pdfDoc) {
                                console.log('📤 发送当前演示状态给遥控器...');
                                publishStatus('presenting');
                            } else {
                                publishStatus('idle');
                            }
                            startAdminHttpControlLoop();
                            startAdminStateSyncLoop();
                            // Presence is now managed via HTTP heartbeat, no MQTT broadcast needed
                        } else {
                            console.error('❌ 订阅失败:', err);
                            document.getElementById('mqtt-indicator').classList.add('error');
                            document.getElementById('mqtt-status-text').textContent = 'MQTT: 订阅失败 - ' + err.message;
                        }
                    });
                });
                mqttClient.on('message', (topic, message) => {
                    mqttStats.received++;
                    handleMQTTCommand(message.toString());
                });

                mqttClient.on('error', (err) => {
                    console.error('❌ MQTT错误:', err);
                    document.getElementById('mqtt-indicator').classList.add('error');
                    document.getElementById('mqtt-status-text').textContent = 'MQTT: 错误 - ' + err.message;
                });

                mqttClient.on('close', () => {
                    console.log('MQTT连接关闭');
                    document.getElementById('mqtt-indicator').classList.remove('connected');
                    document.getElementById('mqtt-indicator').classList.remove('error');
                    document.getElementById('mqtt-status-text').textContent = 'MQTT: 断开';
                });

                mqttClient.on('offline', () => {
                    console.log('⚠️ MQTT离线');
                    document.getElementById('mqtt-status-text').textContent = 'MQTT: 离线';
                });

                mqttClient.on('reconnect', () => {
                    console.log('🔄 MQTT重连中... (3秒后重试)');
                    document.getElementById('mqtt-status-text').textContent = 'MQTT: 重连中... (3秒)';
                });
            } catch (e) {
                console.error('MQTT初始化失败:', e);
                document.getElementById('mqtt-status-text').textContent = 'MQTT: 初始化失败';
            }
        }

        /* --- 互动讨论逻辑 --- */
        function getAdminRoomId() {
            return CONFIG.MQTT.STATUS_TOPIC || 'PPT002';
        }

        function executeApiControlCommand(cmd) {
            if (!cmd || !cmd.action) return;
            switch (cmd.action) {
                case 'next': nextPageOrFile(); break;
                case 'prev': prevPageOrFile(); break;
                case 'goto': if (cmd.page !== undefined && cmd.page !== null) gotoPage(cmd.page); break;
                case 'exit': exitPresentation(); break;
                case 'fullscreen': toggleFullScreen(); break;
                case 'viewer_ctrl_on': if (!isViewerCtrlMode) toggleViewerControl(); break;
                case 'viewer_ctrl_off': if (isViewerCtrlMode) toggleViewerControl(); break;
            }
        }

        async function pollAdminHttpCommands() {
            try {
                const roomId = getAdminRoomId();
                const url = `${CONFIG.API_BASE}/api/admin/command?roomId=${encodeURIComponent(roomId)}&since=${encodeURIComponent(adminCommandSince)}&limit=50`;
                const res = await fetch(url, { credentials: 'include' });
                if (!res.ok) return;
                const data = await res.json();
                const commands = data && Array.isArray(data.commands) ? data.commands : [];
                for (const cmd of commands) {
                    const dedupeId = cmd.id || `${cmd.action}_${cmd.ts || 0}`;
                    if (processedCommandIds.has(dedupeId)) continue;
                    processedCommandIds.set(dedupeId, Date.now());
                    executeApiControlCommand(cmd);
                }
                if (data && Number.isFinite(Number(data.latestTs))) {
                    adminCommandSince = Math.max(adminCommandSince, Number(data.latestTs));
                }
            } catch (e) {}
        }

        function startAdminHttpControlLoop() {
            stopAdminHttpControlLoop();
            adminCommandSince = 0;
            pollAdminHttpCommands();
            adminCommandPollTimer = setInterval(pollAdminHttpCommands, 800);
        }

        function stopAdminHttpControlLoop() {
            if (adminCommandPollTimer) {
                clearInterval(adminCommandPollTimer);
                adminCommandPollTimer = null;
            }
        }

        async function syncAdminState(force = false) {
            try {
                const payload = {
                    roomId: getAdminRoomId(),
                    page: Number(currentPage || 0),
                    totalPages: Number(totalPages || 0),
                    status: presentationFile ? 'presenting' : 'idle',
                    isConnected: !!(mqttClient && mqttClient.connected),
                    isPresentation: !!presentationFile,
                    fileName: (presentationFile && presentationFile.name) ? presentationFile.name : '',
                    source: 'human'
                };

                const currentJson = JSON.stringify(payload);
                const now = Date.now();

                // 优化：只有在强制刷新、状态变化或超过30秒心跳周期时才发送 POST 请求（节省 KV 额度）
                if (!force && currentJson === lastSyncedStateJson && (now - lastSyncTime < 30000)) {
                    return;
                }

                lastSyncedStateJson = currentJson;
                lastSyncTime = now;

                await fetch(`${CONFIG.API_BASE}/api/admin/state`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: currentJson
                });
            } catch (e) {}
        }

        function startAdminStateSyncLoop() {
            stopAdminStateSyncLoop();
            syncAdminState();
            adminStateSyncTimer = setInterval(syncAdminState, 2000);
        }

        function stopAdminStateSyncLoop() {
            if (adminStateSyncTimer) {
                clearInterval(adminStateSyncTimer);
                adminStateSyncTimer = null;
            }
        }

        let onlineUsers = new Map();

        window.chatUnreadCount = 0;
        window.updateChatUnreadCount = function(count) {
            window.chatUnreadCount = count;
            const buttons = [
                document.getElementById('btn-toggle-discussion'),
                document.getElementById('agora-chat-btn'),
                document.getElementById('chat-fab')
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
        document.addEventListener('DOMContentLoaded', () => {
            initDiscussionSidebarEvents();
            
            // 监听屏幕分享停止事件，还原 UI
            window.addEventListener('agora-screen-share-stopped', () => {
                console.log('检测到屏幕分享停止，正在还原 UI...');
                
                // 1. 还原画布容器状态
                const canvasContainer = document.getElementById('presentation-canvas-container');
                if (canvasContainer) {
                    canvasContainer.style.background = ''; // 移除直播时的纯黑背景
                    const children = canvasContainer.children;
                    for (let i = 0; i < children.length; i++) {
                        const child = children[i];
                        // 跳过那些本身就是由代码控制显隐的元素
                        if (['presentation-loading', 'presentation-canvas', 'draw-canvas', 'presentation-image', 'presentation-video'].includes(child.id)) {
                            continue;
                        }
                        child.style.display = ''; // 恢复 CSS 默认显示
                    }
                }
                
                // 2. 还原翻页按钮
                const navOverlay = document.querySelector('.page-nav-overlay');
                if (navOverlay) navOverlay.style.display = 'flex';
                
                // 3. 还原文件名显示 (如果是从全屏直播退回)
                const filenameElem = document.getElementById('presentation-filename');
                if (filenameElem && filenameElem.textContent === "屏幕直播中") {
                    filenameElem.textContent = presentationFile ? presentationFile.name : "演示文稿";
                }
                
                // 4. 强制重绘/检查
                if (typeof renderPresSettingsMenu === 'function') renderPresSettingsMenu();
            });
        });

        function toggleDiscussion() {
            const sidebar = document.getElementById('discussion-sidebar');
            sidebar.classList.toggle('active');
            const icon = document.getElementById('toggle-icon');
            if (icon) icon.innerText = sidebar.classList.contains('active') ? '>' : '<';
            if (sidebar.classList.contains('active')) {
                if (window.updateChatUnreadCount) window.updateChatUnreadCount(0);
            }
        }

        function showDiscussionSidebarOnLogin() {
            const sidebar = document.getElementById('discussion-sidebar');
            if (!sidebar) return;
            
            // Only auto-open on desktop
            if (window.innerWidth > 768) {
                sidebar.classList.add('active');
            }
            
            if (window.updateChatUnreadCount) window.updateChatUnreadCount(0);
            const list = document.getElementById('discussion-user-list');
            const arrow = document.getElementById('user-list-arrow');
            if (list) {
                list.style.display = 'block';
                list.classList.add('active');
            }
            if (arrow) arrow.innerText = '▼';
            if (typeof renderUserList === 'function') renderUserList();
        }

        // 点击外部空白区域自动退出并隐藏侧边栏
        document.addEventListener('click', (e) => {
            const sidebar = document.getElementById('discussion-sidebar');
            const toggleIcon = document.getElementById('toggle-icon');
            if (sidebar && sidebar.classList.contains('active')) {
                // 判断点击的目标是否在侧边栏内部，或者是否是开关按钮
                if (!sidebar.contains(e.target) && toggleIcon && !toggleIcon.contains(e.target) && !e.target.closest('#toggle-icon') && !e.target.closest('button[onclick="toggleDiscussion()"]')) {
                    sidebar.classList.remove('active');
                    if (toggleIcon) toggleIcon.innerText = '<';
                }
            }
        });

        // HTTP Chat: roomId = STATUS_TOPIC (unique per room)
        let chatLastTimestamp = 0;
        let chatPollTimer = null;

        function getChatRoomId() {
            return CONFIG.MQTT.STATUS_TOPIC || 'default';
        }

        function sendChatMessage() {
            const input = document.getElementById('discussion-input');
            const text = input.value.trim();
            if (!text) return;

            const chatMsg = {
                roomId: getChatRoomId(),
                action: 'chat',
                sender: window.sessionUsername || '主播',
                sessionId: mySessionId,
                text: text,
                timestamp: Date.now()
            };

            // Send via MQTT globally
            if (window.mqttClient) {
                window.mqttClient.publish(CONFIG.MQTT.STATUS_TOPIC, JSON.stringify(chatMsg), { qos: 0 });
            }

            input.value = '';
            addMessageToUI(chatMsg, true);
        }

        async function handleDiscussionFileUpload(input) {
            const file = input.files[0];
            if (!file) return;
            input.value = ''; // reset for re-upload

            addMessageToUI({ text: `正在上传文件: ${file.name}...`, sender: '系统', action: 'chat', timestamp: Date.now() }, false);

            try {
                const arrayBuffer = await file.arrayBuffer();
                // Use the auth-free /api/chat/upload endpoint (handles WebDAV internally)
                const resp = await fetch(`${CONFIG.API_BASE}/api/chat/upload?filename=${encodeURIComponent(file.name)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    body: arrayBuffer
                });
                const result = await resp.json();
                if (result.success && result.url) {
                    const fileUrl = result.url;
                    const imgExts = ['jpg','jpeg','png','gif','bmp','webp'];
                    const ext = file.name.split('.').pop().toLowerCase();
                    const isImage = imgExts.includes(ext);

                    const fileMsg = {
                        roomId: getChatRoomId(),
                        action: isImage ? 'chat_image' : 'file_link',
                        sender: window.sessionUsername || '主播',
                        sessionId: mySessionId,
                        fileName: file.name,
                        fileSize: (file.size / 1024).toFixed(1) + ' KB',
                        url: fileUrl,
                        imageUrl: isImage ? fileUrl : undefined,
                        timestamp: Date.now()
                    };
                    if (window.mqttClient) {
                        window.mqttClient.publish(CONFIG.MQTT.STATUS_TOPIC, JSON.stringify(fileMsg), { qos: 0 });
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

        function addMessageToUI(msg, isMe) {
            const list = document.getElementById('message-list');
            if (!list) return;

            const sidebar = document.getElementById('discussion-sidebar');
            if (!isMe && sidebar && !sidebar.classList.contains('active')) {
                if (window.updateChatUnreadCount) {
                    window.updateChatUnreadCount((window.chatUnreadCount || 0) + 1);
                }
            }

            const div = document.createElement('div');
            div.className = `message-with-avatar ${isMe ? 'me' : 'others'}`;
            
            const sender = msg.sender || '匿名';
            const initial = sender.charAt(0);
            const avatarColor = isMe ? '#409eff' : (stringToColor(sender));
            
            // Format timestamp
            const tsMs = msg.timestamp || Date.now();
            const d = new Date(tsMs);
            const pad = n => String(n).padStart(2,'0');
            const timeStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
            
            let content = '';
            if (msg.action === 'chat_image' && (msg.imageUrl || msg.url)) {
                content = `
                    <div class="user-avatar" style="background:${avatarColor}">${initial}</div>
                    <div class="message-bubble">
                        <div style="font-size:11px; opacity:0.6; margin-bottom:4px;">${sender}</div>
                        <img src="${msg.imageUrl || msg.url}" style="max-width:180px; max-height:180px; border-radius:8px; cursor:pointer; margin-top:4px;" onclick="window.open(this.src)" />
                        <div style="font-size:10px; opacity:0.4; margin-top:5px; text-align:right;">${timeStr}</div>
                    </div>
                `;
            } else if (msg.action === 'file_link') {
                content = `
                    <div class="user-avatar" style="background:${avatarColor}">${initial}</div>
                    <div class="message-bubble">
                        <div style="font-size:11px; opacity:0.6; margin-bottom:4px;">${sender}</div>
                        <a href="${msg.url}" target="_blank" class="file-card" download>
                            <span class="file-card-icon">📄</span>
                            <div class="file-card-info">
                                <span class="file-card-name">${msg.fileName}</span>
                                <span class="file-card-size">${msg.fileSize}</span>
                            </div>
                        </a>
                        <div style="font-size:10px; opacity:0.4; margin-top:5px; text-align:right;">${timeStr}</div>
                    </div>
                `;
            } else {
                content = `
                    <div class="user-avatar" style="background:${avatarColor}">${initial}</div>
                    <div class="message-bubble">
                        <div style="font-size:11px; opacity:0.6; margin-bottom:4px;">${sender}</div>
                        ${msg.text}
                        <div style="font-size:10px; opacity:0.4; margin-top:5px; text-align:right;">${timeStr}</div>
                    </div>
                `;
            }
            
            div.innerHTML = content;
            list.appendChild(div);
            list.scrollTop = list.scrollHeight;
        }

        function stringToColor(str) {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                hash = str.charCodeAt(i) + ((hash << 5) - hash);
            }
            const colors = ['#f56c6c', '#409eff', '#67c23a', '#e6a23c', '#9c27b0', '#00bcd4', '#ff9800', '#795548'];
            return colors[Math.abs(hash) % colors.length];
        }

        function updateOnlineStatusUI() {
            const countBadge = document.getElementById('online-count-badge');
            // Count: presenter (me) + all online users (allow duplicate names, each sessionId = 1 person)
            const totalCount = onlineUsers.size + 1; // +1 for the presenter themselves
            if (countBadge) countBadge.innerText = totalCount + ' 人';
            renderUserList();
        }

        function toggleUserList() {
            const list = document.getElementById('discussion-user-list');
            const arrow = document.getElementById('user-list-arrow');
            const isVisible = list.classList.contains('active') || list.style.display === 'block';

            if (isVisible) {
                list.style.display = 'none';
                list.classList.remove('active');
                arrow.innerText = '▼';
            } else {
                list.style.display = 'block';
                list.classList.add('active');
                arrow.innerText = '▲';
                renderUserList();
            }
        }

        function renderUserList() {
            const container = document.getElementById('discussion-user-list');
            if (!container) return;

            const masterName = window.sessionUsername || '主讲人';
            
            // 本人 ID (演示者)
            const isSpeakingMe = window.currentSpeakersUids && window.currentSpeakersUids.includes(0);
            const micOnMe = !!(window.agoraModule && window.agoraModule.isMicEnabled && window.agoraModule.isMicEnabled());

            let html = `
                <div class="user-item ${isSpeakingMe ? 'speaking' : ''}">
                    <div class="user-avatar" style="background:#409eff">${masterName.charAt(0)}</div>
                    <div class="user-name">${masterName} <span style="font-size:10px; color:#4facfe;">(本人)</span></div>
                    <div class="user-status-icons">
                        <span class="mic-icon ${micOnMe ? 'on' : 'off'}">${micOnMe ? '🎤' : '🔇'}</span>
                        <div class="speaking-dot"></div>
                    </div>
                </div>
            `;

            const seenNames = new Set([masterName]);

            onlineUsers.forEach((user, id) => {
                if (!seenNames.has(user.name)) {
                    seenNames.add(user.name);
                    
                    const isSpeaking = window.currentSpeakersUids && user.uid && window.currentSpeakersUids.includes(user.uid);
                    const micOn = !!user.micOn;

                    html += `
                        <div class="user-item ${isSpeaking ? 'speaking' : ''}">
                            <div class="user-avatar" style="background:${stringToColor(user.name)}">${user.name.charAt(0)}</div>
                            <div class="user-name">${user.name}</div>
                            <div class="user-status-icons">
                                <span class="mic-icon ${micOn ? 'on' : 'off'}">${micOn ? '🎤' : '🔇'}</span>
                                <div class="speaking-dot"></div>
                            </div>
                        </div>
                    `;
                }
            });

            container.innerHTML = html;
        }

        // 语音状态更新回调
        window.onAgoraSpeakersChanged = (uids) => {
            window.currentSpeakersUids = uids;
            renderUserList();
        };

        // MQTT-based heartbeat
        function startMqttPresenceHeartbeat() {
            setInterval(() => {
                if (!CONFIG.MQTT.STATUS_TOPIC || !window.mqttClient) return;
                window.mqttClient.publish(CONFIG.MQTT.STATUS_TOPIC, JSON.stringify({
                    action: 'presence',
                    sessionId: mySessionId,
                    name: window.sessionUsername || '主讲人',
                    role: 'master'
                }), { qos: 0 });
                
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
        // Auto-start polling when MQTT connects
        setTimeout(startMqttPresenceHeartbeat, 2000);

        function handleMQTTCommand(messageStr) {
            try {
                const cmd = JSON.parse(messageStr);
                console.log('⬇️ 收到MQTT命令:', cmd);

                // QoS1 duplicate-protection: drop replayed control commands.
                if (cmd.msgId && cmd.action && ['next', 'prev', 'goto', 'exit'].includes(cmd.action)) {
                    const now = Date.now();
                    if (processedCommandIds.has(cmd.msgId)) return;
                    processedCommandIds.set(cmd.msgId, now);
                    for (const [mid, ts] of processedCommandIds.entries()) {
                        if (now - ts > 30000) processedCommandIds.delete(mid);
                    }
                }

                // Chat actions
                if (cmd.action === 'chat' || cmd.action === 'file_link' || cmd.action === 'chat_image') {
                    if (cmd.sessionId && cmd.sessionId !== mySessionId) {
                        const senderName = cmd.sender || '观众';
                        const existing = onlineUsers.get(cmd.sessionId) || {};
                        onlineUsers.set(cmd.sessionId, { ...existing, name: senderName, role: existing.role || 'viewer', time: Date.now() });
                        updateOnlineStatusUI();
                    }
                    if (cmd.sessionId !== mySessionId) {
                        addMessageToUI(cmd, false);
                    }
                    return;
                }
                if (cmd.action === 'presence') {
                    if (cmd.sessionId !== mySessionId) {
                        const existing = onlineUsers.get(cmd.sessionId) || {};
                        onlineUsers.set(cmd.sessionId, { ...existing, name: cmd.name, role: cmd.role, time: Date.now() });
                        updateOnlineStatusUI();
                    }
                    return;
                }
                if (cmd.action === 'mic_status') {
                    const user = onlineUsers.get(cmd.sessionId);
                    if (user) {
                        user.micOn = cmd.enabled;
                        user.uid = cmd.uid; // 建立 Agora UID 与 SessionId 的绑定
                        renderUserList();
                    }
                    return;
                }
                if (cmd.action === 'screen_share_started') {
                    if (window.agoraModule) {
                        if (typeof window.agoraModule.setActiveScreenSharer === 'function') {
                            window.agoraModule.setActiveScreenSharer(cmd.uid);
                        }
                        if (typeof window.agoraModule.enterPresenterPreviewMode === 'function') {
                            window.agoraModule.enterPresenterPreviewMode(cmd.uid);
                        }
                        // 防冲突：如果主控端自身也在共享，则停止
                        if (window.agoraModule.handleScreenShareLock) {
                            window.agoraModule.handleScreenShareLock(cmd.uid);
                        }
                        // ★ 核心修复：演示端必须先加入 Agora 频道才能接收远端流
                        // ensureViewerJoined 检测到未入频道时会自动执行 initRemoteAgora
                        if (window.agoraModule.ensureViewerJoined) {
                            window.agoraModule.ensureViewerJoined().then(() => {
                                console.log('[Presenter] 已加入 Agora 频道，准备接收观众投屏流');
                                const stage = document.getElementById('agora-video-stage');
                                if (stage) stage.style.display = 'flex';
                                const title = document.getElementById('preview-title');
                                if (title) title.textContent = '远程屏幕演示';
                            }).catch(e => console.error('[Presenter] 加入 Agora 频道失败:', e));
                        } else {
                            const stage = document.getElementById('agora-video-stage');
                            if (stage) stage.style.display = 'flex';
                            const title = document.getElementById('preview-title');
                            if (title) title.textContent = '远程屏幕演示';
                        }
                    }
                    return;
                }
                if (cmd.action === 'screen_share_stopped') {
                    if (window.agoraModule && typeof window.agoraModule.exitPresenterPreviewMode === 'function') {
                        window.agoraModule.exitPresenterPreviewMode();
                    }
                    const title = document.getElementById('preview-title');
                    if (title) title.textContent = '预览区';
                    return;
                }

                // 处理编号请求
                if (cmd.action === 'request_id') {
                    console.log('📤 收到编号请求，正在计算空余席位...');
                    // 获取当前所有已使用的编号
                    const usedIds = new Set();
                    if (window.sessionUsername) {
                        const m = window.sessionUsername.match(/_(\d+)$/);
                        if (m) usedIds.add(parseInt(m[1]));
                    }
                    onlineUsers.forEach(u => {
                        const m = u.name.match(/_(\d+)$/);
                        if (m) usedIds.add(parseInt(m[1]));
                    });

                    // 寻找最小的可用编号 (从 02 开始，因为 01 是主播)
                    let assigned = 2;
                    while (usedIds.has(assigned)) {
                        assigned++;
                    }
                    const assignedStr = assigned < 10 ? '0' + assigned : '' + assigned;
                    
                    mqttClient.publish(CONFIG.MQTT.STATUS_TOPIC, JSON.stringify({
                        action: 'assign_id',
                        targetSessionId: cmd.sessionId,
                        assignedId: assignedStr,
                        timestamp: Date.now()
                    }), { qos: 0 });
                    return;
                }

                // 处理状态请求（无需演示模式）
                if (cmd.action === 'request_status') {
                    console.log('📤 收到状态请求，发送当前状态...');
                    if (presentationFile && pdfDoc) {
                        publishStatus('presenting');
                    } else {
                        publishStatus('idle');
                    }
                    return;
                }

                if (cmd.action === 'kick_presence') {
                    if (cmd.sessionId && cmd.sessionId !== mySessionId) {
                        console.warn('⚠️ 检测到新登录，本会话将被强制下线');
                        mqttClient.end();
                        document.getElementById('login-overlay').style.display = 'flex';
                        document.getElementById('login-error').textContent = '用户已在别处登录，您已被强制下线';
                        document.getElementById('login-error').style.display = 'block';
                        document.getElementById('login-pass').value = '';
                    }
                    return;
                }

                if (cmd.action === 'draw_resync_request') {
                    const page = Number(cmd.page || currentPage);
                    const fromSeq = Number(cmd.fromSeq || 1);
                    const events = (drawPageEvents.get(page) || []).filter(e => Number(e.seq || 0) >= fromSeq);
                    if (mqttClient && mqttClient.connected) {
                        mqttClient.publish(CONFIG.MQTT.STATUS_TOPIC, JSON.stringify({
                            action: 'draw_resync_data',
                            page,
                            fromSeq,
                            events
                        }), { qos: 1 });
                    }
                    return;
                }

                if (!presentationFile) {
                    console.log('当前未在演示模式');
                    return;
                }

                // 执行指令
                switch (cmd.action) {
                    case 'next':
                        if (!isViewerCtrlMode && cmd.source && cmd.source !== mySessionId) return;
                        nextPageOrFile();
                        break;
                    case 'prev':
                        if (!isViewerCtrlMode && cmd.source && cmd.source !== mySessionId) return;
                        prevPageOrFile();
                        break;
                    case 'goto':
                        if (!isViewerCtrlMode && cmd.source && cmd.source !== mySessionId) return;
                        if (cmd.page) { gotoPage(cmd.page); }
                        break;
                    case 'exit': exitPresentation(); break;
                }

                // 发送确认消息（ACK）
                if (cmd.msgId && mqttClient && mqttClient.connected) {
                    const ackMsg = {
                        type: 'ack',
                        msgId: cmd.msgId,
                        action: cmd.action,
                        success: true,
                        timestamp: Date.now()
                    };
                    mqttClient.publish(CONFIG.MQTT.STATUS_TOPIC, JSON.stringify(ackMsg), { qos: 0 });
                    console.log('⬆️ 发送确认:', ackMsg);
                }
            } catch (e) {
                console.error('解析MQTT命令失败:', e);
            }
        }
        function publishStatus(status) {
            if (!mqttClient || !mqttClient.connected) return;
            // LEAN MQTT: only essential sync data, no chat/presence/large payloads
            const statusMsg = {
                p: currentPage,
                t: totalPages,
                u: currentPdfUrl || '',
                s: status,
                vc: isViewerCtrlMode ? 1 : 0,
                vs: isViewerSharingMode ? 1 : 0,
                vm: isViewerMicMode ? 1 : 0,
                vv: isViewerVideoMode ? 1 : 0
            };
            mqttClient.publish(CONFIG.MQTT.STATUS_TOPIC, JSON.stringify(statusMsg), { qos: 0, retain: true }, (err) => {
                if (!err) { mqttStats.sent++; }
                else { console.error('发布状态失败:', err); }
            });
        }

        // Ultra-light page change notification (for instant sync)
        function publishPageChange() {
            if (!mqttClient || !mqttClient.connected) return;
            mqttClient.publish(CONFIG.MQTT.STATUS_TOPIC, JSON.stringify({
                a: 'pg', p: currentPage, t: totalPages
            }), { qos: 0 });
        }

        window.showMobileQRCode = function() {
            // 获取当前房间 ID
            const rawName = (window.sessionUsername || 'admin').split('_')[0];
            let remoteUrl = window.location.href.split('?')[0];
            if (remoteUrl.includes('index.html')) remoteUrl = remoteUrl.replace('index.html', 'remote.html');
            else if (remoteUrl.endsWith('/')) remoteUrl += 'remote.html';
            else if (!remoteUrl.includes('remote.html')) remoteUrl += '/remote.html';
            
            // 构造最终链接
            let finalUrl = remoteUrl + '?room=' + encodeURIComponent(rawName);
            
            // 尝试获取会议特定的链接（如果有）
            const editId = document.getElementById('current-viewing-meeting-idx')?.value;
            if (editId && editId !== '-1') {
                try {
                    const myMeetings = JSON.parse(localStorage.getItem('myMeetings_' + rawName) || '[]');
                    const m = myMeetings[parseInt(editId)];
                    if (m && m.remoteUrl) finalUrl = m.remoteUrl;
                } catch(e) {}
            }

            // 创建或显示模态框
            let modal = document.getElementById('mobile-qr-modal');
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'mobile-qr-modal';
                modal.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); z-index:100000; display:flex; flex-direction:column; align-items:center; justify-content:center; backdrop-filter:blur(5px);';
                modal.onclick = () => modal.style.display = 'none';
                
                const box = document.createElement('div');
                box.style.cssText = 'background:white; padding:25px; border-radius:16px; text-align:center; box-shadow:0 20px 60px rgba(0,0,0,0.5); width:300px; max-width:90%; animation: zoomIn 0.3s ease;';
                box.onclick = (e) => e.stopPropagation();
                
                // Add animation
                const style = document.createElement('style');
                style.innerHTML = '@keyframes zoomIn { from { transform:scale(0.8); opacity:0; } to { transform:scale(1); opacity:1; } }';
                document.head.appendChild(style);

                const title = document.createElement('div');
                title.innerText = '扫码加入演示';
                title.style.cssText = 'font-size:18px; font-weight:bold; margin-bottom:20px; color:#333;';
                box.appendChild(title);
                
                const qrDiv = document.createElement('div');
                qrDiv.id = 'mobile-qr-container';
                qrDiv.style.cssText = 'display:flex; justify-content:center; margin-bottom:20px; padding:10px; border:1px solid #eee; background:#fff;';
                box.appendChild(qrDiv);
                
                const closeBtn = document.createElement('button');
                closeBtn.innerText = '返回演示';
                closeBtn.style.cssText = 'width:100%; padding:12px; background:#409eff; color:white; border:none; border-radius:30px; font-weight:bold; cursor:pointer; font-size:16px;';
                closeBtn.onclick = () => modal.style.display = 'none';
                
                box.appendChild(closeBtn);
                modal.appendChild(box);
                document.body.appendChild(modal);
            }
            
            const qrContainer = document.getElementById('mobile-qr-container');
            qrContainer.innerHTML = '';
            if (typeof QRCode !== 'undefined') {
                new QRCode(qrContainer, { text: finalUrl, width: 220, height: 220, colorDark: "#2c3e50", colorLight: "#ffffff" });
            } else {
                qrContainer.innerHTML = '二维码插件未加载';
            }
            
            modal.style.display = 'flex';
        };

        function getActualPath(path) {
            if (!window.storagePath || window.storagePath === '/') return path;
            const cleanPath = path.startsWith('/') ? path : '/' + path;
            return window.storagePath + cleanPath;
        }

        async function startPresentation(file) {
            const mySessionToken = ++presentationSessionToken;
            // Fix 2: 演示开始前先清空主界面的预览区，防止后台 iframe/视频 继续播放
            const previewContainer = document.getElementById("preview-container");
            if (previewContainer) {
                previewContainer.innerHTML = '<div class="preview-msg"><div class="preview-placeholder"><div class="icon">💻</div><div>演示进行中...</div></div></div>';
            }

            presentationFile = file; currentPage = 1; totalPages = 0;
            isLoopMode = false;     // 同时重置循环模式
            pdfDoc = null;
            currentPdfUrl = null; // 重置 URL
            drawPageEvents.clear();
            drawMsgSeq = 0;
            drawStateByPage.clear();
            activeStrokeState = null;
            drawStateDirtyPage = null;
            // 如果菜单已经打开，刷新菜单状态
            if (typeof renderPresSettingsMenu === 'function') renderPresSettingsMenu();

            document.getElementById('presentation-filename').textContent = file.name;
            document.getElementById('presentation-canvas').style.display = 'none'; document.getElementById('presentation-image').style.display = 'none';
            // 修复：清空先前可能残留的 iframe 源，防止切换到了 .url 文件却依然显示上一个表格
            const _oldIframe = document.getElementById('presentation-office-iframe');
            if (_oldIframe) {
                _oldIframe.removeAttribute('srcdoc');
                _oldIframe.removeAttribute('src');
                _oldIframe.style.display = 'none';
            }

            const canvasContainer = document.getElementById('presentation-canvas-container');
            if(canvasContainer) canvasContainer.style.display = 'flex';

            const presCanvas = document.getElementById('presentation-canvas');
            const presImage = document.getElementById('presentation-image');
            const presVideo = document.getElementById('presentation-video');
            const presIframe = document.getElementById('presentation-office-iframe');
            if (presCanvas) presCanvas.style.display = 'none';
            if (presImage) { presImage.style.display = 'none'; presImage.src = ''; }
            if (presVideo) { presVideo.style.display = 'none'; try { presVideo.pause(); } catch (e) {} presVideo.src = ''; }
            if (presIframe) { presIframe.style.display = 'none'; try { presIframe.removeAttribute('srcdoc'); } catch (e) {} presIframe.src = ''; }

            // 演示模式开启时，动态移动讨论侧边栏进入全屏容器
            const elem = document.getElementById('presentation-mode');
            elem.classList.add('active'); // [重要修复] 必须添加 active 类以显示容器
            const sidebar = document.getElementById('discussion-sidebar');
            if(sidebar) elem.appendChild(sidebar);
            
            // 【互斥逻辑】正在屏幕共享时打开PPT，自动关闭/隐藏屏幕共享
            if (window.agoraModule && typeof window.agoraModule.stopScreenShare === 'function') {
                window.agoraModule.stopScreenShare();
            }
            const stage = document.getElementById('agora-video-stage');
            if (stage) stage.style.display = 'none';
            
            // 恢复: 只要进入演示，就自动请求浏览器原生全屏 (注意: 这将不可避免地导致浏览器弹出 ESC 退出的安全提示)
            const root = document.documentElement;
            if (root.requestFullscreen) {
                // 必须在第一次用户点击操作(dblclick)的作用域里同步执行，不可 await
                root.requestFullscreen().catch(err => console.log('进入全屏失败:', err));
            }

            // 立即发送状态更新，告知显示端正在切换文档
            // publishStatus('loading'); // 改为手动触发

            const ext = file.name.split('.').pop().toLowerCase();
            const actualPath = getActualPath(file.path);

            // [Shadow PDF Strategy] 优先尝试加载影子 PDF (表格文件除外，保持其原生的 sheet 展现形式)
            if (['ppt', 'pptx', 'doc', 'docx'].includes(ext)) {
                try {
                    const dir = actualPath.indexOf('/') !== -1 ? actualPath.substring(0, actualPath.lastIndexOf('/')) : '';
                    const baseName = file.name.replace(/\.[^/.]+$/, "");
                    
                    // 多种可能的影子文件名规则 (按优先级排列)
                    const variants = [
                        "." + baseName + ".pdf", // .filename.pdf
                        file.name + ".pdf",     // filename.pptx.pdf
                        baseName + ".pdf"       // filename.pdf
                    ];

                    for (const shadowName of variants) {
                        const shadowPath = (dir ? dir + '/' : '') + shadowName;
                        const shadowUrl = `${CONFIG.API_BASE}/api/file-proxy/${encodeURIComponent(shadowName)}?path=${encodeURIComponent(shadowPath)}&token=${CONFIG.PREVIEW_TOKEN}`;
                        
                        console.log('[Shadow] 正在检测预转换文件:', shadowName);
                        try {
                            const checkStore = await fetch(shadowUrl, { method: 'HEAD' });
                            if (checkStore.ok) {
                                console.log('[Shadow] 命中缓存！实现秒开:', shadowName);
                                loadPdfWithPdfJs(shadowUrl, mySessionToken);
                                return;
                            }
                        } catch (err) {
                            console.warn('[Shadow] Fetch failed:', shadowName, err);
                        }
                    }
                } catch (e) {
                    console.warn('[Shadow] Logic error:', e);
                }
            }

            // URL 链接处理 (Bilibili/YouTube)
            if (ext === 'url') {
                const fileUrl = getFileDownloadUrl(file.path, true);
                fetch(fileUrl).then(r => r.text()).then(rawUrl => {
                    // 处理 Windows .url 文件格式 (INI格式)
                    let targetUrl = rawUrl.trim();
                    const match = targetUrl.match(/URL=(.+)/i);
                    if (match && match[1]) {
                        targetUrl = match[1].trim();
                    } else if (targetUrl.startsWith('[InternetShortcut]')) {
                        // 可能有多行，尝试找 URL=
                        const lines = targetUrl.split('\n');
                        for (let line of lines) {
                            if (line.trim().startsWith('URL=')) {
                                targetUrl = line.trim().substring(4).trim();
                                break;
                            }
                        }
                    }

                    // 转换嵌入链接
                    // 转换嵌入链接
                    let embedUrl = targetUrl;
                    if (targetUrl.includes('bilibili.com') && targetUrl.match(/BV[a-zA-Z0-9]+/)) {
                        const bvid = targetUrl.match(/BV[a-zA-Z0-9]+/)[0];
                        let page = 1;
                        const pMatch = targetUrl.match(/[?&]p=(\d+)/) || targetUrl.match(/p=(\d+)/);
                        if (pMatch) page = pMatch[1];
                        const sidMatch = targetUrl.match(/[?&]sid=(\d+)/);
                        const sidParam = sidMatch ? `&ss_id=${sidMatch[1]}` : '';

                        // B站参数：autoplay=1 (自动播放), danmaku=0 (关弹幕)
                        embedUrl = `https://player.bilibili.com/player.html?bvid=${bvid}&page=${page}${sidParam}&high_quality=1&danmaku=0&autoplay=1`;
                    } else if (targetUrl.includes('youtube.com') && targetUrl.includes('v=')) {
                        embedUrl = 'https://www.youtube.com/embed/' + targetUrl.split('v=')[1].split('&')[0] + '?autoplay=1&mute=0';
                    } else if (targetUrl.includes('youtu.be/')) {
                        embedUrl = 'https://www.youtube.com/embed/' + targetUrl.split('youtu.be/')[1].split('?')[0] + '?autoplay=1&mute=0';
                    }

                    console.log('[Presentation] Showing external video:', embedUrl);

                    currentPdfUrl = embedUrl;
                    totalPages = 1;
                    currentPage = 1;
                    updatePageInfo();
                    publishStatus('presenting'); // 推送状态

                    // 本地显示 (复用 iframe)
                    document.getElementById('presentation-loading').style.display = 'none';
                    let iframe = document.getElementById('presentation-office-iframe');
                    if (!iframe) {
                        iframe = document.createElement('iframe');
                        iframe.id = 'presentation-office-iframe';
                        iframe.style.cssText = 'width:100%; height:100%; border:none; background:black;';
                        // 添加 allow 属性，尝试争取自动播放权限
                        iframe.allow = "autoplay; fullscreen; clipboard-write; encrypted-media; picture-in-picture; web-share";
                        // 添加 sandbox 属性：允许脚本、同源资源、表单，但【禁止】弹出新窗口(allow-popups)和顶级导航(allow-top-navigation)
                        iframe.sandbox = "allow-scripts allow-same-origin allow-forms allow-presentation";
                        document.getElementById('presentation-canvas-container').appendChild(iframe);
                    } else {
                        // 确保现有 iframe 也有此属性
                        iframe.allow = "autoplay; fullscreen; clipboard-write; encrypted-media; picture-in-picture; web-share";
                        iframe.sandbox = "allow-scripts allow-same-origin allow-forms allow-presentation";
                    }
                    // 隐藏其他
                    document.getElementById('presentation-canvas').style.display = 'none';
                    document.getElementById('presentation-image').style.display = 'none';
                    document.getElementById('presentation-video').style.display = 'none'; // 确保隐藏video元素

                    iframe.style.display = 'block';
                    iframe.src = embedUrl;

                }).catch(e => {
                    console.error(e);
                    showPresentationError('链接加载失败');
                });
                return;
            }

            // 视频处理
            if (['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv'].includes(ext)) {
                const videoUrl = `${CONFIG.API_BASE}/api/file-proxy/${encodeURIComponent(file.name)}?path=${encodeURIComponent(actualPath)}&token=${CONFIG.PREVIEW_TOKEN}`;
                console.log('[Presentation] Showing video:', videoUrl);

                // 立即设置 currentPdfUrl 并发送状态
                currentPdfUrl = videoUrl;
                totalPages = 1;
                currentPage = 1;
                updatePageInfo();
                updatePageInfo();
                publishStatus('presenting');

                const videoEl = document.getElementById('presentation-video');
                videoEl.src = videoUrl;


                videoEl.onloadeddata = () => {
                    document.getElementById('presentation-loading').style.display = 'none';
                    videoEl.style.display = 'block';
                    console.log('[Presentation] Video loaded successfully');
                    // 被渲染时确保视频底部控制栏不被遮盖
                    videoEl.style.paddingBottom = '0';
                    // 初始化涂鸦画布
                    if (typeof initDrawCanvas === 'function') {
                        // 确保视频已经有尺寸
                        initDrawCanvas();
                        clearDrawing();
                    }
                    publishStatus('presenting');
                };

                // 监听播放结束
                videoEl.onended = () => {
                    if (isLoopMode) {
                        videoEl.currentTime = 0;
                        videoEl.play();
                    }
                };

                videoEl.onerror = () => {
                    console.error('[Presentation] Video load failed:', videoUrl);
                    showPresentationError('视频加载失败');
                };

                return;
            }

            // 图片处理
            if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'].includes(ext)) {
                // 使用完整的 API_BASE URL 确保显示端也能访问
                const imgUrl = `${CONFIG.API_BASE}/api/file-proxy/${encodeURIComponent(file.name)}?path=${encodeURIComponent(actualPath)}&token=${CONFIG.PREVIEW_TOKEN}`;
                console.log('[Presentation] Showing image:', imgUrl);

                // 立即设置 currentPdfUrl 并发送状态，让显示端尽快切换
                currentPdfUrl = imgUrl;
                totalPages = 1;
                currentPage = 1;
                updatePageInfo();
                updatePageInfo();
                publishStatus('presenting');

                const imgEl = document.getElementById('presentation-image');
                imgEl.src = imgUrl;
                imgEl.onload = () => {
                    document.getElementById('presentation-loading').style.display = 'none';
                    imgEl.style.display = 'block';
                    console.log('[Presentation] Image loaded successfully');
                    // 初始化涂鸦画布
                    if (typeof initDrawCanvas === 'function') {
                        initDrawCanvas();
                        clearDrawing();
                    }
                    publishStatus('presenting');
                };
                imgEl.onerror = () => {
                    console.error('[Presentation] Image load failed:', imgUrl);
                    showPresentationError('图片加载失败');
                };

                return;
            }

            let pdfUrl;

            // if (ext === 'pdf') { ... }  <-- 移除这段逻辑，让 PDF 也走下面的 KKFileView 处理流程

            if (true) {
                // Office/PDF 文件代理地址
                const proxyUrl = `${CONFIG.API_BASE}/api/file-proxy/${encodeURIComponent(file.name)}?path=${encodeURIComponent(actualPath)}&token=${CONFIG.PREVIEW_TOKEN}`;
                const b64 = utf8_to_b64(proxyUrl);

                // 只有 Excel 表格使用 iframe 直接预览 (KKFileView 不支持 Excel 转 PDF，仅返回原生 HTML grid)
                const useIframePreview = ['xls', 'xlsx', 'xlsm', 'csv'].includes(ext);

                if (useIframePreview) {
                    console.log('[KKFileView] Excel file, using iframe HTML preview...');

                    const previewUrl = `${CONFIG.KKFILEVIEW.URL}/onlinePreview?url=${encodeURIComponent(b64)}&fullfilename=${encodeURIComponent(file.name)}`;
                    
                    // 隐藏 loading 和 canvas
                    document.getElementById('presentation-loading').style.display = 'flex';
                    document.getElementById('presentation-canvas').style.display = 'none';

                    // 创建或更新 iframe
                    let iframe = document.getElementById('presentation-office-iframe');
                    if (!iframe) {
                        iframe = document.createElement('iframe');
                        iframe.id = 'presentation-office-iframe';
                        iframe.style.cssText = 'width:100%; height:100%; border:none; background:white;';
                        document.getElementById('presentation-canvas-container').appendChild(iframe);
                    }
                    iframe.style.display = 'none';

                    // 开启流式读取，截断超级大的表格以防止 RESULT_CODE_HUNG 渲染崩溃
                    async function fetchAndTruncateKKFileView() {
                        try {
                            const res = await fetch(previewUrl);
                            if (mySessionToken !== presentationSessionToken) return;
                            if (!res.ok) throw new Error("Fetch HTML failed: " + res.status);
                            
                            const reader = res.body.getReader();
                            const decoder = new TextDecoder('utf-8');
                            let htmlChunk = '';
                            let trCount = 0;
                            let isTruncated = false;
                            
                            while (true) {
                                const {done, value} = await reader.read();
                                if (done) break;
                                htmlChunk += decoder.decode(value, {stream: true});
                                
                                const rows = htmlChunk.match(/<tr/gi);
                                if (rows && rows.length >= 300) {
                                    isTruncated = true;
                                    // 终止继续下载后续几十万个节点，释放内存
                                    reader.cancel();
                                    break;
                                }
                            }
                            
                            if (isTruncated) {
                                let finalIndex = htmlChunk.lastIndexOf('</tr>');
                                if (finalIndex === -1) finalIndex = htmlChunk.lastIndexOf('<tr');
                                if (finalIndex !== -1) {
                                    htmlChunk = htmlChunk.substring(0, finalIndex + 5);
                                }
                                htmlChunk += '<tr><td colspan="50" style="padding:15px;text-align:center;color:#f56c6c;font-weight:bold;background:#fdf2f2;font-size:16px;">⚠️ 当前表格数据超大（存在几万行），为防止您的浏览器渲染超限崩溃 (RESULT_CODE_HUNG)，已自动截取前 300 行展示</td></tr></table></body></html>';
                            }
                            
                            // 修正原 KKFileView 里的静态资源相对路径
                            htmlChunk = htmlChunk.replace(/(href|src)=['"]\/?([^'"]+\.(?:css|js|png|jpg|jpeg|gif))['"]/gi, (match, attr, path) => {
                                if (path.startsWith('http')) return match;
                                return `${attr}="${CONFIG.KKFILEVIEW.URL}/${path}"`;
                            });
                            
                            if (mySessionToken !== presentationSessionToken) return;
                            iframe.srcdoc = htmlChunk;
                            document.getElementById('presentation-loading').style.display = 'none';
                            iframe.style.display = 'block';
                            
                        } catch (err) {
                            console.warn('[KKFileView] Stream interception fall back to direct iframe src due to error/CORS:', err);
                            if (mySessionToken !== presentationSessionToken) return;
                            iframe.src = previewUrl;
                            document.getElementById('presentation-loading').style.display = 'none';
                            iframe.style.display = 'block';
                        }
                    }

                    fetchAndTruncateKKFileView();

                    currentPdfUrl = previewUrl;
                    totalPages = 1;
                    currentPage = 1;
                    updatePageInfo();
                    publishStatus('presenting');
                } else {
                    // 隐藏 iframe，显示 canvas
                    const iframe = document.getElementById('presentation-office-iframe');
                    if (iframe) iframe.style.display = 'none';
                    document.getElementById('presentation-canvas').style.display = 'block';

                    // 如果是 PDF，直接加载 (或者走代理)
                    if (ext === 'pdf') {
                        console.log('[PDF.js] Direct PDF loading...');
                        const pdfUrl = `${CONFIG.API_BASE}/api/file-proxy/${encodeURIComponent(file.name)}?path=${encodeURIComponent(actualPath)}&token=${CONFIG.PREVIEW_TOKEN}`;
                        loadPdfWithPdfJs(pdfUrl, mySessionToken);
                        return;
                    }

                    // Office 文件：先请求 kkfileview 转换为 PDF
                    console.log('Proxy URL for conversion:', proxyUrl);
                    const kkUrl = `${CONFIG.KKFILEVIEW.URL}/onlinePreview?url=${encodeURIComponent(b64)}${ext === 'pdf' ? '' : '&officePreviewType=pdf'}`;
                    fetch(kkUrl)
                        .then(response => response.text())
                        .then(html => {
                            // 从返回的 HTML 中提取 PDF URL
                            const pdfMatch = html.match(/src=["']([^"']*\.pdf[^"']*)["']/i) ||
                                html.match(/file=["']([^"']*\.pdf[^"']*)["']/i) ||
                                html.match(/["'](https?:\/\/[^"']*\.pdf[^"']*)["']/i);

                            if (pdfMatch && pdfMatch[1]) {
                                let extractedPdfUrl = pdfMatch[1];
                                if (extractedPdfUrl.startsWith('/')) {
                                    extractedPdfUrl = CONFIG.KKFILEVIEW.URL + extractedPdfUrl;
                                }
                                console.log('[PDF.js] Extracted PDF URL from HTML:', extractedPdfUrl);
                                loadPdfWithPdfJs(extractedPdfUrl, mySessionToken);
                            } else {
                                console.warn('[PDF.js] Could not extract PDF URL from HTML, trying getCorsFile...');
                                const corsFileUrl = `${CONFIG.KKFILEVIEW.URL}/getCorsFile?urlPath=${encodeURIComponent(b64)}`;
                                loadPdfWithPdfJs(corsFileUrl, mySessionToken);
                            }
                        })
                        .catch(err => {
                            console.error('[PDF.js] Failed to get converted PDF:', err);
                            showPresentationError('文档转换失败: ' + err.message);
                        });
                }

                updatePageInfo();
                updatePageInfo();
                // publishStatus('presenting'); // 改为手动触发
            }
        }

        // 渲染防抖 + 取消机制：防止快速翻页导致多个渲染任务并行崩溃
        let _renderRAF = null;
        let _activeRenderTask = null;

        function renderPage(pageNum) {
            if (!pdfDoc) return;

            // 取消之前排队的帧，只保留最新的翻页请求
            if (_renderRAF) {
                cancelAnimationFrame(_renderRAF);
                _renderRAF = null;
            }

            // 取消正在进行的渲染任务（关键！避免旧渲染与新渲染争夺 Canvas）
            if (_activeRenderTask) {
                try { _activeRenderTask.cancel(); } catch(e) {}
                _activeRenderTask = null;
            }

            // 用 rAF 合并短时间内的多次翻页为一次渲染
            _renderRAF = requestAnimationFrame(() => {
                _renderRAF = null;
                _doRenderPage(pageNum);
            });
        }

        function _doRenderPage(pageNum) {
            if (!pdfDoc || pageNum < 1 || pageNum > pdfDoc.numPages) return;

            pdfDoc.getPage(pageNum).then(page => {
                const canvas = document.getElementById('presentation-canvas');
                const ctx = canvas.getContext('2d');

                const sysDpr = window.devicePixelRatio || 1;
                const targetDpr = Math.max(sysDpr, 3.0);

                const container = document.getElementById('presentation-canvas-container');
                const isFullscreen = !!document.fullscreenElement || document.getElementById('presentation-mode').classList.contains('active');
                const viewport_check = page.getViewport({ scale: 1 });
                const pageAR = viewport_check.width / viewport_check.height;
                container.classList.remove('mode-presentation', 'mode-document', 'mode-mixed');
                let dm;
                if (pageAR >= 1.2) { dm = 'presentation'; container.classList.add('mode-presentation'); }
                else if (pageAR <= 0.85) { dm = 'document'; container.classList.add('mode-document'); }
                else { dm = 'mixed'; container.classList.add('mode-mixed'); }
                let pad = isFullscreen ? (dm === 'presentation' ? 0 : 16) : (dm === 'presentation' ? 8 : 20);
                const containerWidth = container.clientWidth - pad;
                const containerHeight = container.clientHeight - pad;

                const viewport = page.getViewport({ scale: 1 });
                const scaleX = containerWidth / viewport.width;
                const scaleY = containerHeight / viewport.height;
                let baseScale = Math.min(scaleX, scaleY);
                const scale = baseScale * targetDpr;
                const scaledViewport = page.getViewport({ scale: scale });

                canvas.width = scaledViewport.width;
                canvas.height = scaledViewport.height;
                canvas.style.width = (scaledViewport.width / targetDpr) + 'px';
                canvas.style.height = (scaledViewport.height / targetDpr) + 'px';

                if (typeof initDrawCanvas === 'function') {
                    initDrawCanvas();
                }

                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';

                const renderContext = { canvasContext: ctx, viewport: scaledViewport };
                _activeRenderTask = page.render(renderContext);
                _activeRenderTask.promise.then(() => {
                    _activeRenderTask = null;
                }).catch(err => {
                    _activeRenderTask = null;
                    if (err.name !== 'RenderingCancelledException') {
                        console.error('[PDF.js] Page render failed:', err);
                    }
                });
            }).catch(err => {
                console.error('[PDF.js] getPage failed:', err);
            });
        }

        let pdfDoc = null;
        function loadPdfWithPdfJs(url, token = presentationSessionToken) {
            console.log('[PDF.js] Loading PDF from:', url);

            // 立即设置 currentPdfUrl 并发送状态，让显示端尽快切换
            currentPdfUrl = url;
            publishStatus('loading');

            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
            pdfjsLib.getDocument({ url: url, withCredentials: false }).promise.then(pdf => {
                if (token !== presentationSessionToken) return;
                pdfDoc = pdf;
                totalPages = pdf.numPages;
                currentPage = 1;
                console.log('[PDF.js] PDF loaded successfully! Total pages:', totalPages);

                document.getElementById('presentation-loading').style.display = 'none';
                document.getElementById('presentation-canvas').style.display = 'block';

                renderPage(currentPage);
                updatePageInfo();
                updatePageInfo();
                publishStatus('presenting');
            }).catch(err => {
                console.error('[PDF.js] Failed to load PDF:', err);
                showPresentationError('PDF 加载失败: ' + err.message);
            });
        }

        function renderPage(pageNum) {
            if (!pdfDoc) return;
            pdfDoc.getPage(pageNum).then(page => {
                const canvas = document.getElementById('presentation-canvas');
                const ctx = canvas.getContext('2d');

                // 增强清晰度：无论屏幕DPR如何，强制使用至少 3倍 的渲染分辨率
                // 这相当于“高清图”模式 (High Definition)
                const sysDpr = window.devicePixelRatio || 1;
                const targetDpr = Math.max(sysDpr, 3.0);

                const container = document.getElementById('presentation-canvas-container');
                const isFullscreen = !!document.fullscreenElement || document.getElementById('presentation-mode').classList.contains('active');
                const viewport_check = page.getViewport({ scale: 1 });
                const pageAR = viewport_check.width / viewport_check.height;
                container.classList.remove('mode-presentation', 'mode-document', 'mode-mixed');
                let dm;
                if (pageAR >= 1.2) { dm = 'presentation'; container.classList.add('mode-presentation'); }
                else if (pageAR <= 0.85) { dm = 'document'; container.classList.add('mode-document'); }
                else { dm = 'mixed'; container.classList.add('mode-mixed'); }
                let pad = isFullscreen ? (dm === 'presentation' ? 0 : 16) : (dm === 'presentation' ? 8 : 20);
                const containerWidth = container.clientWidth - pad;
                const containerHeight = container.clientHeight - pad;

                const viewport = page.getViewport({ scale: 1 });
                const scaleX = containerWidth / viewport.width;
                const scaleY = containerHeight / viewport.height;

                // 计算适应屏幕的基础缩放比例
                let baseScale = Math.min(scaleX, scaleY);

                // 最终渲染比例 = 适应比例 * 高清倍数
                const scale = baseScale * targetDpr;

                const scaledViewport = page.getViewport({ scale: scale });

                // 设置画布的物理像素尺寸（高分辨率）
                canvas.width = scaledViewport.width;
                canvas.height = scaledViewport.height;

                // 设置画布的 CSS 显示尺寸（适应屏幕）
                // 必须除以 targetDpr 才能让高分屏显示的图片大小正确匹配容器
                canvas.style.width = (scaledViewport.width / targetDpr) + 'px';
                canvas.style.height = (scaledViewport.height / targetDpr) + 'px';

                // 初始化涂鸦画布（关键：确保尺寸与演示画布一致，并启用交互）
                if (typeof initDrawCanvas === 'function') {
                    initDrawCanvas();
                    // 翻页时清除涂鸦? 或者保持? 用户说"默认翻页就清空"
                    // 这里每次 renderPage 都会被调用，所以翻页时会重新初始化并清空（因为尺寸重设会清空 canvas）
                    // 但为了保险，可以显式清除
                    // 注意：改变 canvas.width/height 会自动清空画布内容，所以其实不需要显式 clearDrawing()
                    // 但我们需要确保 drawing state 重置
                }

                // 稍微优化渲染质量设置
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';

                const renderContext = { canvasContext: ctx, viewport: scaledViewport };
                page.render(renderContext).promise.catch(err => console.error('[PDF.js] Page render failed:', err));
            });
        }

        function showPresentationError(message) {
            const loadingEl = document.getElementById('presentation-loading');
            loadingEl.innerHTML = `<div style="color: #ff6b6b;">❌ ${message}</div><button onclick="exitPresentation()" style="margin-top:15px;">关闭</button>`;
        }

        async function exitPresentation() {
            // 安全性增强：退出演示时，如果正在分享屏幕，强制停止
            if (window.agoraModule && window.agoraModule.isSharing()) {
                console.log('🔒 检测到正在屏幕分享，退出演示模式时强制停止');
                window.agoraModule.stopScreenShare();
                // 立即广播停止信号，确保观众端UI能立刻恢复
                if (mqttClient && mqttClient.connected) {
                    mqttClient.publish(CONFIG.MQTT.STATUS_TOPIC, JSON.stringify({ action: 'screen_share_stopped' }), { qos: 0 });
                }
            }

            if (document.fullscreenElement) {
                try { await document.exitFullscreen(); } catch (e) { console.warn('Exit fullscreen failed:', e); }
            }
            document.getElementById('presentation-mode').classList.remove('active');
            
            // 恢复直播状态（如果之前是因为直播隐藏了UI）
            document.body.classList.remove('is-live-streaming');
            const navOverlay = document.querySelector('.page-nav-overlay');
            if(navOverlay) navOverlay.style.display = 'flex';
            
            const cc = document.getElementById('presentation-canvas-container');
            if (cc) cc.classList.remove('mode-presentation', 'mode-document', 'mode-mixed');
            const canvas = document.getElementById('presentation-canvas');
            if (canvas) {
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
            const imgEl = document.getElementById('presentation-image'); if (imgEl) { imgEl.style.display = 'none'; imgEl.src = ''; }
            const videoEl = document.getElementById('presentation-video'); if (videoEl) { videoEl.style.display = 'none'; videoEl.pause(); videoEl.src = ''; }
            const iframeEl = document.getElementById('presentation-office-iframe'); if (iframeEl) { iframeEl.style.display = 'none'; iframeEl.src = ''; }
            const loadingEl = document.getElementById('presentation-loading');
            if (loadingEl) {
                loadingEl.innerHTML = '<div class="spinner"></div><div>正在加载文档...</div>';
            }
            pdfDoc = null; presentationFile = null; currentPdfUrl = null; currentPage = 1; totalPages = 0;
            isLoopMode = false;     // 强制重置
            drawPageEvents.clear();
            drawMsgSeq = 0;
            drawStateByPage.clear();
            activeStrokeState = null;
            drawStateDirtyPage = null;
            publishStatus('idle');
            // 更新 UI 菜单状态（如果菜单已渲染）
            if (typeof renderPresSettingsMenu === 'function') renderPresSettingsMenu();
            
            // 退出演示模式，将侧边栏挪回 Body 并自动隐藏
            const sidebar = document.getElementById('discussion-sidebar');
            if(sidebar) {
                document.body.insertBefore(sidebar, document.getElementById('login-overlay'));
                if (sidebar.classList.contains('active')) {
                    sidebar.classList.remove('active');
                    const icon = document.getElementById('toggle-icon');
                    if (icon) icon.innerText = '<';
                }
            }
        }

        // 监听原生全屏状态切换以及窗口变化，及时重绘 PDF 适应新的尺寸
        document.addEventListener('fullscreenchange', () => {
            setTimeout(() => {
                const container = document.getElementById('presentation-canvas-container');
                if (container && container.offsetParent !== null && typeof renderPage === 'function' && pdfDoc && currentPage) {
                    renderPage(currentPage);
                }
            }, 100);
        });

        function togglePreviewFullscreen() {
            const target = document.getElementById('preview-container');
            if (!target) return;
            if (!document.fullscreenElement) {
                if (target.requestFullscreen) {
                    target.requestFullscreen().catch(err => console.log('预览区全屏失败:', err));
                }
            } else if (document.exitFullscreen) {
                document.exitFullscreen().catch(err => console.log('退出全屏失败:', err));
            }
        }

        let _resizeTimer = null;
        window.addEventListener('resize', () => {
            if (document.getElementById('presentation-mode').classList.contains('active')) {
                if (pdfDoc && currentPage && typeof renderPage === 'function') {
                    clearTimeout(_resizeTimer);
                    _resizeTimer = setTimeout(() => renderPage(currentPage), 150);
                }
            }
        });

        function muteAllRemote() {
            isMuteAllMode = !isMuteAllMode;
            if (mqttClient && mqttClient.connected) {
                mqttClient.publish(CONFIG.MQTT.STATUS_TOPIC, JSON.stringify({ 
                    action: isMuteAllMode ? 'mute_all' : 'unmute_all', 
                    timestamp: Date.now() 
                }), { qos: 0 });
            }
            renderPresSettingsMenu();
        }

        function toggleViewerControl() {
            isViewerCtrlMode = !isViewerCtrlMode;
            if(mqttClient && mqttClient.connected) {
                mqttClient.publish(CONFIG.MQTT.STATUS_TOPIC, JSON.stringify({
                    action: 'enable_control',
                    enabled: isViewerCtrlMode,
                    timestamp: Date.now()
                }), {qos: 0});
            }
            renderPresSettingsMenu();
        }

        function toggleViewerSharing() {
            isViewerSharingMode = !isViewerSharingMode;
            if(mqttClient && mqttClient.connected) {
                mqttClient.publish(CONFIG.MQTT.STATUS_TOPIC, JSON.stringify({
                    action: 'config_sharing',
                    allowed: isViewerSharingMode,
                    timestamp: Date.now()
                }), {qos: 0});
            }
            renderPresSettingsMenu();
        }

        function toggleViewerMic() {
            isViewerMicMode = !isViewerMicMode;
            if (mqttClient && mqttClient.connected) {
                mqttClient.publish(CONFIG.MQTT.STATUS_TOPIC, JSON.stringify({
                    action: 'config_mic',
                    allowed: isViewerMicMode,
                    timestamp: Date.now()
                }), { qos: 0 });
            }
            renderPresSettingsMenu();
        }

        function toggleViewerVideo() {
            isViewerVideoMode = !isViewerVideoMode;
            if (mqttClient && mqttClient.connected) {
                mqttClient.publish(CONFIG.MQTT.STATUS_TOPIC, JSON.stringify({
                    action: 'config_video',
                    allowed: isViewerVideoMode,
                    timestamp: Date.now()
                }), { qos: 0 });
            }
            renderPresSettingsMenu();
        }

        function toggleLoopMode() {
            isLoopMode = !isLoopMode;
            renderPresSettingsMenu();
        }


        function toggleFullScreen() {
            if (!document.fullscreenElement) {
                const root = document.documentElement;
                if (root && root.requestFullscreen) {
                    root.requestFullscreen().catch(err => console.log('进入全屏失败:', err));
                }
            } else {
                if (document.exitFullscreen) {
                    document.exitFullscreen();
                }
            }
        }

        function toggleDrawToolsVisibility() {
            const group = document.getElementById('draw-tools-group');
            if (group) {
                if (group.style.display === 'none') {
                    group.style.display = 'flex';
                    // 默认开启画笔
                    if (window.currentDrawTool === 'none' || !window.currentDrawTool) {
                        if (typeof toggleDrawTool === 'function') toggleDrawTool('pen');
                    }
                } else {
                    group.style.display = 'none';
                    if (typeof toggleDrawTool === 'function') toggleDrawTool('none');
                }
            }
            renderPresSettingsMenu();
        }

        function nextPageOrFile() {
            // 如果是 PDF 且不是最后一页，翻页
            if (pdfDoc && currentPage < totalPages) {
                nextPage();
                return;
            }
            // 否则尝试切换下一个文件
            playNextFile();
        }

        function prevPageOrFile() {
            // 如果是 PDF 且不是第一页，翻页
            if (pdfDoc && currentPage > 1) {
                prevPage();
                return;
            }
            // 否则尝试切换上一个文件
            playPrevFile();
        }

        function playNextFile() {
            if (!presentationFile) return;
            const idx = filesList.findIndex(f => f.path === presentationFile.path);
            if (idx === -1) return;

            // 寻找下一个可演示文件
            let nextIdx = idx + 1;
            while (nextIdx < filesList.length) {
                if (!filesList[nextIdx].isDir && isPresentationFile(filesList[nextIdx].name)) {
                    startPresentation(filesList[nextIdx]);
                    return;
                }
                nextIdx++;
            }

            // 如果是循环模式且到了末尾，回到开头
            if (isLoopMode) {
                let startIdx = 0;
                while (startIdx <= idx) {
                    if (!filesList[startIdx].isDir && isPresentationFile(filesList[startIdx].name)) {
                        startPresentation(filesList[startIdx]);
                        return;
                    }
                    startIdx++;
                }
            } else {
                // 提示已是最后一个
                // alert('已经是最后一个文件');
            }
        }

        function playPrevFile() {
            if (!presentationFile) return;
            const idx = filesList.findIndex(f => f.path === presentationFile.path);
            if (idx === -1) return;

            let prevIdx = idx - 1;
            while (prevIdx >= 0) {
                if (!filesList[prevIdx].isDir && isPresentationFile(filesList[prevIdx].name)) {
                    startPresentation(filesList[prevIdx]);
                    return;
                }
                prevIdx--;
            }
        }

        function nextPage() { if (!pdfDoc || currentPage >= totalPages) return; currentPage++; renderPage(currentPage); updatePageInfo(); publishPageChange(); syncAdminState(true); }
        function prevPage() { if (!pdfDoc || currentPage <= 1) return; currentPage--; renderPage(currentPage); updatePageInfo(); publishPageChange(); syncAdminState(true); }
        function gotoPage(page) { if (!pdfDoc) return; page = parseInt(page); if (page < 1) page = 1; if (page > totalPages) page = totalPages; currentPage = page; renderPage(currentPage); updatePageInfo(); publishPageChange(); syncAdminState(true); }
        function updatePageInfo() { document.getElementById('page-info').textContent = `页码: ${currentPage}${totalPages ? ' / ' + totalPages : ''}`; }

        document.addEventListener('keydown', (e) => {
            if (!presentationFile) return;
            if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); nextPageOrFile(); }
            else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); prevPageOrFile(); }
            else if (e.key === 'Escape') { e.preventDefault(); exitPresentation(); }
        });

        function getFileDownloadUrl(path, inline = false) {
            const disposition = inline ? '&inline=true' : '';
            return `${CONFIG.API_BASE}/api/download?path=${encodeURIComponent(path)}&token=${CONFIG.PREVIEW_TOKEN}${disposition}`;
        }
        function isPresentationFile(filename) {
            const ext = filename.split('.').pop().toLowerCase();
            return ['ppt', 'pptx', 'pdf', 'xls', 'xlsx', 'doc', 'docx', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'url'].includes(ext);
        }

        try { const saved = localStorage.getItem('webdav_custom_orders'); if (saved) customOrders = JSON.parse(saved); } catch (e) { }
        // loadFiles(""); // Deleted to prevent 401 error flashing before auth check completes

        document.addEventListener('click', () => { document.getElementById('ctx-menu').style.display = 'none'; });
        document.getElementById('file-list').addEventListener('contextmenu', e => { e.preventDefault(); });

        // --- 拖拽排序/移动 ---
        function setupDragDrop(item, fileObj, index) {
            item.setAttribute('draggable', 'true');
            item.addEventListener('dragstart', (e) => { draggedFile = fileObj; item.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', index); });
            item.addEventListener('dragend', (e) => { item.classList.remove('dragging'); document.querySelectorAll('.drag-over, .drag-over-top, .drag-over-bottom').forEach(el => { el.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom'); }); });
            const sortMode = document.getElementById('sort-select').value;
            if (sortMode === 'custom') {
                item.addEventListener('dragover', (e) => { if (!draggedFile || draggedFile.path === fileObj.path) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; const rect = item.getBoundingClientRect(); const midY = rect.top + rect.height / 2; item.classList.remove('drag-over-top', 'drag-over-bottom'); if (e.clientY < midY) { item.classList.add('drag-over-top'); } else { item.classList.add('drag-over-bottom'); } });
                item.addEventListener('dragleave', (e) => { item.classList.remove('drag-over-top', 'drag-over-bottom'); });
                item.addEventListener('drop', (e) => { e.preventDefault(); item.classList.remove('drag-over-top', 'drag-over-bottom'); if (!draggedFile || draggedFile.path === fileObj.path) return; const draggedIndex = filesList.findIndex(f => f.path === draggedFile.path); const targetIndex = filesList.findIndex(f => f.path === fileObj.path); if (draggedIndex === -1 || targetIndex === -1) return; const [removed] = filesList.splice(draggedIndex, 1); const rect = item.getBoundingClientRect(); const midY = rect.top + rect.height / 2; let insertIndex = targetIndex; if (draggedIndex < targetIndex && e.clientY > midY) { insertIndex = targetIndex; } else if (draggedIndex < targetIndex && e.clientY < midY) { insertIndex = targetIndex; } else if (draggedIndex > targetIndex && e.clientY < midY) { insertIndex = targetIndex; } else if (draggedIndex > targetIndex && e.clientY > midY) { insertIndex = targetIndex + 1; } filesList.splice(insertIndex, 0, removed); saveCustomOrder(); renderSortedList(); });
            } else if (fileObj.isDir) {
                item.addEventListener('dragover', (e) => { if (draggedFile && draggedFile.path !== fileObj.path) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; item.classList.add('drag-over'); } });
                item.addEventListener('dragleave', (e) => { item.classList.remove('drag-over'); });
                item.addEventListener('drop', async (e) => { e.preventDefault(); item.classList.remove('drag-over'); if (!draggedFile || draggedFile.path === fileObj.path) return; const fileName = draggedFile.name; const destPath = fileObj.path + '/' + fileName; try { const res = await fetch(CONFIG.API_BASE + '/api/move?source=' + encodeURIComponent(draggedFile.path) + '&dest=' + encodeURIComponent(destPath)); if (res.ok) { loadFiles(currentPath); document.getElementById("preview-container").innerHTML = '<div class="preview-msg">文件已移动到 ' + fileObj.name + '</div>'; } else { alert('移动失败'); } } catch (e) { alert('操作出错'); } });
            }
        }
        function applySortAndRender() { const sortType = document.getElementById('sort-select').value; sortFiles(sortType); renderSortedList(); }
        function sortFiles(type) {
            switch (type) {
                case 'custom': loadCustomOrder(); break;
                case 'name': filesList.sort((a, b) => a.name.localeCompare(b.name)); break;
                case 'type': filesList.sort((a, b) => { const extA = a.name.split('.').pop().toLowerCase(); const extB = b.name.split('.').pop().toLowerCase(); return extA.localeCompare(extB) || a.name.localeCompare(b.name); }); break;
                case 'date': filesList.sort((a, b) => new Date(b.modTime || 0) - new Date(a.modTime || 0)); break;
                case 'folder': filesList.sort((a, b) => { if (a.isDir && !b.isDir) return -1; if (!a.isDir && b.isDir) return 1; return a.name.localeCompare(b.name); }); break;
            }
        }
        function saveCustomOrder() { const order = filesList.map(f => f.path); customOrders[currentPath || '/'] = order; try { localStorage.setItem('webdav_custom_orders', JSON.stringify(customOrders)); } catch (e) { } }
        function loadCustomOrder() { try { const saved = localStorage.getItem('webdav_custom_orders'); if (saved) customOrders = JSON.parse(saved); } catch (e) { } const order = customOrders[currentPath || '/']; if (!order) return; const ordered = []; order.forEach(path => { const file = filesList.find(f => f.path === path); if (file) ordered.push(file); }); filesList.forEach(file => { if (!ordered.find(f => f.path === file.path)) { ordered.push(file); } }); filesList = ordered; }
        function renderSortedList() {
            const listEl = document.getElementById("file-list"); listEl.innerHTML = "";
            if (currentPath) { const back = document.createElement("div"); back.className = "file-item"; back.innerHTML = '<div class="file-icon">↩️</div><div class="file-name">..</div>'; back.onclick = () => loadFiles(currentPath.split("/").slice(0, -1).join("/")); listEl.appendChild(back); }
            filesList.forEach((fileObj, index) => {
                // 细节：过滤掉以 . 开头的隐藏转换文件
                if (fileObj.name.startsWith('.')) return;

                const item = document.createElement("div"); item.className = "file-item";
                const badge = isPresentationFile(fileObj.name) && !fileObj.isDir ? '<span class="file-badge">演示</span>' : '';
                item.innerHTML = `<div class="file-icon">${getIcon(fileObj.name, fileObj.isDir)}</div><div class="file-name">${fileObj.name}</div>${badge}`;
                
                let clickTimer = null;
                // 单击：选中并延迟预览 (防止与双击同时触发)
                item.onclick = () => { 
                    if (clickTimer) clearTimeout(clickTimer);
                    clickTimer = setTimeout(() => {
                        document.querySelectorAll(".file-item").forEach(el => el.classList.remove("selected")); 
                        item.classList.add("selected"); 
                        selectedFile = fileObj; 
                        if (!fileObj.isDir) {
                            previewFile(fileObj);
                        }
                    }, 250);
                };

                // 双击：进入目录 或 开启演示
                item.ondblclick = () => { 
                    if (clickTimer) clearTimeout(clickTimer);
                    if (fileObj.isDir) {
                        loadFiles(fileObj.path); 
                    } else if (isPresentationFile(fileObj.name)) {
                        startPresentation(fileObj);
                    }
                };
                item.oncontextmenu = (e) => showCtxMenu(e, fileObj);
                setupDragDrop(item, fileObj, index);
                listEl.appendChild(item);
            });
            // 为文件列表容器也增加右键监听（右键空白处）
            listEl.oncontextmenu = (e) => {
                if (e.target === listEl) {
                    showCtxMenu(e, null);
                }
            };
        }

        async function loadFiles(path) {
            // Requirement: Auto pause/resume based on navigation
            if (window.agoraModule) {
                const sharerUid = window.agoraModule.getActiveScreenSharerUid();
                if (sharerUid) {
                    if (path === '' || path === '/') {
                        window.agoraModule.setPresenterWatchPaused(false);
                    } else {
                        window.agoraModule.setPresenterWatchPaused(true);
                    }
                }
            }

            try {
                // 增加时间戳防止请求被浏览器缓存
                const url = CONFIG.API_BASE + '/api/list?path=' + encodeURIComponent(path || "") + '&_t=' + Date.now();
                console.log("Fetching:", url);
                const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
                if (!res.ok) throw new Error("API Error: " + res.status + " " + res.statusText);
                const text = await res.text();
                console.log("API Response:", text.substring(0, 100) + "...");
                parseFileList(text, path);
                currentPath = path;
                document.getElementById('current-path').textContent = path || "/";
                selectedFile = null;
                applySortAndRender();
            } catch (e) {
                console.error(e);
                document.getElementById('file-list').innerHTML = '<div style="padding:20px;color:red">加载失败: ' + e.message + '<br>请检查控制台(F12)获取详情</div>';
            }
        }

        function parseFileList(xmlString, path) {
            const parser = new DOMParser();
            const xml = parser.parseFromString(xmlString, "text/xml");
            filesList = [];

            // Use Namespace-agnostic selection
            const responses = xml.getElementsByTagNameNS("*", "response");
            console.log("Parsed entries count:", responses.length);

            // 处理 Collection (Nodelist)
            for (let i = 0; i < responses.length; i++) {
                const resp = responses[i];

                // 查找 href (忽略命名空间前缀)
                const hrefEl = resp.getElementsByTagNameNS("*", "href")[0];
                if (!hrefEl) continue;

                const href = hrefEl.textContent;

                // 提取文件名: 移除末尾斜杠 -> 取最后一段 -> URL解码
                let name = decodeURIComponent(href.replace(/\/$/, "").split("/").pop());

                // 过滤掉当前目录本身
                if (!name || (path && name === path.split("/").pop())) continue;
                // [Shadow PDF Strategy] 列表隐身：过滤掉 hidden 文件 (.xxx)
                if (name.startsWith('.')) continue;

                // 查找是否为文件夹
                let isDir = false;
                const prop = resp.getElementsByTagNameNS("*", "prop")[0];
                if (prop) {
                    const resType = prop.getElementsByTagNameNS("*", "resourcetype")[0];
                    if (resType) {
                        if (resType.getElementsByTagNameNS("*", "collection").length > 0) {
                            isDir = true;
                        }
                    }
                }

                // 查找修改时间
                let modTime = null;
                const getlastmodified = resp.getElementsByTagNameNS("*", "getlastmodified")[0];
                if (getlastmodified) {
                    modTime = getlastmodified.textContent;
                }

                const fullPath = path ? path + "/" + name : name;
                filesList.push({ path: fullPath, name: name, isDir: isDir, modTime: modTime });
            }
        }
        function showCtxMenu(e, file) { 
            e.preventDefault(); 
            e.stopPropagation(); 
            ctxFile = file; 
            document.querySelectorAll(".file-item").forEach(el => el.classList.remove("selected")); 
            if (e.currentTarget.classList.contains('file-item')) {
                e.currentTarget.classList.add("selected"); 
            }
            selectedFile = file; 
            const menu = document.getElementById('ctx-menu'); 
            
            // 如果点击的是具体文件/目录，显示相关操作
            if (file) {
                document.getElementById('ctx-download').style.display = file.isDir ? 'none' : 'block';
                document.getElementById('ctx-share').style.display = file.isDir ? 'none' : 'block';
            } else {
                // 点击空白处的逻辑（可以在以后扩展：如“在此新建”）
                document.getElementById('ctx-download').style.display = 'none';
                document.getElementById('ctx-share').style.display = 'none';
            }
            
            menu.style.display = 'block';
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const menuW = menu.offsetWidth || 180;
            const menuH = menu.offsetHeight || 240;
            const gap = 8;
            const left = Math.max(gap, Math.min(e.clientX, vw - menuW - gap));
            const top = Math.max(gap, Math.min(e.clientY, vh - menuH - gap));
            menu.style.left = left + 'px';
            menu.style.top = top + 'px';
        }

        async function ctxAction(action) {
            if (!ctxFile) return; const file = ctxFile;
            switch (action) {
                case 'open': if (file.isDir) loadFiles(file.path); else previewFile(file); break;
                case 'present': if (!file.isDir && isPresentationFile(file.name)) { startPresentation(file); } else { alert('此文件不支持演示模式'); } break;
                case 'download': if (file.isDir) return alert("文件夹不支持直接下载"); window.open(CONFIG.API_BASE + '/api/download?path=' + encodeURIComponent(file.path)); break;
                case 'share': const shareUrl = CONFIG.API_BASE + '/api/download?path=' + encodeURIComponent(file.path) + '&token=' + CONFIG.PREVIEW_TOKEN; try { await navigator.clipboard.writeText(shareUrl); alert("✅ 分享链接已复制到剪贴板!"); } catch (e) { alert("复制失败: " + shareUrl); } break;
                case 'delete': if (!confirm("确定删除 " + file.name + " 吗?")) return; await fetch(CONFIG.API_BASE + "/api/delete?path=" + encodeURIComponent(file.path)); loadFiles(currentPath); break;
                case 'rename': document.getElementById("input-rename").value = file.name; openModal('rename'); break;
                case 'move': moveCopyMode = 'move'; openMoveCopyModal(); break;
                case 'copy': moveCopyMode = 'copy'; openMoveCopyModal(); break;
            }
        }
        function openMoveCopyModal() { document.getElementById('movecopy-title').textContent = moveCopyMode === 'move' ? '移动到...' : '复制到...'; document.getElementById('input-movecopy-dest').value = ctxFile.path; openModal('movecopy'); }
        async function submitMoveCopy() {
            const destPath = document.getElementById('input-movecopy-dest').value.trim();
            if (!destPath || !ctxFile) return; if (destPath === ctxFile.path) return closeModal('movecopy');
            const endpoint = moveCopyMode === 'move' ? '/api/move' : '/api/copy';
            const btn = document.querySelector('#modal-movecopy .primary'); const originalText = btn.textContent; btn.textContent = "执行中..."; btn.disabled = true;
            try { const res = await fetch(CONFIG.API_BASE + endpoint + '?source=' + encodeURIComponent(ctxFile.path) + '&dest=' + encodeURIComponent(destPath)); if (res.ok) { closeModal('movecopy'); loadFiles(currentPath); if (moveCopyMode === 'move') { document.getElementById("preview-container").innerHTML = '<div class="preview-msg">文件已移动</div>'; document.getElementById('btn-save').style.display = 'none'; } } else { alert("操作失败 (可能是目标文件夹不存在)"); } } catch (e) { alert("网络错误"); }
            btn.textContent = originalText; btn.disabled = false;
        }

        async function previewFile(file) {
            // Requirement: Auto pause on preview
            if (window.agoraModule) window.agoraModule.setPresenterWatchPaused(true);

            const container = document.getElementById("preview-container"); const title = document.getElementById("preview-title"); const btnSave = document.getElementById("btn-save");
            btnSave.style.display = 'none'; container.innerHTML = '<div class="preview-msg">加载中...</div>'; title.textContent = file.name;
            const ext = file.name.split('.').pop().toLowerCase(); const fileUrl = getFileDownloadUrl(file.path, true);
            if (ext === 'url') { try { const res = await fetch(fileUrl); let targetUrl = (await res.text()).trim(); renderExternalLink(targetUrl, container); } catch (e) { container.innerHTML = '链接无效'; } return; }
            if (['txt', 'js', 'json', 'css', 'html', 'xml', 'md', 'py', 'java', 'log'].includes(ext)) { try { const res = await fetch(fileUrl); const text = await res.text(); container.innerHTML = `<textarea id="editor-textarea" spellcheck="false">${escapeHtml(text)}</textarea>`; btnSave.style.display = 'block'; } catch (e) { container.innerHTML = '文本加载失败'; } return; }
            if (['jpg', 'jpeg', 'png', 'gif', 'svg'].includes(ext)) { container.innerHTML = `<img src="${fileUrl}" class="preview-img">`; return; }
            if (ext === 'pdf') { container.innerHTML = `<iframe src="${fileUrl}" class="preview-iframe"></iframe>`; return; }
            if (['mp4', 'webm'].includes(ext)) { container.innerHTML = `<video src="${fileUrl}" controls autoplay class="preview-video"></video>`; return; }
            if (['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext)) { 
                const actualPath = getActualPath(file.path);
                const proxyUrl = CONFIG.API_BASE + "/api/file-proxy/" + encodeURIComponent(file.name) + "?path=" + encodeURIComponent(actualPath) + "&token=" + CONFIG.PREVIEW_TOKEN; 
                const b64 = utf8_to_b64(proxyUrl); 
                const kkUrl = CONFIG.KKFILEVIEW.URL + "/onlinePreview?url=" + encodeURIComponent(b64) + "&fullfilename=" + encodeURIComponent(file.name); 
                container.innerHTML = `<iframe src="${kkUrl}" class="preview-iframe"></iframe>`; 
                return; 
            }
            container.innerHTML = '<div class="preview-msg">不支持预览<br><br>请使用右键下载</div>';
        }
        function renderExternalLink(url, container) {
            let embedUrl = url;
            if (url.includes('bilibili.com')) {
                const bvid = url.match(/BV[a-zA-Z0-9]+/)?.[0];
                let page = 1;
                const pMatch = url.match(/[?&]p=(\d+)/) || url.match(/p=(\d+)/);
                if (pMatch) page = pMatch[1];
                const sidMatch = url.match(/[?&]sid=(\d+)/);
                const sidParam = sidMatch ? `&ss_id=${sidMatch[1]}` : '';
                embedUrl = `https://player.bilibili.com/player.html?bvid=${bvid || ''}&page=${page}${sidParam}&high_quality=1&danmaku=0&autoplay=1`;
            } else if (url.includes('youtube.com')) {
                embedUrl = 'https://www.youtube.com/embed/' + url.split('v=')[1].split('&')[0];
            } else if (url.match(/\.(mp4|webm)$/)) {
                container.innerHTML = `<video src="${url}" controls autoplay class="preview-video"></video>`; return;
            }
            container.innerHTML = `<div class="link-bar"><span>⚠️ 外部视频</span><a href="${url}" target="_blank" style="background:#e6a23c;color:white;text-decoration:none;padding:4px 10px;border-radius:4px">跳转观看</a></div><iframe src="${embedUrl}" class="preview-iframe"></iframe>`;
        }

        async function saveFile() { if (!selectedFile) return; const content = document.getElementById("editor-textarea").value; const btn = document.getElementById("btn-save"); btn.textContent = "保存中..."; await fetch(CONFIG.API_BASE + '/api/upload?path=' + encodeURIComponent(selectedFile.path), { method: 'PUT', body: content }); btn.textContent = "✅ 已保存"; setTimeout(() => { btn.textContent = "💾 保存修改"; }, 2000); }
        async function submitRename() { const name = document.getElementById("input-rename").value.trim(); if (!name || !ctxFile) return; const pathArr = ctxFile.path.split("/"); pathArr.pop(); const newPath = (pathArr.length ? pathArr.join("/") + "/" : "") + name; await fetch(CONFIG.API_BASE + '/api/move?source=' + encodeURIComponent(ctxFile.path) + '&dest=' + encodeURIComponent(newPath)); closeModal('rename'); loadFiles(currentPath); }
        async function submitMkdir() { const name = document.getElementById("input-mkdir").value.trim(); if (!name) return; await fetch(CONFIG.API_BASE + "/api/mkdir?path=" + encodeURIComponent(currentPath ? currentPath + "/" + name : name)); closeModal('mkdir'); loadFiles(currentPath); }
        async function submitLink() { let name = document.getElementById("input-link-name").value.trim(); const url = document.getElementById("input-link-url").value.trim(); if (!name.endsWith('.url')) name += '.url'; const path = currentPath ? currentPath + "/" + name : name; await fetch(CONFIG.API_BASE + '/api/create-link?path=' + encodeURIComponent(path), { method: 'POST', body: url }); closeModal('link'); loadFiles(currentPath); }
        async function submitBiliLink() {
            let name = document.getElementById("input-bili-name").value.trim();
            const url = document.getElementById("input-bili-url").value.trim();
            if (!name || !url) return alert('请填写完整信息');

            const btn = document.querySelector('#modal-bili .primary');
            const originalText = btn.textContent;
            btn.textContent = "正在生成专辑 (12s)...";
            btn.disabled = true;

            try {
                const res = await fetch(CONFIG.API_BASE + '/api/create-bili-topic', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: name,
                        url: url,
                        currentDir: currentPath
                    })
                });

                if (res.ok) {
                    const data = await res.json();
                    console.log(`✅ 专辑创建成功，共 ${data.count} 个分集`);
                    closeModal('bili');
                    loadFiles(currentPath);
                } else {
                    const err = await res.text();
                    alert('专辑创建失败: ' + err);
                }
            } catch (e) {
                alert('网络错误: ' + e.message);
            } finally {
                btn.textContent = originalText;
                btn.disabled = false;
            }
        }



        // 提取文件名: 移除末尾斜杠 -> 取最后一段 -> URL解码
        // 注意: 上面已经提取过 name 变量，这里只需要确保逻辑顺序
        // 原始代码:
        // let name = decodeURIComponent(href.replace(/\/$/, "").split("/").pop());
        // 所以我们应该把 filter 放在 name 定义之后。

        // 修正 parseFileList 逻辑 (合并入 handleUpload 修改，因为它们很近吗？不，它们相聚较远。split edits.)
        // 这里的 ReplacementContent 只能覆盖 handleUpload。
        // 我需要分两个 call。这里只改 parseFileList 的一小部分？
        // 线号 1573 是 handleUpload。parseFileList 是 1481。
        // 让我们专注于 handleUpload。

        function triggerUpload() { 
            // Requirement: Auto pause on upload click
            if (window.agoraModule) window.agoraModule.setPresenterWatchPaused(true);
            document.getElementById("upload-input").click(); 
        }

        async function handleUpload(files) {
            if (files.length === 0) return;

            // 创建简单进度条 UI
            let params = document.getElementById('upload-progress-container');
            if (!params) {
                const div = document.createElement('div');
                div.id = 'upload-progress-container';
                div.style.cssText = 'position:fixed; bottom:20px; right:20px; background:rgba(0,0,0,0.8); color:white; padding:15px; border-radius:8px; z-index:9999; width:300px; display:none;';
                div.innerHTML = '<div style="margin-bottom:5px;font-weight:bold;">正在上传...</div><div id="upload-progress-bar" style="width:0%; height:4px; background:#409eff; transition:width 0.2s;"></div><div id="upload-progress-text" style="font-size:12px; margin-top:5px; text-align:right;">0%</div>';
                document.body.appendChild(div);
                params = div;
            }
            params.style.display = 'block';
            const bar = document.getElementById('upload-progress-bar');
            const txt = document.getElementById('upload-progress-text');

            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const path = currentPath ? currentPath + "/" + file.name : file.name;

                // 使用 XHR 实现进度监控
                await new Promise((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('PUT', CONFIG.API_BASE + "/api/upload?path=" + encodeURIComponent(path), true); // PUT method match worker

                    xhr.upload.onprogress = (e) => {
                        if (e.lengthComputable) {
                            const percent = ((e.loaded / e.total) * 100).toFixed(0);
                            bar.style.width = percent + '%';
                            txt.textContent = `${percent}% (${i + 1}/${files.length})`;
                        }
                    };

                    xhr.onload = () => {
                        if (xhr.status >= 200 && xhr.status < 300) {
                            // 自定义逻辑：如果上传的是 Office 文件，静默触发后端转换
                            const ext = file.name.split('.').pop().toLowerCase();
                            if (['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext)) {
                                triggerSilentConversion(file.name, path);
                            }
                            resolve();
                        } else {
                            alert(`上传失败 ${file.name}: ${xhr.status}`);
                            reject(xhr.statusText);
                        }
                    };

                    xhr.onerror = () => {
                        alert(`网络错误 ${file.name}`);
                        reject(xhr.statusText);
                    };

                    xhr.send(file);
                });
            }

            // Upload complete
            txt.textContent = '完成!';
            bar.style.width = '100%';
            setTimeout(() => { params.style.display = 'none'; }, 2000); // 2秒后隐藏，体现 "Fire and Forget"
            loadFiles(currentPath);
        }

        async function triggerSilentConversion(fileName, path) {
            console.log('[Silent] 启动后台预转换:', fileName);
            const actualPath = getActualPath(path);
            const proxyUrl = `${CONFIG.API_BASE}/api/file-proxy/${encodeURIComponent(fileName)}?path=${encodeURIComponent(actualPath)}&token=${CONFIG.PREVIEW_TOKEN}`;
            const b64 = utf8_to_b64(proxyUrl);
            const kkUrl = `${CONFIG.KKFILEVIEW.URL}/onlinePreview?url=${encodeURIComponent(b64)}&officePreviewType=pdf`;

            try {
                // 1. 获取预览页 HTML
                const res = await fetch(kkUrl);
                const html = await res.text();

                // 2. 正则提取 PDF 物理地址
                const pdfMatch = html.match(/src=["']([^"']*\.pdf[^"']*)["']/i) ||
                    html.match(/file=["']([^"']*\.pdf[^"']*)["']/i) ||
                    html.match(/["'](https?:\/\/[^"']*\.pdf[^"']*)["']/i);

                let targetPdfUrl = null;
                if (pdfMatch && pdfMatch[1]) {
                    targetPdfUrl = pdfMatch[1];
                    if (targetPdfUrl.startsWith('/')) targetPdfUrl = CONFIG.KKFILEVIEW.URL + targetPdfUrl;
                } else {
                    targetPdfUrl = `${CONFIG.KKFILEVIEW.URL}/getCorsFile?urlPath=${encodeURIComponent(b64)}`;
                }

                if (targetPdfUrl) {
                    console.log('[Silent] 正在抓取 PDF 字节流...');
                    const pdfRes = await fetch(targetPdfUrl);
                    const pdfBlob = await pdfRes.blob();

                    // 3. 存储为隐藏文件 (.文件名.pdf)
                    const hiddenName = "." + fileName.replace(/\.[^/.]+$/, "") + ".pdf";
                    const hiddenPath = currentPath ? currentPath + "/" + hiddenName : hiddenName;

                    console.log('[Silent] 正在存入隐藏 PDF:', hiddenPath);
                    await fetch(CONFIG.API_BASE + "/api/upload?path=" + encodeURIComponent(hiddenPath), {
                        method: "POST",
                        body: pdfBlob
                    });
                    console.log('[Silent] 后台预转换完成!', fileName);
                }
            } catch (e) {
                console.error('[Silent] 后台预转换失败:', e);
            }
        }

        function refresh() { loadFiles(currentPath); }
        function openModal(type) { 
            // Requirement: Auto pause on modal open
            if (window.agoraModule) window.agoraModule.setPresenterWatchPaused(true);
            document.querySelectorAll('input').forEach(i => i.value = ''); 
            document.getElementById('modal-' + type).classList.add('show'); 
        }
        function closeModal(type) { document.getElementById('modal-' + type).classList.remove('show'); }
        function escapeHtml(text) { return text.replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]; }); }
        function getIcon(name, isDir) { if (isDir) return '📁'; const ext = name.split('.').pop().toLowerCase(); if (ext === 'url') return '🔗'; if (['ppt', 'pptx'].includes(ext)) return '📊'; if (['pdf'].includes(ext)) return '📕'; if (['xls', 'xlsx'].includes(ext)) return '📗'; if (['doc', 'docx'].includes(ext)) return '📘'; if (['jpg', 'png', 'gif'].includes(ext)) return '🖼️'; if (['mp4', 'webm'].includes(ext)) return '🎬'; if (['txt', 'js', 'md', 'json'].includes(ext)) return '📝'; return '📄'; }

        let isRegisterMode = false;
        function getLoginMediaDefaults() {
            return {
                enableAudio: !!(document.getElementById('login-default-mic') && document.getElementById('login-default-mic').checked),
                enableVideo: !!(document.getElementById('login-default-video') && document.getElementById('login-default-video').checked)
            };
        }

        async function applyLoginMediaDefaults() {
            const settings = getLoginMediaDefaults();
            if (window.agoraModule && typeof window.agoraModule.setDefaultSettings === 'function') {
                window.agoraModule.setDefaultSettings(settings);
            }
            if (window.agoraModule && typeof window.agoraModule.applyDefaultMediaOnLogin === 'function') {
                await window.agoraModule.applyDefaultMediaOnLogin();
            }
        }
        function toggleAuthMode() {
            isRegisterMode = !isRegisterMode;
            document.getElementById('login-title').textContent = isRegisterMode ? '注册专属空间' : '系统登录';
            document.getElementById('login-btn').textContent = isRegisterMode ? '立即注册 (可建200文件)' : '登录';
            document.getElementById('toggle-auth').textContent = isRegisterMode ? '已有账号？去登录' : '没有账号？免费注册';
            document.getElementById('login-hint').style.display = isRegisterMode ? 'none' : 'block';
            document.getElementById('login-error').style.display = 'none';
        }

        async function doLogin() {
            const user = document.getElementById('login-user').value.trim();
            const pass = document.getElementById('login-pass').value;
            const errObj = document.getElementById('login-error');
            
            if (!pass) {
                errObj.style.display = 'block'; errObj.textContent = '请输入密码'; return;
            }
            
            const actualUser = (user === '' && pass === '576257') ? 'admin' : user;
            if (!actualUser && !isRegisterMode) {
                errObj.style.display = 'block'; errObj.textContent = '请输入用户名'; return;
            }

            const endpoint = isRegisterMode ? '/api/register' : '/api/login';
            try {
                const res = await fetch(CONFIG.API_BASE + endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: actualUser, password: pass })
                });
                const data = await res.json();
                
                if (data.success) {
                    // 登录成功：隐藏 overlay
                    const overlay = document.getElementById('login-overlay');
                    overlay.classList.remove('visible');
                    // 等过渡动画结束后彻底隐藏
                    setTimeout(() => { overlay.style.visibility = 'hidden'; overlay.style.opacity = '0'; }, 260);
                    window.sessionUsername = (data.username || actualUser) + "_01";
                    window.storagePath = data.storagePath;
                    
                    const displayUsername = data.username || actualUser;
                    document.getElementById('current-user-display').innerHTML = `👤 ${displayUsername}`;
                    
                    // admin 登录后显示管理按鈕
                    if (displayUsername === 'admin') {
                        document.getElementById('btn-admin-users').style.display = 'inline-flex';
                    }
                    initMQTT();
                    loadFiles('/'); // 强制刷新由于权限变更
                    showDiscussionSidebarOnLogin();
                    await applyLoginMediaDefaults();
                    if (isRegisterMode) { alert('注册成功并已自动登录！'); }
                } else {
                    errObj.style.display = 'block'; errObj.textContent = data.error || '登录失败';
                }
            } catch(e) {
                errObj.style.display = 'block'; errObj.textContent = '网络请求失败';
            }
        }
        
        document.getElementById('login-pass').addEventListener('keypress', function (e) {
            if (e.key === 'Enter') doLogin();
        });

        window.addEventListener('DOMContentLoaded', async () => {
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.get('action') === 'register') toggleAuthMode();
            if (urlParams.get('u')) document.getElementById('login-user').value = urlParams.get('u');

            // 页面启动时先尝试恢复 Session，验证通过则无感知进入主页
            let sessionRestored = false;
            try {
                const res = await fetch(CONFIG.API_BASE + '/api/get_user');
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.username) {
                        sessionRestored = true;
                        window.sessionUsername = data.username + "_01";
                        window.storagePath = data.storagePath;
                        // Session 有效：overlay 保持隐藏，直接进入主页
                        document.getElementById('current-user-display').innerHTML = `👤 ${data.username}`;
                        if (data.username === 'admin') {
                            document.getElementById('btn-admin-users').style.display = 'inline-flex';
                        }
                        initMQTT();
                        loadFiles('/');
                        showDiscussionSidebarOnLogin();
                        await applyLoginMediaDefaults();
                    }
                }
            } catch(e) {}

            // 验证失败（未登录）才淡入显示登录界面
            if (!sessionRestored) {
                document.getElementById('login-overlay').classList.add('visible');
            }
        });
    


        // === 管理员用户管理面板 ===
        async function openAdminPanel() {
            // Requirement: Auto pause on admin panel open
            if (window.agoraModule) window.agoraModule.setPresenterWatchPaused(true);
            document.getElementById('modal-admin-users').classList.add('show');
            await refreshAdminUserList();
        }
        function closeAdminPanel() {
            document.getElementById('modal-admin-users').classList.remove('show');
        }
        async function refreshAdminUserList() {
            const listEl = document.getElementById('admin-user-list');
            listEl.innerHTML = '<div style="color:#999;text-align:center;padding:20px;">加载中...</div>';
            try {
                const res = await fetch(CONFIG.API_BASE + '/api/admin/users');
                const data = await res.json();
                if (!data.success) { listEl.innerHTML = '获取失败'; return; }
                if (data.users.length === 0) { listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#999;">暂无用户</div>'; return; }
                listEl.innerHTML = data.users.map(u => `
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #f0f0f0;">
                        <div>
                            <div style="font-weight:bold;">👤 ${u.username}</div>
                            <div style="font-size:11px;color:#999;">房间号: ${u.username} &nbsp;|&nbsp; 注册: ${u.created ? new Date(u.created).toLocaleDateString() : '-'}</div>
                        </div>
                        <button onclick="deleteUser('${u.username}')" style="background:#f56c6c;color:white;border:none;border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12px;">🗑️ 删除</button>
                    </div>
                `).join('');
            } catch(e) { listEl.innerHTML = '请求失败'; }
        }
        async function deleteUser(username) {
            if (!confirm(`确定删除用户「${username}」？其文件也将一并删除。`)) return;
            const res = await fetch(CONFIG.API_BASE + '/api/admin/users?username=' + encodeURIComponent(username), { method: 'DELETE' });
            const data = await res.json();
            if (data.success) { await refreshAdminUserList(); } else { alert('删除失败: ' + (data.error||'')); }
        }
    



        if ('serviceWorker' in navigator) {
            async function handleDiscussionFileUpload(input) {
            if (!input.files || input.files.length === 0) return;
            const file = input.files[0];
            input.value = ''; // reset for re-upload

            addMessageToUI({ text: `正在上传文件: ${file.name}...`, sender: '系统', action: 'chat', timestamp: Date.now() }, false);

            try {
                const arrayBuffer = await file.arrayBuffer();
                // Use the auth-free /api/chat/upload endpoint (handles WebDAV internally)
                const resp = await fetch(`${CONFIG.API_BASE}/api/chat/upload?filename=${encodeURIComponent(file.name)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    body: arrayBuffer
                });
                const result = await resp.json();
                if (result.success && result.url) {
                    const fileUrl = result.url;
                    const imgExts = ['jpg','jpeg','png','gif','bmp','webp'];
                    const ext = file.name.split('.').pop().toLowerCase();
                    const isImage = imgExts.includes(ext);

                    const fileMsg = {
                        roomId: getChatRoomId(),
                        action: isImage ? 'chat_image' : 'file_link',
                        sender: window.sessionUsername || '主播',
                        sessionId: mySessionId,
                        fileName: file.name,
                        fileSize: (file.size / 1024).toFixed(1) + ' KB',
                        url: fileUrl,
                        imageUrl: isImage ? fileUrl : undefined,
                        timestamp: Date.now()
                    };
                    fetch(CONFIG.API_BASE + '/api/chat/send', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(fileMsg)
                    }).catch(e => console.error('Chat file send failed:', e));
                    addMessageToUI(fileMsg, true);
                } else {
                    addMessageToUI({ text: `文件上传失败 (${result.error || resp.status})`, sender: '系统', action: 'chat', timestamp: Date.now() }, false);
                }
            } catch (e) {
                console.error('文件上传失败:', e);
                addMessageToUI({ text: '文件分享失败', sender: '系统', action: 'chat', timestamp: Date.now() }, false);
            }
        }

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

        // --- 安全防护逻辑 ---
        function toggleFullScreen() {
            if (!document.fullscreenElement) {
                const elem = document.getElementById('presentation-mode');
                if (elem.requestFullscreen) {
                    elem.requestFullscreen().catch(err => console.log('进入全屏失败:', err));
                }
            } else {
                if (document.exitFullscreen) {
                    document.exitFullscreen();
                }
            }
        }

        function toggleDrawToolsVisibility() {
            const group = document.getElementById('draw-tools-group');
            if (group) {
                if (group.style.display === 'none') {
                    group.style.display = 'flex';
                    // 默认开启画笔
                    if (window.currentDrawTool === 'none' || !window.currentDrawTool) {
                        toggleDrawTool('pen');
                    }
                } else {
                    group.style.display = 'none';
                    if (typeof toggleDrawTool === 'function') toggleDrawTool('none');
                }
            }
            renderPresSettingsMenu();
        }

        function toggleSecureMode() {
            isSecureMode = !isSecureMode;
            const btn = document.getElementById('btn-secure');
            if (isSecureMode) {
                btn.innerHTML = '🛡️ 防护: 开';
                btn.style.color = '#67c23a';
                btn.style.backgroundColor = '#f0f9eb';
                document.getElementById('ctx-download').style.display = 'none';
                document.getElementById('ctx-share').style.display = 'none';
            } else {
                btn.innerHTML = '🔓 防护: 关';
                btn.style.color = '#f56c6c'; // 红色警告色
                btn.style.backgroundColor = '#fef0f0';
                document.getElementById('ctx-download').style.display = 'block';
                document.getElementById('ctx-share').style.display = 'block';
            }
        }

        // 拦截按键 (F12, Ctrl+Shift+I, Ctrl+S等)
        document.addEventListener('keydown', (e) => {
            // 如果是防护模式，并且按下了敏感键
            if (isSecureMode) {
                if (e.key === 'F12' ||
                    (e.ctrlKey && e.shiftKey && ['I', 'J', 'C'].includes(e.key)) ||
                    (e.ctrlKey && e.key === 'u') ||
                    (e.ctrlKey && e.key === 's')
                ) {
                    e.preventDefault();
                    // console.log('Protected');
                }
            }
        });

        // --- 会议邀请函功能 ---
        function showInviteModal() {
            document.getElementById('invite-modal').style.display = 'flex';
            if(typeof renderMeetingList === 'function') renderMeetingList();
            if(typeof viewDefaultRoom === 'function') viewDefaultRoom();
        }

        function closeInviteModal() {
            document.getElementById('invite-modal').style.display = 'none';
        }

        function renderMeetingList() {
            const rawName = (window.sessionUsername || currentUser || 'admin').replace(/_\d+$/, '');
            let myMeetings = JSON.parse(localStorage.getItem('myMeetings_' + rawName) || '[]');
            const listDiv = document.getElementById('meeting-list');
            if(!listDiv) return;
            listDiv.innerHTML = '';

            const defDom = document.createElement('div');
            defDom.style.cssText = 'padding: 10px; border-radius: 6px; border: 1px solid #ebeef5; cursor: pointer; background: #fffcf8; transition: 0.2s; box-shadow: 0 2px 4px rgba(0,0,0,0.02); display: flex; flex-direction: column; margin-bottom: 8px;';
            defDom.innerHTML = `<div style="font-weight:bold; font-size:14px; color:#e6a23c; margin-bottom:4px; display:flex; align-items:center; gap:6px;">👑 专属默认会场 <span style="font-size:10px; font-weight:normal; background:#fdf6ec; color:#e6a23c; padding:2px 4px; border-radius:3px;">随时用</span></div>
                                 <div style="font-size:12px; color:#606266; display:flex; justify-content:space-between; align-items:center;">
                                    <span>随时直接主持，给链接直接进</span>
                                    <span style="background:#f0f9eb; color:#67c23a; padding:1px 4px; border-radius:2px;">#主频道</span>
                                 </div>`;
            defDom.onmouseover = () => defDom.style.borderColor = '#e6a23c';
            defDom.onmouseout = () => defDom.style.borderColor = '#ebeef5';
            defDom.onclick = () => viewDefaultRoom();
            listDiv.appendChild(defDom);

            myMeetings.forEach((m, idx) => {
                const dom = document.createElement('div');
                dom.style.cssText = 'padding: 10px; border-radius: 6px; border: 1px solid #ebeef5; cursor: pointer; background: white; transition: 0.2s; box-shadow: 0 2px 4px rgba(0,0,0,0.02); display: flex; flex-direction: column; margin-bottom: 8px;';
                dom.innerHTML = `<div style="font-weight:bold; font-size:14px; color:#303133; margin-bottom:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${m.topic || '互动演示会议'}</div>
                                 <div style="font-size:12px; color:#606266; display:flex; justify-content:space-between; align-items:center;">
                                    <span>🕒 ${m.timeLabel ? m.timeLabel : (m.timeStr ? m.timeStr.replace('T', ' ') : '待定')}</span>
                                    <span style="background:#f0f9eb; color:#67c23a; padding:1px 4px; border-radius:2px;">#${m.slug || '主房间'}</span>
                                 </div>`;
                dom.onmouseover = () => dom.style.borderColor = '#409eff';
                dom.onmouseout = () => dom.style.borderColor = '#ebeef5';
                dom.onclick = () => viewMeeting(idx);
                listDiv.appendChild(dom);
            });
            if (typeof drawCalendarGrid === 'function' && __isCalendarView) {
                drawCalendarGrid();
            }
        }

        function newMeetingForm() {
            document.getElementById('booking-form-mask').style.display = 'none';
            document.getElementById('booking-form-title').innerText = '新建预约';
            document.getElementById('invite-topic').value = '';
            document.getElementById('invite-time').value = '';
            const endElem = document.getElementById('invite-time-end');
            if(endElem) endElem.value = '';
            const slugInput = document.getElementById('invite-room-slug');
            if(slugInput) slugInput.value = Math.random().toString(36).substr(2, 4).toUpperCase();
            document.getElementById('invite-freq').value = 'once';
            document.getElementById('invite-emails').value = '';
            
            if(typeof handleFreqChange === 'function') handleFreqChange();
            document.getElementById('current-viewing-meeting-idx').value = '-1';
            
            document.getElementById('btn-save-booking').style.display = 'block';
            let editActions = document.getElementById('booking-edit-actions');
            if(editActions) editActions.style.display = 'none';
            
            const btnEdit = document.getElementById('btn-edit-meeting');
            if(btnEdit) btnEdit.style.display = 'block';

            document.getElementById('share-card').style.display = 'none';
            document.getElementById('booking-placeholder').style.display = 'block';
        }

        function viewMeeting(idx) {
            const rawName = (window.sessionUsername || currentUser || 'admin').replace(/_\d+$/, '');
            let myMeetings = JSON.parse(localStorage.getItem('myMeetings_' + rawName) || '[]');
            const m = myMeetings[idx];
            if(!m) return;
            
            document.getElementById('booking-form-mask').style.display = 'block'; // block editing
            document.getElementById('booking-form-title').innerText = '会议详情 (已锁)';
            document.getElementById('invite-topic').value = m.topic || '';
            document.getElementById('invite-time').value = m.timeStr || '';
            const endElem = document.getElementById('invite-time-end');
            if(endElem) endElem.value = m.endTimeStr || '';
            const slugInput = document.getElementById('invite-room-slug');
            if(slugInput) slugInput.value = m.slug || '';
            document.getElementById('invite-freq').value = m.freq || 'once';
            document.getElementById('invite-emails').value = m.emailsText || '';
            
            if(typeof handleFreqChange === 'function') handleFreqChange();
            if(m.freqWeekday) { const wd = document.getElementById('invite-freq-weekday'); if(wd) wd.value = m.freqWeekday; }
            if(m.freqMonthday) { const md = document.getElementById('invite-freq-monthday'); if(md) md.value = m.freqMonthday; }
            document.getElementById('current-viewing-meeting-idx').value = idx;
            
            document.getElementById('btn-save-booking').style.display = 'none';
            let editActions = document.getElementById('booking-edit-actions');
            if(editActions) editActions.style.display = 'none';

            const btnEdit = document.getElementById('btn-edit-meeting');
            if(btnEdit) btnEdit.style.display = 'block';

            // Show right side
            document.getElementById('invite-text').value = m.text;
            const urlInput = document.getElementById('invite-url-only');
            if(urlInput) urlInput.value = m.remoteUrl || '';
            const qrDiv = document.getElementById('qrcode');
            qrDiv.innerHTML = '';
            if (typeof QRCode !== 'undefined') {
                new QRCode(qrDiv, { text: m.remoteUrl, width: 140, height: 140, colorDark : "#2c3e50", colorLight : "#ffffff" });
            } else {
                qrDiv.innerHTML = `<a href="${m.remoteUrl}" target="_blank">🔗 点击加入会议</a>`;
            }
            document.getElementById('share-card').style.display = 'block';
            document.getElementById('booking-placeholder').style.display = 'none';
        }

        function viewDefaultRoom() {
            document.getElementById('booking-form-mask').style.display = 'block';
            document.getElementById('booking-form-title').innerText = '默认主会场 (无需设置)';
            document.getElementById('invite-topic').value = '无主题自由会场';
            document.getElementById('invite-time').value = '';
            const endElem = document.getElementById('invite-time-end');
            if(endElem) endElem.value = '';
            const slugInput = document.getElementById('invite-room-slug');
            if(slugInput) slugInput.value = ''; // Always empty for main room
            document.getElementById('invite-freq').value = 'once';
            document.getElementById('invite-emails').value = '';
            
            if(typeof handleFreqChange === 'function') handleFreqChange();
            document.getElementById('current-viewing-meeting-idx').value = '-1';
            
            document.getElementById('btn-save-booking').style.display = 'none';
            let editActions = document.getElementById('booking-edit-actions');
            if(editActions) editActions.style.display = 'none';

            const rawName = (window.sessionUsername || currentUser || 'admin').replace(/_\d+$/, '');
            let remoteUrl = window.location.href.split('?')[0];
            if (remoteUrl.includes('index.html')) remoteUrl = remoteUrl.replace('index.html', 'remote.html');
            else if (remoteUrl.endsWith('/')) remoteUrl += 'remote.html';
            else remoteUrl += '/remote.html';
            remoteUrl += '?room=' + encodeURIComponent(rawName);

            const text = `您好，这里是我的常规主会场：\n主题：${rawName}的演示厅\n时间：随时入会皆可\n点击下方专属链接，快速进入共享现场：\n${remoteUrl}`;
            document.getElementById('invite-text').value = text;
            const urlInput = document.getElementById('invite-url-only');
            if(urlInput) urlInput.value = remoteUrl;
            const qrDiv = document.getElementById('qrcode');
            qrDiv.innerHTML = '';
            if (typeof QRCode !== 'undefined') {
                new QRCode(qrDiv, { text: remoteUrl, width: 140, height: 140, colorDark : "#2c3e50", colorLight : "#ffffff" });
            } else {
                qrDiv.innerHTML = `<a href="${remoteUrl}" target="_blank">🔗 点击加入会议</a>`;
            }
            
            const btnEdit = document.getElementById('btn-edit-meeting');
            if(btnEdit) btnEdit.style.display = 'none'; // Cannot edit or delete the default room

            document.getElementById('share-card').style.display = 'block';
            document.getElementById('booking-placeholder').style.display = 'none';
        }

        function editCurrentMeeting() {
            document.getElementById('booking-form-mask').style.display = 'none';
            document.getElementById('booking-form-title').innerText = '编辑预约 (修改时间 / 取消删除)';
            document.getElementById('booking-edit-actions').style.display = 'flex';
        }

        async function deleteCurrentMeeting() {
            const rawName = (window.sessionUsername || currentUser || 'admin').replace(/_\d+$/, '');
            let myMeetings = JSON.parse(localStorage.getItem('myMeetings_' + rawName) || '[]');
            const editId = document.getElementById('current-viewing-meeting-idx').value;
            if (editId && editId !== '-1') {
                if(!confirm('确定彻底删除此系列会议日程吗？（系统会自动向收件人箱发送取消通知邮件）')) return;
                
                const targetMeeting = myMeetings[editId];
                if(targetMeeting && targetMeeting.emailsText) {
                    const emails = targetMeeting.emailsText.split(/[,，\n]/).map(e => e.trim()).filter(e => e.includes('@'));
                    if (emails.length > 0) {
                        try {
                            const htmlContent = `
                            <div style="font-family: Arial, sans-serif; padding: 20px; background: #fff0f0;">
                                <div style="max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);">
                                    <h2 style="color: #f56c6c; margin-top: 0;">🚫 会议取消通知</h2>
                                    <p>您好，原定于 <strong>${targetMeeting.timeLabel||targetMeeting.time||'待定'}</strong> 的会议：</p>
                                    <p style="font-size: 16px;">主题：<strong>${targetMeeting.topic}</strong></p>
                                    <p>现已<strong>彻底取消</strong>，特此通知，请您合理安排时间。</p>
                                </div>
                            </div>`;
                            await fetch('https://email.beundredig.eu.org/send-email', {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    to: emails, subject: `【会议取消】 ${targetMeeting.topic}`, html: htmlContent
                                })
                            });
                        } catch(e) { console.error('Failed to send cancellation', e); }
                    }
                }

                myMeetings.splice(parseInt(editId, 10), 1);
                localStorage.setItem('myMeetings_' + rawName, JSON.stringify(myMeetings));
                renderMeetingList();
                newMeetingForm();
            }
        }

        function updateFreqLabels() {
            const timeStr = document.getElementById('invite-time').value;
            if (!timeStr) return;
            const d = new Date(timeStr);
            const wd = document.getElementById('invite-freq-weekday');
            if(wd) wd.value = d.getDay() === 0 ? 0 : d.getDay();
            const md = document.getElementById('invite-freq-monthday');
            if(md) md.value = d.getDate();
        }

        function handleFreqChange() {
            const val = document.getElementById('invite-freq').value;
            const wk = document.getElementById('invite-freq-weekday');
            const md = document.getElementById('invite-freq-monthday');
            if (['weekly', 'biweekly', 'quadweekly'].includes(val)) {
                if(wk) wk.style.display = 'block';
                if(md) md.style.display = 'none';
            } else if (['monthly', 'bimonthly', 'trimonthly', 'halfyearly'].includes(val)) {
                if(wk) wk.style.display = 'none';
                if(md) md.style.display = 'block';
            } else {
                if(wk) wk.style.display = 'none';
                if(md) md.style.display = 'none';
            }
        }

        let __isCalendarView = false;
        function toggleCalendarView() {
            __isCalendarView = !__isCalendarView;
            if(__isCalendarView) {
                document.getElementById('booking-layout-row').style.display = 'none';
                document.getElementById('calendar-layout').style.display = 'flex';
                document.getElementById('toggle-calendar-btn').innerText = '📋 切换回列表视图';
                drawCalendarGrid();
            } else {
                document.getElementById('booking-layout-row').style.display = 'flex';
                document.getElementById('calendar-layout').style.display = 'none';
                document.getElementById('toggle-calendar-btn').innerText = '📅 切换大日历视图';
            }
        }

        let calCurrentDate = new Date();
        function drawCalendarGrid() {
            const container = document.getElementById('calendar-grid-container');
            const year = calCurrentDate.getFullYear();
            const month = calCurrentDate.getMonth();
            document.getElementById('calendar-month-label').innerText = `${year} 年 ${month + 1} 月`;
            
            const firstDay = new Date(year, month, 1).getDay();
            const daysInMonth = new Date(year, month + 1, 0).getDate();
            
            let html = `<table style="width:100%; height:100%; border-collapse: collapse; table-layout: fixed;">
                            <tr style="height:35px; background:#f0f4f9; color:#333; font-size:14px; font-weight:bold; text-align:center;">
                                <td style="border:1px solid #ddd;">周日</td><td style="border:1px solid #ddd;">周一</td><td style="border:1px solid #ddd;">周二</td><td style="border:1px solid #ddd;">周三</td><td style="border:1px solid #ddd;">周四</td><td style="border:1px solid #ddd;">周五</td><td style="border:1px solid #ddd;">周六</td>
                            </tr><tr>`;
            
            let dayOfWeek = 0;
            for(let i=0; i<firstDay; i++) {
                html += `<td style="border:1px solid #eee; background:#fafafa;"></td>`;
                dayOfWeek++;
            }
            
            const rawName = (window.sessionUsername || currentUser || 'admin').replace(/_\d+$/, '');
            let myMeetings = JSON.parse(localStorage.getItem('myMeetings_' + rawName) || '[]');
            
            for(let d=1; d<=daysInMonth; d++) {
                if(dayOfWeek === 7) {
                    html += `</tr><tr>`;
                    dayOfWeek = 0;
                }
                const isToday = (new Date().toDateString() === new Date(year, month, d).toDateString());
                let cellHtml = `<td style="border:1px solid #ebeef5; vertical-align:top; padding:8px; ${isToday?'background:#fff9f0;': 'background:#fff;'} height:100px;">
                    <div style="font-weight:bold; font-size:14px; color:${isToday?'#e6a23c':'#606266'}; margin-bottom:8px;">${d}</div>
                    <div style="display:flex; flex-direction:column; gap:4px; height: 70px; overflow-y:auto; scrollbar-width:thin;">`;
                
                myMeetings.forEach(m => {
                    let mDateStr = m.timeStr ? m.timeStr.split('T')[0] : '';
                    let dStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
                    if(mDateStr === dStr) {
                        cellHtml += `<div onclick="hostMeetingFromCalendar('${m.slug||''}')" style="background:#e53935; color:white; font-size:12px; padding:4px 6px; border-radius:3px; cursor:pointer; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;" title="${m.topic} - 点击主持">▶ ${m.timeLabel||''} ${m.topic}</div>`;
                    }
                });
                
                cellHtml += `</div></td>`;
                html += cellHtml;
                dayOfWeek++;
            }
            while(dayOfWeek < 7) {
                html += `<td style="border:1px solid #eee; background:#fafafa;"></td>`;
                dayOfWeek++;
            }
            html += `</tr></table>`;
            container.innerHTML = html;
        }
        function calPrevMonth() { calCurrentDate.setMonth(calCurrentDate.getMonth() - 1); drawCalendarGrid(); }
        function calNextMonth() { calCurrentDate.setMonth(calCurrentDate.getMonth() + 1); drawCalendarGrid(); }
        
        function hostMeetingFromCalendar(slug) {
            initMQTT(slug);
            alert(`已一键切换至频道：${slug || '主房间'}！您可以开始主持了。`);
            closeInviteModal();
            const ptitle = document.getElementById('page-title');
            if(ptitle) ptitle.innerHTML = `会议进行中：${slug || '主房间'} <span style="font-size:12px;color:#67c23a">● Live</span>`;
        }

        async function generateInvitation() {
            const topic = document.getElementById('invite-topic').value || '互动演示会议';
            let timeStr = document.getElementById('invite-time').value;
            let endStr = document.getElementById('invite-time-end') ? document.getElementById('invite-time-end').value : '';
            
            let timeLabel = '待定';
            if (timeStr) {
                const d = new Date(timeStr);
                const mm = d.getMonth() + 1;
                const dd = d.getDate();
                const hr = String(d.getHours()).padStart(2, '0');
                const min = String(d.getMinutes()).padStart(2, '0');
                timeLabel = `${mm}/${dd} ${hr}:${min}`;
                if (endStr) {
                    timeLabel += `-${endStr}`;
                }
            }
            const time = timeLabel;
            const freqSelect = document.getElementById('invite-freq');
            const freq  = freqSelect.value;
            let freqText = freqSelect.options[freqSelect.selectedIndex].text;
            let freqWeekday = '';
            let freqMonthday = '';

            if (['weekly', 'biweekly', 'quadweekly'].includes(freq)) {
                const wk = document.getElementById('invite-freq-weekday');
                if(wk) {
                    freqWeekday = wk.value;
                    freqText += ` (逢${wk.options[wk.selectedIndex].text})`;
                }
            } else if (['monthly', 'bimonthly', 'trimonthly', 'halfyearly'].includes(freq)) {
                const md = document.getElementById('invite-freq-monthday');
                if(md) {
                    freqMonthday = md.value;
                    freqText += ` (每月 ${md.options[md.selectedIndex].text})`;
                }
            }
            
            let slugInput = document.getElementById('invite-room-slug');
            if (slugInput && !slugInput.value) {
                slugInput.value = Math.random().toString(36).substr(2, 4).toUpperCase();
            }
            const slug = slugInput ? slugInput.value : '';
            
            const emailsText = document.getElementById('invite-emails').value;
            
            const rawName = (window.sessionUsername || currentUser || 'admin').replace(/_\d+$/, '');
            const finalRoomId = slug ? `${rawName}_${slug}` : rawName;
            
            let remoteUrl = window.location.href.split('?')[0];
            if (remoteUrl.includes('index.html')) {
                remoteUrl = remoteUrl.replace('index.html', 'remote.html');
            } else if (remoteUrl.endsWith('/')) {
                remoteUrl += 'remote.html';
            } else {
                remoteUrl += '/remote.html';
            }
            remoteUrl += '?room=' + encodeURIComponent(finalRoomId);

            const text = `您好，诚邀您参加以下会议：\n主题：${topic}\n时间：${timeLabel}\n频率：${freqText}\n点击链接或扫码即可直接进入实时演示：\n${remoteUrl}`;
            document.getElementById('invite-text').value = text;
            const urlInput = document.getElementById('invite-url-only');
            if(urlInput) urlInput.value = remoteUrl;
            
            // 存入日程列表
            let myMeetings = JSON.parse(localStorage.getItem('myMeetings_' + rawName) || '[]');
            const editId = document.getElementById('current-viewing-meeting-idx').value;
            const mObj = { id: Date.now(), topic, timeStr, endTimeStr: endStr, timeLabel, time, slug, freq, freqWeekday, freqMonthday, freqText: freqText, emailsText, remoteUrl, text };
            
            if (editId && editId !== '-1') {
                myMeetings[parseInt(editId, 10)] = mObj;
            } else {
                myMeetings.push(mObj);
            }
            
            localStorage.setItem('myMeetings_' + rawName, JSON.stringify(myMeetings));
            
            renderMeetingList();
            viewMeeting(editId !== '-1' ? parseInt(editId, 10) : myMeetings.length - 1);

            // 发送邮件部分
            const emails = emailsText.split(/[,，\n]/).map(e => e.trim()).filter(e => e.includes('@'));
            if (emails.length > 0) {
                await sendInvitationEmail(emails, topic, time, freqText, remoteUrl);
            }
        }

        async function sendInvitationEmail(recipients, topic, time, freqText, remoteUrl) {
            const htmlContent = `
            <div style="font-family: Arial, sans-serif; padding: 20px; background: #f4f4f4;">
                <div style="max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);">
                    <h2 style="color: #409eff; margin-top: 0;">📅 会议预约通知</h2>
                    <p>您好，邀请您参加以下线上演示会议：</p>
                    <div style="background: #f9f9f9; padding: 15px; border-left: 4px solid #409eff; margin-bottom: 20px;">
                        <p style="margin: 5px 0;"><strong>会议主题：</strong>${topic}</p>
                        <p style="margin: 5px 0;"><strong>会议时间：</strong>${time}</p>
                        <p style="margin: 5px 0;"><strong>重复频率：</strong>${freqText}</p>
                    </div>
                    <p>请在会议开始时，点击下方按钮直接加入演示房间：</p>
                    <a href="${remoteUrl}" style="display: inline-block; padding: 12px 24px; background: #67c23a; color: white; text-decoration: none; border-radius: 4px; font-weight: bold;">直接加入会议</a>
                    <p style="margin-top: 20px; font-size: 14px; color: #666;">或复制此链接至浏览器打开：<br><a href="${remoteUrl}">${remoteUrl}</a></p>
                </div>
            </div>`;

            try {
                // 调用测试过的代理 Email Worker 接口发信
                const res = await fetch('https://email.beundredig.eu.org', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        to: recipients, 
                        subject: `会议邀请: ${topic}`, 
                        html: htmlContent 
                    })
                });
                if (res.ok) {
                    // console.log("邮件发送成功");
                }
            } catch (err) {
                console.error("邮件发送失败", err);
            }
        }

        function openRemoteLink() {
            const slug = document.getElementById('invite-room-slug') ? document.getElementById('invite-room-slug').value.trim() : '';
            // 切换本页面的底层会议频道，实现物理隔离
            initMQTT(slug);
            
            // 提示用户并关闭弹窗
            alert(`已切换到会议频道：${slug || '主房间'}\n您现在开始的任何演示操作都只会在这个独立的频道内广播！`);
            closeInviteModal();
            document.getElementById('page-title').innerHTML = `会议进行中：${slug || '主房间'} <span style="font-size:12px;color:#67c23a">● Live</span>`;
        }

        function copyInvitation() {
            const text = document.getElementById('invite-text').value;
            navigator.clipboard.writeText(text).then(() => {
                alert('✅ 会议邀请已复制到剪贴板！');
            }).catch(() => {
                const area = document.getElementById('invite-text');
                area.select();
                document.execCommand('copy');
                alert('✅ 会议邀请已复制！');
            });
        }

        function copyMeetingLink() {
            const url = document.getElementById('invite-url-only').value;
            if(!url) return;
            navigator.clipboard.writeText(url).then(() => {
                alert('✅ 会议链接已单独复制！');
            }).catch(() => {
                const inp = document.getElementById('invite-url-only');
                inp.select();
                document.execCommand('copy');
                alert('✅ 会议链接已复制！');
            });
        }

        function showGuestLogin() {
            const animals = ['Panda','Tiger','Dolphin','Eagle','Falcon','Jaguar','Otter','Penguin','Rabbit','Koala','Wolf','Fox','Leopard','Bear','Hawk','Lynx','Gecko','Crane','Bison','Quail'];
            const adj    = ['Happy','Swift','Cool','Brave','Sunny','Magic','Bold','Bright','Quick','Lucky'];
            const name   = adj[Math.floor(Math.random()*adj.length)] + animals[Math.floor(Math.random()*animals.length)];
            fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: name, isGuest: true })
            }).then(async r => {
                const text = await r.text();
                try {
                    return JSON.parse(text);
                } catch(e) {
                    throw new Error(`Invalid JSON response: ${text.substring(0, 100)} (Status: ${r.status})`);
                }
            }).then(data => {
                if (data.success) {
                    window.sessionUsername = data.username + "_01";
                    window.storagePath = data.storagePath;
                    document.getElementById('login-overlay').style.display = 'none';
                    initMQTT();
                    loadFiles('/');
                    showDiscussionSidebarOnLogin();
                    applyLoginMediaDefaults();
                } else {
                    alert('登录失败: ' + (data.error || '未知错误'));
                }
            }).catch(e => {
                console.error('Login error:', e);
                alert('网络错误: ' + e.message);
            });
        }

        function doLogout() {
            fetch('/api/logout', { method: 'GET' }).finally(() => {
                location.reload();
            });
        }

        // --- 发布主题逻辑（保留兼容） ---
        function submitTopic() {
            const topic = document.getElementById('input-topic').value;
            const speaker = document.getElementById('input-speaker').value;
            const dateInput = document.getElementById('input-date').value;
            const timeInput = document.getElementById('input-time').value;

            if (!topic) return alert('请输入主题');

            // 格式化日期和时间
            let formattedDateTime = '';
            if (dateInput && timeInput) {
                // 用户输入了日期和时间
                const date = new Date(dateInput + 'T' + timeInput);
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                const hours = String(date.getHours()).padStart(2, '0');
                const minutes = String(date.getMinutes()).padStart(2, '0');
                formattedDateTime = `${year}年${month}月${day}日 ${hours}:${minutes}`;
            } else if (dateInput) {
                // 只有日期
                const date = new Date(dateInput);
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                formattedDateTime = `${year}年${month}月${day}日`;
            } else if (timeInput) {
                // 只有时间
                const today = new Date();
                const year = today.getFullYear();
                const month = String(today.getMonth() + 1).padStart(2, '0');
                const day = String(today.getDate()).padStart(2, '0');
                formattedDateTime = `${year}年${month}月${day}日 ${timeInput}`;
            } else {
                // 都没有，使用当前日期
                const now = new Date();
                const year = now.getFullYear();
                const month = String(now.getMonth() + 1).padStart(2, '0');
                const day = String(now.getDate()).padStart(2, '0');
                formattedDateTime = `${year}年${month}月${day}日`;
            }

            // 获取 remote.html 的路径
            let remoteUrl = window.location.href.split('?')[0];
            if (remoteUrl.includes('index.html')) {
                remoteUrl = remoteUrl.replace('index.html', 'remote.html');
            } else if (remoteUrl.endsWith('/')) {
                remoteUrl += 'remote.html';
            } else {
                remoteUrl += '/remote.html';
            }
            remoteUrl += '?u=' + (window.sessionUsername || 'admin');

            const payload = {
                action: 'info',
                topic: topic,
                speaker: speaker,
                date: formattedDateTime,
                url: remoteUrl,
                timestamp: Date.now()
            };

            if (mqttClient && mqttClient.connected) {
                mqttClient.publish(CONFIG.MQTT.STATUS_TOPIC, JSON.stringify(payload), { qos: 0 }, (err) => {
                    if (!err) {
                        console.log('📢 主题已发布:', payload);
                        closeModal('topic');
                        alert('✅ 主题已发布到显示端');
                    } else {
                        alert('❌ 发布失败: ' + err.message);
                    }
                });
            } else {
                alert('MQTT 未连接，无法发布');
            }
        }

        // ==================== 涂鸦功能 ====================
        let isDrawing = false;
        let drawTool = null; // null 表示关闭，'pen' 或 'eraser' 表示开启
        let drawColor = '#ff0000'; // 默认红色
        let drawSize = 3;
        let drawCanvas, drawCtx;
        let lastX = 0, lastY = 0;
        let drawSnapshotTimer = null;
        let drawSnapshotSeq = 0;
        let drawMsgSeq = 0;
        let currentStrokeId = null;
        let pendingStrokePoints = [];
        const drawPageEvents = new Map();
        const MAX_DRAW_EVENTS_PER_PAGE = 4000;
        const drawStateByPage = new Map();
        let activeStrokeState = null;
        let drawStateDirtyPage = null;
        let drawStateSyncTimer = null;
        let drawStateVersion = 0;

        function initDrawCanvas() {
            drawCanvas = document.getElementById('draw-canvas');

            // 确定当前演示的目标元素
            let targetEl = document.getElementById('presentation-canvas');
            const imgEl = document.getElementById('presentation-image');
            const videoEl = document.getElementById('presentation-video'); // 视频也可以支持涂鸦

            if (imgEl && imgEl.style.display !== 'none') {
                targetEl = imgEl;
            } else if (videoEl && videoEl.style.display !== 'none') {
                targetEl = videoEl;
            }

            if (!targetEl) return;

            if (!targetEl) return;

            // Initialize canvas display
            drawCanvas.style.display = 'block';

            // Use the shared update function for positioning and sizing
            updateDrawCanvasPos();

            // Bind window resize event to keep alignment
            window.removeEventListener('resize', updateDrawCanvasPos);
            window.addEventListener('resize', updateDrawCanvasPos);

            drawCanvas.style.display = 'block';

            // Key fix: fully align with the target element, no longer using translate(-50%, -50%) for centering
            // Must set the container to relative or manually calculate offset
            const container = document.getElementById('presentation-canvas-container');
            // Ensure container is the positioning base
            if (getComputedStyle(container).position === 'static') {
                container.style.position = 'relative';
            }

            // Calculate target element's position relative to the container
            updateDrawCanvasPos();

            // Default enable drawing
            drawCanvas.style.pointerEvents = 'auto';

            drawCtx = drawCanvas.getContext('2d');
            drawCtx.lineCap = 'round';
            drawCtx.lineJoin = 'round';

            // 绑定鼠标事件
            drawCanvas.onmousedown = startDraw;
            drawCanvas.onmousemove = draw;
            drawCanvas.onmouseup = stopDraw;
            drawCanvas.onmouseout = stopDraw;

            // 绑定触摸事件（移动端）
            drawCanvas.ontouchstart = (e) => { e.preventDefault(); startDraw(e.touches[0]); };
            drawCanvas.ontouchmove = (e) => { e.preventDefault(); draw(e.touches[0]); };
            drawCanvas.ontouchend = stopDraw;
        }

        function updateDrawCanvasPos() {
            if (!drawCanvas) return;

            let targetEl = document.getElementById('presentation-canvas');
            const imgEl = document.getElementById('presentation-image');
            const videoEl = document.getElementById('presentation-video');

            if (imgEl && imgEl.style.display !== 'none') {
                targetEl = imgEl;
            } else if (videoEl && videoEl.style.display !== 'none') {
                targetEl = videoEl;
            }

            if (!targetEl) return;

            // 复制位置和尺寸（use rect-based positioning for better transform/flex accuracy）
            const container = document.getElementById('presentation-canvas-container');
            const targetRect = targetEl.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            const left = targetRect.left - containerRect.left;
            const top = targetRect.top - containerRect.top;
            drawCanvas.style.left = left + 'px';
            drawCanvas.style.top = top + 'px';
            drawCanvas.style.width = targetRect.width + 'px';
            drawCanvas.style.height = targetRect.height + 'px';

            // 更新画布分辨率（only when changed; setting width/height always clears canvas）
            const dpr = window.devicePixelRatio || 1;
            let nextW, nextH;
            if (targetEl.tagName === 'CANVAS') {
                nextW = targetEl.width;
                nextH = targetEl.height;
            } else {
                nextW = Math.max(1, Math.round(targetRect.width * dpr));
                nextH = Math.max(1, Math.round(targetRect.height * dpr));
            }

            if (drawCanvas.width !== nextW || drawCanvas.height !== nextH) {
                const backup = document.createElement('canvas');
                backup.width = drawCanvas.width || 1;
                backup.height = drawCanvas.height || 1;
                const bctx = backup.getContext('2d');
                bctx.drawImage(drawCanvas, 0, 0);

                drawCanvas.width = nextW;
                drawCanvas.height = nextH;

                const rctx = drawCanvas.getContext('2d');
                rctx.drawImage(backup, 0, 0, drawCanvas.width, drawCanvas.height);
            }

            // 重新获取上下文以确保缩放正确
            if (drawCtx) {
                drawCtx.lineCap = 'round';
                drawCtx.lineJoin = 'round';
            }
        }

        function startDraw(e) {
            updateDrawCanvasPos();
            isDrawing = true;
            const rect = drawCanvas.getBoundingClientRect();
            const scaleX = drawCanvas.width / rect.width;
            const scaleY = drawCanvas.height / rect.height;
            lastX = (e.clientX - rect.left) * scaleX;
            lastY = (e.clientY - rect.top) * scaleY;
            const p0 = { x: lastX / drawCanvas.width, y: lastY / drawCanvas.height };
            activeStrokeState = {
                tool: drawTool,
                color: drawColor,
                size: drawSize,
                points: [p0]
            };
            ensureDrawStateSyncTimer();
            currentStrokeId = 's_' + mySessionId + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
            pendingStrokePoints = [{ x: lastX / drawCanvas.width, y: lastY / drawCanvas.height }];
            sendDrawStreamMessage({
                action: 'draw_begin',
                page: currentPage,
                strokeId: currentStrokeId,
                tool: drawTool,
                color: drawColor,
                size: drawSize,
                points: pendingStrokePoints.slice()
            });
        }

        function draw(e) {
            if (!isDrawing) return;

            const rect = drawCanvas.getBoundingClientRect();
            const scaleX = drawCanvas.width / rect.width;
            const scaleY = drawCanvas.height / rect.height;
            const x = (e.clientX - rect.left) * scaleX;
            const y = (e.clientY - rect.top) * scaleY;

            drawCtx.beginPath();
            drawCtx.moveTo(lastX, lastY);
            drawCtx.lineTo(x, y);

            const effectiveLineWidth = drawSize * scaleX;

            if (drawTool === 'pen') {
                drawCtx.strokeStyle = drawColor;
                drawCtx.lineWidth = effectiveLineWidth;
                drawCtx.globalCompositeOperation = 'source-over';
            } else {
                drawCtx.globalCompositeOperation = 'destination-out';
                drawCtx.lineWidth = effectiveLineWidth * 10;
            }

            drawCtx.stroke();

            pendingStrokePoints.push({ x: x / drawCanvas.width, y: y / drawCanvas.height });
            if (activeStrokeState) {
                activeStrokeState.points.push({ x: x / drawCanvas.width, y: y / drawCanvas.height });
            }
            if (pendingStrokePoints.length >= 8) {
                flushStrokeChunk();
            }

            lastX = x;
            lastY = y;
        }

        function stopDraw() {
            if (isDrawing) {
                flushStrokeChunk(true);
                sendDrawStreamMessage({
                    action: 'draw_end',
                    page: currentPage,
                    strokeId: currentStrokeId
                });
                if (activeStrokeState && activeStrokeState.points.length >= 2) {
                    const list = drawStateByPage.get(currentPage) || [];
                    list.push(activeStrokeState);
                    if (list.length > 600) {
                        list.splice(0, list.length - 600);
                    }
                    drawStateByPage.set(currentPage, list);
                    drawStateDirtyPage = currentPage;
                }
            }
            isDrawing = false;
            currentStrokeId = null;
            pendingStrokePoints = [];
            activeStrokeState = null;
        }

        function toggleDrawTool(tool) {
            // 如果当前已经是画笔模式，则关闭涂鸦
            if (drawTool === tool) {
                closeDrawTool();
            } else {
                // 否则开启画笔模式
                setDrawTool(tool);
            }
        }


        function setDrawTool(tool) {
            drawTool = tool;
            // 启用涂鸦画布交互
            if (drawCanvas) {
                drawCanvas.style.pointerEvents = 'auto';
            }
            
            // 获取按钮
            const penBtn = document.getElementById('tool-pen');
            const eraserBtn = document.getElementById('tool-eraser');
            
            // 重置状态
            penBtn.classList.remove('active');
            eraserBtn.classList.remove('active');
            
            if (tool === 'pen') {
                penBtn.classList.add('active');
            } else if (tool === 'eraser') {
                eraserBtn.classList.add('active');
            }
        }

        function closeDrawTool() {
            // 关闭涂鸦功能
            drawTool = null;
            if (drawCanvas) {
                drawCanvas.style.pointerEvents = 'none';
            }
            // 重置所有按钮为未选中状态
            const penBtn = document.getElementById('tool-pen');
            const eraserBtn = document.getElementById('tool-eraser');
            if (penBtn) penBtn.classList.remove('active');
            if (eraserBtn) eraserBtn.classList.remove('active');
        }

        function updateDrawColor() {
            drawColor = document.getElementById('draw-color').value;
        }

        function updateDrawSize() {
            drawSize = parseInt(document.getElementById('draw-size').value);
        }

        function clearDrawing() {
            if (drawCtx) {
                drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
                drawPageEvents.set(currentPage, []);
                drawStateByPage.set(currentPage, []);
                drawStateDirtyPage = currentPage;
                sendDrawStreamMessage({ action: 'draw_clear', page: currentPage });
            }
        }

        function sendDrawData(data) {
            if (mqttClient && mqttClient.connected) {
                const payload = { ...data, drawId: 'd_' + mySessionId + '_' + (++drawSeq) };
                mqttClient.publish(CONFIG.MQTT.STATUS_TOPIC, JSON.stringify(payload), { qos: 1 });
            }
        }

        function appendPageEvent(page, evt) {
            const list = drawPageEvents.get(page) || [];
            list.push(evt);
            if (list.length > MAX_DRAW_EVENTS_PER_PAGE) {
                list.splice(0, list.length - MAX_DRAW_EVENTS_PER_PAGE);
            }
            drawPageEvents.set(page, list);
        }

        function sendDrawStreamMessage(base) {
            if (!mqttClient || !mqttClient.connected) return;
            const msg = { ...base, seq: ++drawMsgSeq, sessionId: mySessionId };
            appendPageEvent(base.page, msg);
            mqttClient.publish(CONFIG.MQTT.STATUS_TOPIC, JSON.stringify(msg), { qos: 1 });
        }

        function ensureDrawStateSyncTimer() {
            if (drawStateSyncTimer) return;
            drawStateSyncTimer = setInterval(() => {
                if (!mqttClient || !mqttClient.connected) return;
                if (drawStateDirtyPage == null) return;
                sendDrawStateSync(drawStateDirtyPage);
                drawStateDirtyPage = null;
            }, 1000);
        }

        function sendDrawStateSync(page) {
            const strokes = drawStateByPage.get(page) || [];
            mqttClient.publish(CONFIG.MQTT.STATUS_TOPIC, JSON.stringify({
                action: 'draw_state_sync',
                page,
                ver: ++drawStateVersion,
                strokes
            }), { qos: 1 });
        }

        function flushStrokeChunk(force = false) {
            if (!currentStrokeId || pendingStrokePoints.length <= 1) return;
            const pts = force ? pendingStrokePoints.slice() : pendingStrokePoints.slice(0, pendingStrokePoints.length - 1);
            if (pts.length <= 1) return;
            sendDrawStreamMessage({
                action: 'draw_chunk',
                page: currentPage,
                strokeId: currentStrokeId,
                tool: drawTool,
                color: drawColor,
                size: drawSize,
                points: pts
            });
            pendingStrokePoints = force ? [] : [pendingStrokePoints[pendingStrokePoints.length - 1]];
        }

        function scheduleDrawSnapshot(force) {}

        function sendDrawSnapshot() {}

        // 监听页面切换，清除涂鸦
        let previousPage = 1;
        setInterval(() => {
            if (currentPage !== previousPage) {
                if (drawCtx) {
                    drawCtx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
                }
                previousPage = currentPage;
            }
        }, 100);
    
