/**
 * Agora 独立音视频通话模块 - 轻量防遮挡版
 */
(function () {
    const AGORA_APP_ID = '02e3aa147d0242f2bad827ce38d2be84';
    const DEFAULT_CHANNEL = 'PPT_ROOM_666';

    let agoraClient = null;
    let localTracks = { video: null, audio: null, camera: null, screenAudio: null };
    let isCalling = false;
    let isMinimized = false;
    let isHiddenOnEdge = false;
    let isScreenSharing = false; // Add screen share tracking
    let remoteReconnectTimer = null;
    let remoteReconnectAttempts = 0;
    let isRemoteReconnecting = false;
    let isViewerMicAllowed = true;
    let isViewerVideoAllowed = true;
    let activeScreenSharerUid = null;
    let isPresenterWatchPaused = false;
    let screenRecoveryTimer = null;
    let isScreenRecoveryRunning = false;

    // 独立检测当前是否为观众端
    function isRemoteContext() {
        return window.location.pathname.includes('remote') || window.isRemoteApp;
    }

    // 用户设置
    let userSettings = {
        enableAudio: true,
        enableVideo: true
    };

    function initUI() {
        // 1. 注入样式
        const style = document.createElement('style');
        style.textContent = `
            #agora-video-grid.speaker-mode {
                display: grid !important;
                grid-template-columns: 1fr 140px !important;
                grid-template-rows: 1fr;
                gap: 5px;
                padding: 5px;
                height: 100%;
            }
            /* 只有一个子元素时，占满整个 grid */
            #agora-video-grid.speaker-mode > div:only-child {
                grid-column: 1 / -1;
                width: 100% !important;
                height: 100% !important;
            }
            #agora-video-grid.speaker-mode > div:first-child:not(:only-child) {
                grid-column: 1 / 2;
                grid-row: 1 / -1;
                width: 100% !important;
                height: 100% !important;
            }
            #agora-video-grid.speaker-mode > div:not(:first-child) {
                grid-column: 2 / 3;
                width: 100% !important;
                height: 100px !important;
            }
            .mute-icon {
                position: absolute;
                bottom: 5px;
                right: 5px;
                background: rgba(0,0,0,0.6);
                color: white;
                padding: 2px 5px;
                border-radius: 4px;
                font-size: 12px;
                z-index: 5;
            }
            
            /* 强制所有视频完整显示，不裁剪 - 覆盖 Agora SDK 默认的 cover */
            #agora-video-grid video,
            .video-item video,
            div[id^="player-"] video {
                object-fit: contain !important;
                background: #000 !important;
            }
            :fullscreen video, :-webkit-full-screen video, :-moz-full-screen video {
                object-fit: contain !important;
                background: black !important;
            }
            #agora-presenter-watch-toolbar button {
                transition: all 0.2s ease;
            }
            #agora-presenter-watch-toolbar button:hover {
                background: rgba(0,0,0,0.85) !important;
                transform: scale(1.05);
            }
        `;
        document.head.appendChild(style);

        // 2. 创建视频互动外壳
        let mainWrapper = document.getElementById('agora-wrapper');
        if (!mainWrapper) {
            const isRemote = window.location.pathname.includes('remote') || window.isRemoteApp;
            mainWrapper = document.createElement('div');
            mainWrapper.id = 'agora-wrapper';
            // 如果是远程显示端，居中并放大；如果是控制端，放在左下角
            mainWrapper.style.cssText = isRemote ? `
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                z-index: 2147483640;
                pointer-events: none;
                transition: all 0.5s cubic-bezier(0.19, 1, 0.22, 1);
            ` : `
                position: fixed;
                bottom: 90px;
                right: 20px;
                z-index: 2147483647;
                pointer-events: none;
                transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            `;
            document.body.appendChild(mainWrapper);
        }

        // 3. 核心容器 (Presenter 模式下不再显示 参会人员 弹窗)
        const isRemote = window.location.pathname.includes('remote') || window.isRemoteApp;
        mainWrapper.innerHTML = `
            <div id="agora-video-stage" style="display:none; ${isRemote ? 'pointer-events:none; width:100%; height:100%; background:#000;' : 'pointer-events:auto; width:360px; height:220px; background:rgba(15,20,25,0.45); backdrop-filter:blur(16px) saturate(180%); -webkit-backdrop-filter:blur(16px) saturate(180%); border:1px solid rgba(255,255,255,0.12); border-radius:14px; overflow:hidden;' }">
                ${isRemote ? '' : `
                <div id="agora-presenter-watch-toolbar" style="position:absolute; top:8px; right:8px; z-index:30; display:flex; gap:8px;">
                    <button id="agora-watch-pause-btn" title="暂停观看" style="width:34px; height:30px; border:none; border-radius:8px; background:rgba(0,0,0,0.55); color:#fff; cursor:pointer; font-size:15px;">⏸</button>
                    <button id="agora-watch-fullscreen-btn" title="全屏观看" style="width:34px; height:30px; border:none; border-radius:8px; background:rgba(0,0,0,0.55); color:#fff; cursor:pointer; font-size:15px;">⛶</button>
                </div>
                <div id="agora-watch-paused-overlay" style="display:none; position:absolute; inset:0; z-index:20; background:rgba(0,0,0,0.55); color:#fff; align-items:center; justify-content:center; font-size:20px; font-weight:600;">已暂停观看</div>
                `}
                <div id="agora-video-grid" style="${isRemote ? 'width:100%; height:100%;' : ''}"></div>
            </div>
        `;

        if (!isRemote) {
            const pauseBtn = document.getElementById('agora-watch-pause-btn');
            if (pauseBtn) {
                pauseBtn.style.width = '42px'; // 稍微加宽一点以适应图标
                pauseBtn.style.fontSize = '16px';
                pauseBtn.innerHTML = '⏸';
                pauseBtn.title = '暂停观看';
                pauseBtn.onclick = () => setPresenterWatchPaused(!isPresenterWatchPaused);
            }
            const fullscreenBtn = document.getElementById('agora-watch-fullscreen-btn');
            if (fullscreenBtn) {
                fullscreenBtn.style.width = '42px';
                fullscreenBtn.style.fontSize = '16px';
                fullscreenBtn.onclick = () => {
                    const stage = document.getElementById('agora-video-stage');
                    if (!stage) return;
                    if (!document.fullscreenElement) {
                        stage.requestFullscreen().catch(() => { });
                    } else {
                        document.exitFullscreen().catch(() => { });
                    }
                };
            }
        }

        // 4. 本地预览小窗 (改为悬浮)
        let localBox = document.getElementById('agora-local-box');
        if (!localBox) {
            localBox = document.createElement('div');
            localBox.id = 'agora-local-box';
            localBox.style.cssText = 'position:fixed; bottom:75px; right:20px; width:80px; height:60px; background:#000; border-radius:6px; overflow:hidden; z-index:2147483647; border:1px solid rgba(255,255,255,0.3); display:none; transform:scaleX(-1); opacity:0.8;';
            document.body.appendChild(localBox);
        }

        // 5. 控制按钮
        const isRemotePage = window.location.pathname.includes('remote') || window.isRemoteApp;
        let ctrlPanel = document.getElementById('agora-global-ctrl');
        if (!ctrlPanel) {
            ctrlPanel = document.createElement('div');
            ctrlPanel.id = 'agora-global-ctrl';
            // Presenter: column layout bottom-right. Viewer: row layout bottom-right for mic only
            ctrlPanel.style.cssText = isRemotePage
                ? 'position:fixed; bottom:30px; right:30px; z-index:2147483647; display:flex; gap:10px; flex-direction: row; align-items: center;'
                : 'position:fixed; bottom:30px; right:30px; z-index:2147483647; display:flex; gap:15px; flex-direction: column; align-items: flex-end;';
            document.body.appendChild(ctrlPanel);
        }

        if (isRemotePage) {
            // Toggle Collapse Button
            const toggleBtn = document.createElement('button');
            toggleBtn.innerHTML = '&gt;';
            toggleBtn.title = '隐藏工具栏';
            toggleBtn.style.cssText = 'width:28px; height:42px; border-radius:8px; border:none; background:rgba(255,255,255,0.15); color:#fff; cursor:pointer; font-size:16px; font-weight:bold; display:flex; align-items:center; justify-content:center; backdrop-filter:blur(10px); transition:all 0.3s; opacity:0.8; padding:0;';
            toggleBtn.onmouseover = () => { toggleBtn.style.opacity = '1'; };
            toggleBtn.onmouseout = () => { toggleBtn.style.opacity = '0.8'; };

            const btnGroup = document.createElement('div');
            btnGroup.id = 'agora-btn-group';
            btnGroup.style.cssText = 'display:flex; gap:10px; overflow:hidden; transition: max-width 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s; max-width: 200px; opacity: 1; align-items:center;';

            let isCollapsed = false;

            // 暴露到全局，让外部视频播放时可以自动调用折叠
            window.agoraCollapseCtrlPanel = (forceCollapse = true) => {
                isCollapsed = forceCollapse;
                if (isCollapsed) {
                    toggleBtn.innerHTML = '《'; // 用户要求的隐藏状态指示符
                    toggleBtn.title = '展开工具栏';
                    btnGroup.style.maxWidth = '0px';
                    btnGroup.style.opacity = '0';
                    btnGroup.style.pointerEvents = 'none';
                } else {
                    toggleBtn.innerHTML = '》';
                    toggleBtn.title = '隐藏工具栏';
                    btnGroup.style.maxWidth = '200px';
                    btnGroup.style.opacity = '1';
                    btnGroup.style.pointerEvents = 'auto';
                }
            };

            toggleBtn.onclick = () => window.agoraCollapseCtrlPanel(!isCollapsed);

            // AUDIENCE SIDE: 屏幕共享按钮
            const shareDot = document.createElement('button');
            shareDot.id = 'agora-share-dot';
            shareDot.innerHTML = '💻';
            shareDot.title = '共享屏幕';
            shareDot.style.cssText = 'width:42px; height:42px; border-radius:8px; border:none; background:rgba(255,255,255,0.15); color:#fff; cursor:pointer; font-size:18px; display:flex; align-items:center; justify-content:center; backdrop-filter:blur(10px); transition:all 0.3s; opacity:0.8; flex-shrink:0;';
            shareDot.onmouseover = () => { shareDot.style.opacity = '1'; shareDot.style.transform = 'translateY(-3px)'; };
            shareDot.onmouseout = () => { shareDot.style.opacity = '0.8'; shareDot.style.transform = 'translateY(0)'; };
            shareDot.onclick = () => { window.agoraModule && window.agoraModule.startScreenShare(); };

            // Mic button
            const micBtn = document.createElement('button');
            micBtn.id = 'agora-mic-btn';
            micBtn.innerHTML = '🎤';
            micBtn.title = '开启/关闭麦克风';
            micBtn.style.cssText = 'width:42px; height:42px; border-radius:8px; border:none; background:rgba(255,255,255,0.15); color:#fff; cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,0.15); font-size:18px; display:flex; align-items:center; justify-content:center; backdrop-filter: blur(10px); transition:all 0.3s; opacity:0.8; flex-shrink:0;';
            micBtn.onmouseover = () => { micBtn.style.opacity = '1'; micBtn.style.transform = 'translateY(-3px)'; };
            micBtn.onmouseout = () => { micBtn.style.opacity = '0.8'; micBtn.style.transform = 'translateY(0)'; };
            micBtn.onclick = () => { window.agoraModule && window.agoraModule.toggleMic() };
            
            const camBtn = document.createElement('button');
            camBtn.id = 'agora-cam-btn';
            camBtn.innerHTML = '📷';
            camBtn.title = '开启/关闭摄像头';
            camBtn.style.cssText = 'width:42px; height:42px; border-radius:8px; border:none; background:rgba(255,255,255,0.15); color:#fff; cursor:pointer; font-size:18px; display:flex; align-items:center; justify-content:center; backdrop-filter:blur(10px); transition:all 0.3s; opacity:0.8; flex-shrink:0;';
            camBtn.onmouseover = () => { camBtn.style.opacity = '1'; camBtn.style.transform = 'translateY(-3px)'; };
            camBtn.onmouseout = () => { camBtn.style.opacity = '0.8'; camBtn.style.transform = 'translateY(0)'; };
            camBtn.onclick = () => { window.agoraModule && window.agoraModule.toggleVideo(); };

            // Discussion group button
            const chatBtn = document.createElement('button');
            chatBtn.id = 'agora-chat-btn';
            chatBtn.innerHTML = '💬';
            chatBtn.title = '讨论群';
            chatBtn.style.cssText = 'width:42px; height:42px; border-radius:8px; border:none; background:rgba(255,255,255,0.15); color:#fff; cursor:pointer; font-size:18px; display:flex; align-items:center; justify-content:center; backdrop-filter:blur(10px); transition:all 0.3s; opacity:0.8; flex-shrink:0;';
            chatBtn.onmouseover = () => { chatBtn.style.opacity = '1'; chatBtn.style.transform = 'translateY(-3px)'; };
            chatBtn.onmouseout = () => { chatBtn.style.opacity = '0.8'; chatBtn.style.transform = 'translateY(0)'; };
            chatBtn.onclick = () => { 
                const toggleFunc = window.toggleDiscussion || (typeof toggleDiscussion === 'function' ? toggleDiscussion : null);
                if (toggleFunc) {
                    toggleFunc();
                    // 额外保险：点击时确保侧边栏层级最高
                    const sidebar = document.getElementById('discussion-sidebar');
                    if (sidebar) sidebar.style.zIndex = '2147483647';
                }
            };

            // Append buttons
            btnGroup.appendChild(shareDot);
            btnGroup.appendChild(chatBtn);
            btnGroup.appendChild(micBtn);
            btnGroup.appendChild(camBtn);

            // 先加图标组，再加切换按钮（使按钮处于右侧）
            ctrlPanel.appendChild(btnGroup);
            ctrlPanel.appendChild(toggleBtn);

            // Default collapsed on remote side.
            window.agoraCollapseCtrlPanel(true);

            // 暴露调整位置的公共 API，供视频播放时避开播放器控制栏
            window.agoraSetCtrlPanelBottom = (bottomPx) => {
                ctrlPanel.style.bottom = bottomPx + 'px';
            };
            // 默认底部起始值（改为 30px）
            window._agoraCtrlBaseBottom = 30;

            // Initial state: disabled until presenter comes online
            updateShareBtnState(false, '正在等待演示者上线...');
        } else {
            // PRESENTER SIDE: Move to #pres-toolbar
            const presToolbar = document.getElementById('pres-toolbar');
            const anchor = document.getElementById('agora-anchor') || document.getElementById('btn-pres-settings');

            if (presToolbar && anchor) {
                const micBtn = document.createElement('button');
                micBtn.id = 'agora-mic-btn';
                micBtn.className = 'toolbar-btn';
                micBtn.innerHTML = '🎤';
                micBtn.title = '开启/关闭麦克风';
                micBtn.style.cssText = 'color:#fff; padding:0;';
                micBtn.onclick = () => { window.agoraModule && window.agoraModule.toggleMic() };

                const shareBtn = document.createElement('button');
                shareBtn.id = 'agora-share-btn';
                shareBtn.className = 'toolbar-btn';
                shareBtn.innerHTML = '💻';
                shareBtn.title = '共享屏幕';
                shareBtn.style.cssText = 'color:#fff; padding:0;';
                shareBtn.onclick = () => { window.agoraModule && window.agoraModule.startScreenShare() };

                const camBtn = document.createElement('button');
                camBtn.id = 'agora-cam-btn';
                camBtn.className = 'toolbar-btn';
                camBtn.innerHTML = '📷';
                camBtn.title = '开启/关闭摄像头';
                camBtn.style.cssText = 'color:#fff; padding:0;';
                camBtn.onclick = () => { window.agoraModule && window.agoraModule.toggleVideo() };

                presToolbar.insertBefore(micBtn, anchor);
                presToolbar.insertBefore(camBtn, anchor);
                presToolbar.insertBefore(shareBtn, anchor);
                
                // 如果使用了锚点，则在其插入完成后移除它
                if (anchor.id === 'agora-anchor') anchor.remove();

                if (ctrlPanel) ctrlPanel.style.display = 'none';
            } else {
                // Fallback (if pres-toolbar is not present)
                const shareBtn = document.createElement('button');
                shareBtn.id = 'agora-share-btn';
                shareBtn.innerHTML = '💻 共享屏幕';
                shareBtn.style.cssText = 'padding:0 15px; height:42px; border-radius:8px; border:none; background:rgba(255,255,255,0.9); color:#606266; cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,0.2); font-weight:bold; font-size:13px; display:flex; align-items:center; gap:8px; backdrop-filter: blur(10px); transition:all 0.3s;';
                shareBtn.onmouseover = () => { if (!shareBtn.disabled) shareBtn.style.transform = 'translateY(-3px)'; };
                shareBtn.onmouseout = () => { if (!shareBtn.disabled) shareBtn.style.transform = 'translateY(0)'; };
                shareBtn.onclick = () => { window.agoraModule && window.agoraModule.startScreenShare() };
                ctrlPanel.appendChild(shareBtn);

                const micBtn = document.createElement('button');
                micBtn.id = 'agora-mic-btn';
                micBtn.innerHTML = '🎤';
                micBtn.title = '开启/关闭麦克风';
                micBtn.style.cssText = 'width:42px; height:42px; border-radius:8px; border:none; background:rgba(255,255,255,0.9); color:#606266; cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,0.2); font-size:20px; display:flex; align-items:center; justify-content:center; backdrop-filter: blur(10px); transition:all 0.3s;';
                micBtn.onmouseover = () => { micBtn.style.transform = 'translateY(-3px)'; };
                micBtn.onmouseout = () => { micBtn.style.transform = 'translateY(0)'; };
                micBtn.onclick = () => { window.agoraModule && window.agoraModule.toggleMic() };
                ctrlPanel.appendChild(micBtn);

                const camBtn = document.createElement('button');
                camBtn.id = 'agora-cam-btn';
                camBtn.innerHTML = '📷';
                camBtn.title = '开启/关闭摄像头';
                camBtn.style.cssText = 'width:42px; height:42px; border-radius:8px; border:none; background:rgba(255,255,255,0.9); color:#606266; cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,0.2); font-size:20px; display:flex; align-items:center; justify-content:center; backdrop-filter: blur(10px); transition:all 0.3s;';
                camBtn.onmouseover = () => { camBtn.style.transform = 'translateY(-3px)'; };
                camBtn.onmouseout = () => { camBtn.style.transform = 'translateY(0)'; };
                camBtn.onclick = () => { window.agoraModule && window.agoraModule.toggleVideo() };
                ctrlPanel.appendChild(camBtn);
            }
        }
        //

        // 如果工具栏中存在旧的按钮，则清理掉
        const oldToggleBtn = document.getElementById('agora-toggle-btn');
        if (oldToggleBtn) oldToggleBtn.remove();


        // 7. 初始化拖动和缩放功能
        initDragAndEdgeHide();
        initResize();

        // 8. 监听全屏变化，自动迁移视频窗口
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
        document.addEventListener('mozfullscreenchange', handleFullscreenChange);
        window.addEventListener('resize', () => {
            const stage = document.getElementById('agora-video-stage');
            if (stage && stage.style.display !== 'none') positionPresenterFloatingWindow();
        });

        function handleFullscreenChange() {
            const wrapper = document.getElementById('agora-wrapper');
            const localBox = document.getElementById('agora-local-box');
            const ctrl = document.getElementById('agora-global-ctrl');
            const discussionSidebar = document.getElementById('discussion-sidebar');
            const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement;

            if (fsEl) {
                // 进入全屏：将视频浮窗和控制面板一起移入全屏元素，否则会被遮挡/消失
                if (wrapper) fsEl.appendChild(wrapper);
                if (localBox) fsEl.appendChild(localBox);
                if (discussionSidebar) {
                    fsEl.appendChild(discussionSidebar);
                    discussionSidebar.style.zIndex = '2147483647';
                }
                if (ctrl) fsEl.appendChild(ctrl); // ★ 控制面板必须跟着移入
            } else {
                // 退出全屏：归位到 body
                // 注意顺序：ctrl 必须在 wrapper 之后 append，这样 DOM 顺序靠后，
                // 相同 z-index 下 ctrl 层级更高，不会被 wrapper 压住
                if (wrapper) document.body.appendChild(wrapper);
                if (localBox) document.body.appendChild(localBox);
                if (discussionSidebar) {
                    document.body.appendChild(discussionSidebar);
                    discussionSidebar.style.zIndex = '2147483647';
                }
                if (ctrl) document.body.appendChild(ctrl); // ★ 最后 append，确保层级最高
            }
        }

        // 全员全自动入场处理
        if (window.location.pathname.includes('remote')) {
            const btn = document.getElementById('agora-toggle-btn');
            if (btn) btn.style.display = 'none';
            // 延迟一点以确保主题样式加载完成
            setTimeout(initRemoteAgora, 500);
        }
    }

    // 设置对话框不再需要，已移除

    // 初始化缩放功能
    function initResize() {
        const resizeHandle = document.getElementById('agora-resize-handle');
        const stage = document.getElementById('agora-video-stage');

        if (!resizeHandle || !stage) return;

        let isResizing = false;
        let startWidth, startHeight, startX, startY;

        resizeHandle.addEventListener('mousedown', (e) => {
            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            startWidth = stage.offsetWidth;
            startHeight = stage.offsetHeight;

            e.stopPropagation(); // 防止冒泡触发拖动
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;

            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            const newWidth = startWidth + dx;
            const newHeight = startHeight + dy;

            // 设置最小限制
            if (newWidth >= 200) stage.style.width = newWidth + 'px';
            if (newHeight >= 150) stage.style.height = newHeight + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
            }
        });
    }

    function initDragAndEdgeHide() {
        const wrapper = document.getElementById('agora-wrapper');
        const dragHandle = document.getElementById('agora-drag-handle');
        // 远程端使用居中布局，禁用拖拽和边缘隐藏以防破坏 transform
        const isRemote = window.location.pathname.includes('remote');

        if (!wrapper || !dragHandle || isRemote) return;

        let isDragging = false;
        let startX, startY, startLeft, startTop;

        dragHandle.addEventListener('mousedown', (e) => {
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;

            const rect = wrapper.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;

            wrapper.style.transition = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;

            let newLeft = startLeft + deltaX;
            let newTop = startTop + deltaY;

            // 限制在屏幕内
            newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - wrapper.offsetWidth));
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - wrapper.offsetHeight));

            wrapper.style.left = newLeft + 'px';
            wrapper.style.top = newTop + 'px';
            wrapper.style.bottom = 'auto';
            wrapper.style.right = 'auto';
            wrapper.style.transform = 'translate(0,0)';
        });

        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            wrapper.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';

            checkEdgeProximity();
        });

        wrapper.addEventListener('mouseenter', () => {
            if (isHiddenOnEdge) {
                showFromEdge();
            }
        });

        wrapper.addEventListener('mouseleave', () => {
            if (!isDragging) {
                checkEdgeProximity();
            }
        });
    }

    function checkEdgeProximity() {
        const wrapper = document.getElementById('agora-wrapper');
        const rect = wrapper.getBoundingClientRect();
        const threshold = 20; // 靠近边缘的阈值

        // 检查是否靠近左边缘
        if (rect.left < threshold) {
            hideToEdge('left');
        }
        // 检查是否靠近右边缘
        else if (window.innerWidth - rect.right < threshold) {
            hideToEdge('right');
        }
        else {
            isHiddenOnEdge = false;
            wrapper.style.transform = 'translate(0,0)';
        }
    }

    function hideToEdge(edge) {
        const wrapper = document.getElementById('agora-wrapper');
        isHiddenOnEdge = true;

        if (edge === 'left') {
            wrapper.style.transform = 'translateX(calc(-100% + 40px))';
        } else if (edge === 'right') {
            wrapper.style.transform = 'translateX(calc(100% - 40px))';
        }
    }

    function showFromEdge() {
        const wrapper = document.getElementById('agora-wrapper');
        wrapper.style.transform = 'translate(0, 0)';
        isHiddenOnEdge = false;
    }

    function positionPresenterFloatingWindow() {
        const wrapper = document.getElementById('agora-wrapper');
        if (!wrapper || window.location.pathname.includes('remote') || isPresenterWatchPaused) return;
        const leftPanel = document.querySelector('.left-panel');
        const panelRect = leftPanel ? leftPanel.getBoundingClientRect() : null;
        const left = panelRect ? Math.round(panelRect.right + 20) : 20;
        const targetW = 1152; // 4x size
        const maxW = Math.max(520, window.innerWidth - left - 20);
        const width = Math.min(targetW, maxW);
        const height = Math.round(width * 9 / 16);
        const maxTop = Math.max(20, window.innerHeight - height - 20);
        const top = Math.max(20, Math.min(Math.round((window.innerHeight - height) / 2), maxTop));
        wrapper.style.width = width + 'px';
        wrapper.style.height = height + 'px';
        wrapper.style.left = left + 'px';
        wrapper.style.top = top + 'px';
        wrapper.style.right = 'auto';
        wrapper.style.bottom = 'auto';

        const stage = document.getElementById('agora-video-stage');
        if (stage) {
            stage.style.width = width + 'px';
            stage.style.height = height + 'px';
        }
    }

    function mountPresenterStageToPreview() {
        if (window.location.pathname.includes('remote')) return;
        const wrapper = document.getElementById('agora-wrapper');
        const stage = document.getElementById('agora-video-stage');
        const grid = document.getElementById('agora-video-grid');
        const localBox = document.getElementById('agora-local-box');
        if (!wrapper || !stage || !grid) return;

        document.body.appendChild(wrapper);
        wrapper.style.position = 'fixed';
        wrapper.style.transform = 'translate(0,0)';
        wrapper.style.zIndex = '2147483646';
        wrapper.style.pointerEvents = 'none'; // 关键修复：外层容器不阻挡点击
        positionPresenterFloatingWindow();

        stage.style.display = 'flex';
        stage.style.borderRadius = '14px';
        stage.style.border = '1px solid rgba(255,255,255,0.12)';
        stage.style.background = '#000';
        stage.style.pointerEvents = 'auto';
        grid.style.width = '100%';
        grid.style.height = '100%';
        setPresenterWatchPaused(false);

        if (localBox) localBox.style.display = 'none';
    }

    function unmountPresenterStageFromPreview() {
        if (window.location.pathname.includes('remote')) return;
        const wrapper = document.getElementById('agora-wrapper');
        const stage = document.getElementById('agora-video-stage');
        if (!wrapper || !stage) return;

        // 还原回右下角小窗挂载状态
        wrapper.style.position = 'fixed';
        wrapper.style.top = 'auto';
        wrapper.style.left = 'auto';
        wrapper.style.right = '20px';
        wrapper.style.bottom = '90px';
        wrapper.style.width = 'auto';
        wrapper.style.height = 'auto';
        wrapper.style.transform = 'translate(0,0)';
        wrapper.style.zIndex = '2147483647';
        // 关键修复：外层容器永不阻挡点击
        wrapper.style.pointerEvents = 'none'; 

        // 如果屏幕分享仍在进行中（只是暂停观看），保留舞台显示以便用户点击“恢复”
        if (activeScreenSharerUid) {
            stage.style.display = 'flex';
            stage.style.width = '360px'; // 强制收缩
            stage.style.height = '220px';
        } else {
            stage.style.display = 'none';
            isPresenterWatchPaused = false;
        }

        stage.style.width = '360px'; 
        stage.style.height = '220px';
        stage.style.borderRadius = '14px';
        stage.style.border = '1px solid rgba(255,255,255,0.12)';
        stage.style.pointerEvents = 'auto'; // 仅舞台内部可点击
        
        // 如果有本地摄像头在运行，恢复其显示
        const localBox = document.getElementById('agora-local-box');
        if (localBox && localTracks.camera && localTracks.camera.enabled) {
            localBox.style.display = 'block';
        }
    }

    function setPresenterWatchPaused(paused) {
        if (isPresenterWatchPaused === !!paused) return; // 避免循环调用
        isPresenterWatchPaused = !!paused;
        
        if (window.location.pathname.includes('remote')) return;
        const grid = document.getElementById('agora-video-grid');
        const overlay = document.getElementById('agora-watch-paused-overlay');
        const pauseBtn = document.getElementById('agora-watch-pause-btn');
        
        if (grid) grid.style.visibility = isPresenterWatchPaused ? 'hidden' : 'visible';
        if (overlay) overlay.style.display = isPresenterWatchPaused ? 'flex' : 'none';
        if (pauseBtn) {
            pauseBtn.innerHTML = isPresenterWatchPaused ? '▶' : '⏸';
            pauseBtn.title = isPresenterWatchPaused ? '恢复观看' : '暂停观看';
        }

        // 联动布局：暂停时缩小到角落，恢复时放大到中央
        if (isPresenterWatchPaused) {
            unmountPresenterStageFromPreview();
        } else if (activeScreenSharerUid) {
            mountPresenterStageToPreview();
        }

        if (!isPresenterWatchPaused && activeScreenSharerUid && agoraClient) {
            const uid = String(activeScreenSharerUid);
            const player = document.getElementById(`player-${uid}`);
            const remoteUser = (agoraClient.remoteUsers || []).find(u => String(u.uid) === uid);
            if (player && remoteUser && remoteUser.videoTrack) {
                try { remoteUser.videoTrack.play(player.id); } catch (e) { }
            }
        }
    }

    function startScreenRecoveryWatch() {
        if (screenRecoveryTimer) return;
        screenRecoveryTimer = setInterval(async () => {
            if (isScreenRecoveryRunning) return;
            if (!activeScreenSharerUid || !agoraClient || !isCalling) return;
            isScreenRecoveryRunning = true;
            try {
                const targetUid = String(activeScreenSharerUid);
                const grid = document.getElementById('agora-video-grid');
                let player = document.getElementById(`player-${targetUid}`);
                if (!player && grid && grid.firstElementChild) player = grid.firstElementChild;
                if (!player) {
                    if (window.agoraModule && typeof window.agoraModule.ensureViewerJoined === 'function') {
                        await window.agoraModule.ensureViewerJoined();
                    }
                    return;
                }

                const video = player.querySelector('video');
                const noFrame = !video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0;
                if (!noFrame) {
                    remoteReconnectAttempts = 0;
                    return;
                }

                remoteReconnectAttempts += 1;
                if (remoteReconnectAttempts < 3) return;
                remoteReconnectAttempts = 0;

                const remoteUser = (agoraClient.remoteUsers || []).find(u => String(u.uid) === targetUid);
                if (!remoteUser) return;
                try { await agoraClient.unsubscribe(remoteUser, 'video'); } catch (e) { }
                await agoraClient.subscribe(remoteUser, 'video');
                if (remoteUser.videoTrack) remoteUser.videoTrack.play(player.id);
            } catch (e) {
                console.warn('[Agora] screen recovery failed:', e);
            } finally {
                isScreenRecoveryRunning = false;
            }
        }, 1800);
    }

    // joinChannel and toggleAgoraCall removed since we use toggleMic now

    function myUid() {
        return Math.floor(Math.random() * 1000000);
    }

    // 活跃发言者处理逻辑
    function handleAudioVolumeIndication(volumes) {
        if (!volumes || volumes.length === 0) return;

        // 向主页面同步所有正在发言的 UID
        const currentSpeakers = volumes.filter(v => v.level > 10).map(v => v.uid);
        if (typeof window.onAgoraSpeakersChanged === 'function') {
            window.onAgoraSpeakersChanged(currentSpeakers);
        }

        // 找出音量最大的远程用户 (uid !== 0 为远程用户, level > 5 为阈值)
        const speakers = volumes.filter(v => v.uid !== 0 && v.level > 5).sort((a, b) => b.level - a.level);

        if (speakers.length > 0) {
            const activeUid = speakers[0].uid;
            const grid = document.getElementById('agora-video-grid');
            const player = document.getElementById(`player-${activeUid}`);

            if (player) {
                // 1. 视觉高亮 (绿框呼吸效果)
                player.style.boxShadow = '0 0 0 3px #67c23a';
                player.style.transition = 'all 0.3s ease';
                player.style.zIndex = '100'; // 确保边框显示在上层

                // 2. 自动排到最前面 (如果当前不在第一个)
                if (grid.firstElementChild !== player) {
                    grid.insertBefore(player, grid.firstElementChild);
                }

                // 2.5秒后取消高亮
                if (player.highlightTimeout) clearTimeout(player.highlightTimeout);
                player.highlightTimeout = setTimeout(() => {
                    player.style.boxShadow = 'none';
                    player.style.zIndex = 'auto';
                }, 2500);
            }
        }
    }

    async function initRemoteAgora() {
        try {
            if (isRemoteReconnecting) return;
            isRemoteReconnecting = true;

            if (agoraClient) {
                try { agoraClient.removeAllListeners(); } catch (e) { }
                try { await agoraClient.leave(); } catch (e) { }
            }

            agoraClient = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
            agoraClient.on("user-published", handleUserPublished);
            agoraClient.on("user-unpublished", handleUserUnpublished);
            agoraClient.on("connection-state-change", handleRemoteConnectionStateChange);

            // 启用音量检测 (如支持)
            if (typeof agoraClient.enableAudioVolumeIndication === 'function') {
                agoraClient.enableAudioVolumeIndication(2000, 3);
                agoraClient.on("volume-indicator", handleAudioVolumeIndication);
            }

            await agoraClient.join(AGORA_APP_ID, DEFAULT_CHANNEL, null, myUid());
            // Mark joined state so later actions reuse this client instead of creating a new one.
            isCalling = true;
            isRemoteReconnecting = false;
            remoteReconnectAttempts = 0;
            if (remoteReconnectTimer) {
                clearTimeout(remoteReconnectTimer);
                remoteReconnectTimer = null;
            }
        } catch (e) {
            console.error("Remote join failed:", e);
            isRemoteReconnecting = false;
            scheduleRemoteReconnect();
        }
    }

    function handleRemoteConnectionStateChange(curState, prevState, reason) {
        if (!isRemoteContext()) return;

        if (curState === 'CONNECTED') {
            remoteReconnectAttempts = 0;
            if (remoteReconnectTimer) {
                clearTimeout(remoteReconnectTimer);
                remoteReconnectTimer = null;
            }
            return;
        }

        const shouldReconnect = curState === 'DISCONNECTED' || curState === 'RECONNECTING' || curState === 'FAILED';
        if (shouldReconnect) {
            console.warn('[Agora][Remote] connection state:', prevState, '->', curState, 'reason:', reason);
            scheduleRemoteReconnect();
        }
    }

    function scheduleRemoteReconnect() {
        if (!isRemoteContext()) return;
        if (remoteReconnectTimer || isRemoteReconnecting) return;

        const delay = Math.min(3000 * Math.pow(2, remoteReconnectAttempts), 30000);
        remoteReconnectTimer = setTimeout(() => {
            remoteReconnectTimer = null;
            remoteReconnectAttempts += 1;
            initRemoteAgora();
        }, delay);
    }

    async function handleUserPublished(user, mediaType) {
        await agoraClient.subscribe(user, mediaType);

        if (mediaType === "audio") {
            user.audioTrack.play();
            // 音频发布时不显示视频窗
            return;
        }

        if (mediaType === "video") {
            // 收到视频流（包括摄像头和屏幕分享）时才显示舞台
            const stage = document.getElementById('agora-video-stage');
            if (stage) stage.style.display = 'flex';

            const grid = document.getElementById('agora-video-grid');
            let player = document.getElementById(`player-${user.uid}`);
            if (!player) {
                player = document.createElement('div');
                player.id = `player-${user.uid}`;
                player.className = 'video-item';
                // 让 player 撑满整个 grid，确保视频完整可见
                player.style.cssText = 'width:100%; height:100%; background:#000; border-radius:8px; overflow:hidden; position:relative; min-height:200px; box-shadow:0 2px 8px rgba(0,0,0,0.2);';
                grid.appendChild(player);
            }
            user.videoTrack.play(player.id);

            // === 优先级策略：屏幕共享强制置顶并开启“影院模式” ===
            const label = (user.videoTrack && typeof user.videoTrack.getTrackLabel === 'function')
                ? (user.videoTrack.getTrackLabel() || '').toLowerCase()
                : '';
            const isScreen = label.includes('screen')
                || label.includes('window')
                || user.uid > 1000000
                || (activeScreenSharerUid !== null && String(user.uid) === String(activeScreenSharerUid));
            if (isScreen) {
                activeScreenSharerUid = user.uid;
                if (grid.firstChild !== player) grid.insertBefore(player, grid.firstChild);
                if (!(window.location.pathname.includes('remote') || window.isRemoteApp)) {
                    mountPresenterStageToPreview();
                }
                startScreenRecoveryWatch();

                // 开启影院模式：铺满全屏，移除所有遮挡
                if (stage) {
                    stage.style.display = 'flex';
                    if (window.location.pathname.includes('remote') || window.isRemoteApp) {
                        stage.style.position = 'fixed';
                        stage.style.top = '0';
                        stage.style.left = '0';
                        stage.style.width = '100vw';
                        stage.style.height = '100vh';
                        stage.style.zIndex = '2147483640';  // 比控制面板低8级
                        stage.style.borderRadius = '0';
                        stage.style.border = 'none';
                        stage.style.background = '#000';

                        // 隐藏拖拽柄和顶部标题
                        const handler = stage.querySelector('#agora-drag-handle');
                        if (handler) handler.style.display = 'none';

                        // ★ 确保控制面板和侧边栏始终浮在视频流之上
                        const sidebar = document.getElementById('discussion-sidebar');
                        if (sidebar) sidebar.style.zIndex = '2147483647';
                        const ctrl = document.getElementById('agora-global-ctrl');
                        if (ctrl) ctrl.style.zIndex = '2147483647';
                        // 隐藏占位提示，防止右侧空白
                        const ph = document.getElementById('placeholder');
                        if (ph) ph.style.display = 'none';
                    }
                }

                // === 互斥逻辑：隐藏任何正在显示的PPT面板 ===
                try {
                    if (typeof window.exitPresentation === 'function') {
                        // 修复：主讲人端（index.html）绝不退出演示，以保留控制面板和PPT内容
                        console.log('主控端不调用 exitPresentation，保留控制面板');
                    } else if (typeof window.closePresentation === 'function') {
                        window.closePresentation();

                        // 强制隐藏 remote.html 下的各个容器
                        ['pdfCanvas', 'imageDisplay', 'videoDisplay', 'officeIframe'].forEach(id => {
                            const el = document.getElementById(id);
                            if (el) el.style.display = 'none';
                        });
                        // 移除占位提示，避免遮挡共享画面
                        const ph = document.getElementById('placeholder');
                        if (ph) {
                            ph.style.display = 'none';
                        }
                    }
                } catch (e) { console.error('Hide PPT on screen share error:', e); }
            }
            else if (!(window.location.pathname.includes('remote') || window.isRemoteApp)) {
                const presMode = document.getElementById('presentation-mode');
                const inPresentation = !!(presMode && presMode.classList.contains('active'));
                if (!inPresentation) {
                    mountPresenterStageToPreview();
                }
            }

            // === 核心修复：用 MutationObserver 持续强制 object-fit:contain ===
            // Agora SDK 的 play() 会反复重写 video 元素样式，单次 setTimeout 不够
            function forceContain() {
                const videos = player.querySelectorAll('video');
                videos.forEach(v => {
                    v.style.objectFit = 'contain';
                    v.style.background = '#000';
                });
            }
            // 立即执行一次
            forceContain();
            // 延迟再执行（等 SDK 渲染完成）
            setTimeout(forceContain, 300);
            setTimeout(forceContain, 1000);
            setTimeout(forceContain, 3000);
            // 用 MutationObserver 监听 DOM 变更，持续覆盖
            const obs = new MutationObserver(forceContain);
            obs.observe(player, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
            // 10秒后停止观察（性能优化）
            setTimeout(() => obs.disconnect(), 10000);
        }
        if (mediaType === "audio") {
            user.audioTrack.play();
            // 取消静音状态
            const player = document.getElementById(`player-${user.uid}`);
            if (player) {
                const muteIcon = player.querySelector('.mute-icon');
                if (muteIcon) muteIcon.remove();
            }
        }
    }

    function handleUserUnpublished(user, mediaType) {
        const player = document.getElementById(`player-${user.uid}`);
        if (!player) return;

        if (mediaType === 'video') {
            // 视频关闭，移除画面
            player.remove();

            // Check if grid is empty, if so hide stage
            const grid = document.getElementById('agora-video-grid');
            const stage = document.getElementById('agora-video-stage');
            if (grid && stage && grid.children.length === 0) {
                if (String(user.uid) === String(activeScreenSharerUid)) activeScreenSharerUid = null;
                stage.style.display = 'none';
                if (!(window.location.pathname.includes('remote') || window.isRemoteApp)) {
                    unmountPresenterStageFromPreview();
                }
            }
        }
        if (mediaType === 'audio') {
            // 音频静音，显示图标
            let muteIcon = player.querySelector('.mute-icon');
            if (!muteIcon) {
                muteIcon = document.createElement('div');
                muteIcon.className = 'mute-icon';
                muteIcon.innerText = '🔇';
                muteIcon.style.cssText = 'position: absolute; bottom: 5px; right: 5px; background: rgba(0,0,0,0.6); color: white; padding: 2px 5px; border-radius: 4px; font-size: 12px; z-index: 5;';
                player.appendChild(muteIcon);
            }
        }
    }

    async function leaveChannel() {
        for (let track in localTracks) { if (localTracks[track]) { localTracks[track].stop(); localTracks[track].close(); } }
        localTracks = { video: null, audio: null, camera: null, screenAudio: null };
        if (agoraClient) await agoraClient.leave();
        document.getElementById('agora-local-box').style.display = 'none';
        document.getElementById('agora-video-stage').style.display = 'none';
        updateMicBtn(false);
        updateVideoBtn(false);
        isCalling = false;
    }

    function updateMicBtn(isActive) {
        const btn = document.getElementById('agora-mic-btn');
        if (btn) {
            btn.innerHTML = isActive ? '🎤' : '🔇';
            btn.title = isActive ? '关闭麦克风' : '开启麦克风';

            const isRemotePage = window.location.pathname.includes('remote') || window.isRemoteApp;
            if (isRemotePage || !btn.classList.contains('toolbar-btn')) {
                btn.style.background = isActive ? 'rgba(103,194,58,0.9)' : 'rgba(255,255,255,0.9)';
                btn.style.color = isActive ? 'white' : '#f56c6c';
            } else {
                if (isActive) {
                    btn.style.background = 'rgba(103,194,58,0.4)';
                    btn.style.borderColor = '#67c23a';
                    btn.style.color = '#fff';
                } else {
                    btn.style.background = 'rgba(255, 255, 255, 0.2)';
                    btn.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                    btn.style.color = '#f56c6c';
                }
            }
        }
    }

    function updateVideoBtn(isActive) {
        const btn = document.getElementById('agora-cam-btn');
        if (!btn) return;
        // 开启：纯摄像头图标；关闭：摄像头图标 + 红色斜线叠加徽章
        if (isActive) {
            btn.innerHTML = '📷';
        } else {
            btn.innerHTML = '<span style="position:relative;display:inline-block;line-height:1;">' +
                '📷' +
                '<span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(45deg);' +
                'width:110%;height:2.5px;background:#f56c6c;border-radius:2px;display:block;"></span>' +
                '</span>';
        }
        btn.title = isActive ? '关闭摄像头' : '开启摄像头';
        const isRemotePage = window.location.pathname.includes('remote') || window.isRemoteApp;
        if (isRemotePage || !btn.classList.contains('toolbar-btn')) {
            btn.style.background = isActive ? 'rgba(103,194,58,0.9)' : 'rgba(255,255,255,0.9)';
            btn.style.color = isActive ? 'white' : '#606266';
        } else {
            if (isActive) {
                btn.style.background = 'rgba(103,194,58,0.4)';
                btn.style.borderColor = '#67c23a';
                btn.style.color = '#fff';
            } else {
                btn.style.background = 'rgba(255, 255, 255, 0.2)';
                btn.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                btn.style.color = 'white';
            }
        }
    }

    function updateMediaPermissionState(canMic, canVideo) {
        const isMaster = !(window.location.pathname.includes('remote') || window.isRemoteApp);
        if (isMaster) return;
        isViewerMicAllowed = canMic !== false;
        isViewerVideoAllowed = canVideo !== false;
        const micBtn = document.getElementById('agora-mic-btn');
        const camBtn = document.getElementById('agora-cam-btn');
        if (micBtn) {
            micBtn.disabled = !isViewerMicAllowed;
            micBtn.style.opacity = isViewerMicAllowed ? '1' : '0.5';
            micBtn.style.cursor = isViewerMicAllowed ? 'pointer' : 'not-allowed';
            if (!isViewerMicAllowed) micBtn.title = '演示者已关闭观众麦克风权限';
        }
        if (camBtn) {
            camBtn.disabled = !isViewerVideoAllowed;
            camBtn.style.opacity = isViewerVideoAllowed ? '1' : '0.5';
            camBtn.style.cursor = isViewerVideoAllowed ? 'pointer' : 'not-allowed';
            if (!isViewerVideoAllowed) camBtn.title = '演示者已关闭观众摄像头权限';
        }
    }

    // 共享屏幕按钮 UI：绿色=共享中，白色=未共享（与麦克风按钮逻辑一致）
    function updateShareBtnUI(isSharing) {
        const btn = document.getElementById('agora-share-btn');
        if (!btn) return;

        const isRemotePage = window.location.pathname.includes('remote') || window.isRemoteApp;
        if (isRemotePage || !btn.classList.contains('toolbar-btn')) {
            if (isSharing) {
                btn.innerHTML = '⏹';
                btn.title = '停止共享';
                btn.style.background = 'rgba(103,194,58,0.9)'; // 绿色=激活中
                btn.style.color = 'white';
            } else {
                btn.innerHTML = '💻';
                btn.title = '共享屏幕';
                btn.style.background = 'rgba(255,255,255,0.9)'; // 白色=未激活
                btn.style.color = '#606266';
            }
        } else {
            // Presenter toolbar mode
            if (isSharing) {
                btn.innerHTML = '⏹';
                btn.title = '停止共享';
                btn.style.background = 'rgba(103,194,58,0.4)';
                btn.style.borderColor = '#67c23a';
                btn.style.color = '#fff';
            } else {
                btn.innerHTML = '💻';
                btn.title = '共享屏幕';
                btn.style.background = 'rgba(255, 255, 255, 0.2)';
                btn.style.borderColor = 'rgba(255, 255, 255, 0.2)';
                btn.style.color = 'white';
            }
        }
    }

    function updateShareBtnState(allowed, reason) {
        const btn = document.getElementById('agora-share-btn');
        if (!btn) return;

        // 演示者端永远可用
        if (!(window.location.pathname.includes('remote') || window.isRemoteApp)) {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
            btn.title = '发起屏幕共享';
            return;
        }

        if (allowed) {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
            btn.title = '发起屏幕共享';
            // 恢复正确的当前 UI 状态（未共享时为白色，共享中为绿色）
            updateShareBtnUI(isScreenSharing);
        } else {
            btn.disabled = true;
            btn.style.opacity = '0.5';
            btn.style.background = '#909399';
            btn.style.color = 'white';
            btn.style.cursor = 'not-allowed';
            btn.title = reason || '无推流权限';
        }
    }

    // 暴露核心方法
    window.agoraModule = {
        isSharing: () => isScreenSharing,
        toggleMinimize: function () {
            const stage = document.getElementById('agora-video-stage');
            const grid = document.getElementById('agora-video-grid');
            const btn = document.getElementById('agora-minimize-btn');
            const resizeHandle = document.getElementById('agora-resize-handle');

            if (isMinimized) {
                grid.style.display = 'grid';
                if (resizeHandle) resizeHandle.style.display = 'block';
                stage.style.height = stage.dataset.prevHeight || '240px';
                btn.innerHTML = '─'; // 恢复 minimize icon
                isMinimized = false;
            } else {
                stage.dataset.prevHeight = stage.style.height;
                grid.style.display = 'none';
                if (resizeHandle) resizeHandle.style.display = 'none';
                stage.style.height = '30px';
                btn.innerText = '□'; // maximize icon
                isMinimized = true;
            }
        },
        toggleMic: async function () {
            if ((window.location.pathname.includes('remote') || window.isRemoteApp) && !isViewerMicAllowed) {
                alert('演示者已关闭观众麦克风权限');
                return;
            }
            if (!isCalling || !agoraClient) {
                // 如果还未加入频道，则加入音频频道并开启麦克风
                agoraClient = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
                agoraClient.on("user-published", handleUserPublished);
                agoraClient.on("user-unpublished", handleUserUnpublished);

                try {
                    if (typeof agoraClient.enableAudioVolumeIndication === 'function') {
                        agoraClient.enableAudioVolumeIndication(2000, 3);
                        agoraClient.on("volume-indicator", handleAudioVolumeIndication);
                    }
                } catch (e) {
                    console.warn('音量监测功能不可用:', e);
                }

                await agoraClient.join(AGORA_APP_ID, DEFAULT_CHANNEL, null, myUid());
                isCalling = true;
            }

            if (!localTracks.audio) {
                // 创建并发布麦克风
                try {
                    localTracks.audio = await AgoraRTC.createMicrophoneAudioTrack();
                    await agoraClient.publish([localTracks.audio]);
                    updateMicBtn(true);
                    broadcastMicStatus(true);
                } catch (e) {
                    console.error("麦克风启动失败:", e);
                    alert("无法获取麦克风权限！");
                }
            } else {
                // 切换麦克风状态 (Mute / Unmute)
                const isEnabled = localTracks.audio.enabled;
                await localTracks.audio.setEnabled(!isEnabled);
                const newState = !isEnabled;
                updateMicBtn(newState);
                broadcastMicStatus(newState);
            }
        },
        isMicEnabled: function() {
            return localTracks.audio && localTracks.audio.enabled;
        },
        toggleVideo: async function () {
            if ((window.location.pathname.includes('remote') || window.isRemoteApp) && !isViewerVideoAllowed) {
                alert('演示者已关闭观众摄像头权限');
                return;
            }
            if (isScreenSharing) {
                alert('屏幕共享中暂不支持开启摄像头');
                return;
            }
            if (!isCalling || !agoraClient) {
                agoraClient = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
                agoraClient.on("user-published", handleUserPublished);
                agoraClient.on("user-unpublished", handleUserUnpublished);
                await agoraClient.join(AGORA_APP_ID, DEFAULT_CHANNEL, null, myUid());
                isCalling = true;
            }

            if (!localTracks.camera) {
                try {
                    localTracks.camera = await AgoraRTC.createCameraVideoTrack();
                    await agoraClient.publish([localTracks.camera]);
                    const stage = document.getElementById('agora-video-stage');
                    if (stage) stage.style.display = 'flex';
                    const localBox = document.getElementById('agora-local-box');
                    if (localBox) localBox.style.display = 'block';
                    localTracks.camera.play('agora-local-box');
                    updateVideoBtn(true);
                } catch (e) {
                    console.error("Camera start failed:", e);
                    alert("无法获取摄像头权限");
                }
            } else {
                const isEnabled = localTracks.camera.enabled;
                await localTracks.camera.setEnabled(!isEnabled);
                const localBox = document.getElementById('agora-local-box');
                if (!isEnabled) {
                    if (localBox) localBox.style.display = 'block';
                    localTracks.camera.play('agora-local-box');
                } else {
                    if (localBox) localBox.style.display = 'none';
                }
                updateVideoBtn(!isEnabled);
            }
        },
        isVideoEnabled: function() {
            return !!(localTracks.camera && localTracks.camera.enabled);
        },
        setMediaPermission: function(micAllowed, videoAllowed) {
            updateMediaPermissionState(micAllowed, videoAllowed);
            if ((window.location.pathname.includes('remote') || window.isRemoteApp) && !isViewerMicAllowed && localTracks.audio && localTracks.audio.enabled) {
                localTracks.audio.setEnabled(false).catch(() => {});
                updateMicBtn(false);
            }
            if ((window.location.pathname.includes('remote') || window.isRemoteApp) && !isViewerVideoAllowed && localTracks.camera && localTracks.camera.enabled) {
                localTracks.camera.setEnabled(false).catch(() => {});
                const localBox = document.getElementById('agora-local-box');
                if (localBox) localBox.style.display = 'none';
                updateVideoBtn(false);
            }
        },
        setDefaultSettings: function(settings) {
            if (!settings) return;
            userSettings.enableAudio = settings.enableAudio !== false;
            userSettings.enableVideo = settings.enableVideo === true;
        },
        applyDefaultMediaOnLogin: async function() {
            try {
                if (userSettings.enableAudio) await this.toggleMic();
                if (userSettings.enableVideo) await this.toggleVideo();
            } catch (e) {
                console.warn('applyDefaultMediaOnLogin failed', e);
            }
        },

        setSharingPermission: function (presenterOnline, sharingAllowed) {
            const isMaster = !(window.location.pathname.includes('remote') || window.isRemoteApp);
            if (isMaster) return; // 主控端跳过限制

            // 观众端逻辑调整：移除 presenterOnline 的物理绑定
            // 不再需要演示者在线，赋予观众自由投屏权
            const canShare = sharingAllowed;
            let reason = '';
            if (!sharingAllowed) reason = '演示者已关闭观众投屏权限';

            updateShareBtnState(canShare, reason);

            // 手动干预：如果主讲人明确关闭（allowed = false），正在分享的连接将被实时掐断
            if (isScreenSharing && !sharingAllowed) {
                console.warn('停止投屏：演示者手动回收了投屏权限。');
                alert('演示者已关闭观众投屏权限');
                this.stopScreenShare();
            }
        },
        forceMuteLocal: function () {
            if (localTracks.audio) {
                localTracks.audio.setEnabled(false).catch(e => console.error("Force mute err:", e));
                updateMicBtn(false);
                const div = document.createElement('div');
                div.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgba(244,67,54,0.9);color:white;padding:10px 20px;border-radius:20px;z-index:999999;';
                div.innerHTML = '🔇 主讲人已强制静音您的麦克风';
                document.body.appendChild(div);
                setTimeout(() => div.remove(), 4000);
            }
        },
        forceUnmuteLocal: function () {
            if (localTracks.audio) {
                localTracks.audio.setEnabled(true).catch(e => console.error("Force unmute err:", e));
                updateMicBtn(true);
                const div = document.createElement('div');
                div.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:rgba(76,175,80,0.9);color:white;padding:10px 20px;border-radius:20px;z-index:999999;';
                div.innerHTML = '🔊 主讲人已允许您发言';
                document.body.appendChild(div);
                setTimeout(() => div.remove(), 4000);
            }
        },
        startScreenShare: async function () {
            // 最终物理拦截：仅检查手动开关状态
            if (window.location.pathname.includes('remote') || window.isRemoteApp) {
                const isViewerSharingAllowed = window.isViewerSharingAllowed !== false;
                if (!isViewerSharingAllowed) {
                    alert('操作被拒绝：演示者已关闭观众投屏。');
                    return;
                }
            }

            try {
                if (!isCalling || !agoraClient) {
                    agoraClient = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
                    agoraClient.on("user-published", handleUserPublished);
                    agoraClient.on("user-unpublished", handleUserUnpublished);

                    try {
                        agoraClient.enableAudioVolumeIndication(2000, 3);
                        agoraClient.on("volume-indicator", handleAudioVolumeIndication);
                    } catch (e) { }

                    await agoraClient.join(AGORA_APP_ID, DEFAULT_CHANNEL, null, myUid());
                    isCalling = true;
                }

                // Call createScreenVideoTrack
                const screenTracks = await AgoraRTC.createScreenVideoTrack({
                    encoderConfig: "1080p_1",
                    optimizationMode: "detail",
                    screenSourceType: "screen" // Force screen/window selection
                }, "auto"); // "auto" captures system audio if chosen

                const screenVideoTrack = Array.isArray(screenTracks) ? screenTracks[0] : screenTracks;
                const screenAudioTrack = Array.isArray(screenTracks) ? screenTracks[1] : null;

                if (localTracks.camera) {
                    try { await agoraClient.unpublish(localTracks.camera); } catch (e) { }
                    localTracks.camera.stop();
                    localTracks.camera.close();
                    localTracks.camera = null;
                    updateVideoBtn(false);
                }

                // Unpublish existing camera if any
                if (localTracks.video) {
                    await agoraClient.unpublish(localTracks.video);
                    localTracks.video.stop();
                    localTracks.video.close();
                }

                localTracks.video = screenVideoTrack;
                let tracksToPublish = [screenVideoTrack];

                // 2025 优化：尝试捕获麦克风，实现“讲解 + 背景音”双音轨推送
                if (!localTracks.audio) {
                    try {
                        localTracks.audio = await AgoraRTC.createMicrophoneAudioTrack();
                        // 同步更新麦克风图标为已激活（绿色）
                        if (typeof updateMicBtn === 'function') updateMicBtn(true);
                    } catch (e) {
                        console.warn("麦克风无权限或设备未连接，仅推送系统/屏幕声音", e);
                    }
                } else {
                    // 如果麦克风已经在之前的通话中开启了，确保它是开启状态
                    await localTracks.audio.setEnabled(true);
                    if (typeof updateMicBtn === 'function') updateMicBtn(true);
                }

                // 将麦克风加入发布列表 (如果已捕获)
                if (localTracks.audio) {
                    tracksToPublish.push(localTracks.audio);
                }

                // 关键点：将电脑系统声音（如果捕获到的话）也并入推送队列
                if (screenAudioTrack) {
                    console.log("✅ 发现系统音频流，正与麦克风混音中...");
                    tracksToPublish.push(screenAudioTrack);
                    localTracks.screenAudio = screenAudioTrack; // 登记以便后续统一注销
                }

                document.getElementById('agora-local-box').style.display = 'block';
                localTracks.video.play('agora-local-box');

                await agoraClient.publish(tracksToPublish);
                isScreenSharing = true;
                updateShareBtnUI(true); // 共享成功，变红

                const stage = document.getElementById('agora-video-stage');
                if (stage) stage.style.display = 'flex';

                screenVideoTrack.on("track-ended", () => {
                    window.agoraModule.stopScreenShare();
                });

                // === 防冲突：发信号踢掉其他人 ===
                if (window.mqttClient && window.mqttClient.connected) {
                    const statusMsg = { action: 'screen_share_started', uid: agoraClient.uid };
                    const topic = window.STATUS_TOPIC || (window.BEMFA_KEY ? window.BEMFA_KEY + '/PPT002' : 'PPT002');
                    window.mqttClient.publish(topic, JSON.stringify(statusMsg), { qos: 0 });
                }
            } catch (e) {
                console.error("Screen share failed:", e);
                updateShareBtnUI(false);
                if (!isScreenSharing && !localTracks.audio && !localTracks.video) {
                    leaveChannel();
                }
            }
        },
        stopScreenShare: function () {
            if (isScreenSharing) {
                isScreenSharing = false;
                updateShareBtnUI(false); // 停止共享，回绿

                // 清理屏幕音频轨道
                if (localTracks.screenAudio) {
                    localTracks.screenAudio.stop();
                    localTracks.screenAudio.close();
                    localTracks.screenAudio = null;
                }

                leaveChannel();
                
                // 主控端 UI 清理
                if (!(window.location.pathname.includes('remote') || window.isRemoteApp)) {
                    document.body.classList.remove('is-live-streaming');
                    this.exitPresenterPreviewMode();
                    
                    // 恢复 index.html 中的各种 UI 元素 (通过事件通知)
                    window.dispatchEvent(new CustomEvent('agora-screen-share-stopped'));
                }
                
                // 广播屏幕分享结束
                if (window.mqttClient && window.mqttClient.connected) {
                    const topic = window.STATUS_TOPIC || (window.BEMFA_KEY ? window.BEMFA_KEY + '/PPT002' : 'PPT002');
                    window.mqttClient.publish(topic, JSON.stringify({ action: 'screen_share_stopped' }), { qos: 0 });
                }
            }
        },
        ensureViewerJoined: async function() {
            if (!isCalling) {
                console.log("需要接收流，自动加入 Agora 频道...");
                await initRemoteAgora();
            }
        },
        handleScreenShareLock: function (incomingUid) {
            // === 防冲突机制：如果别人抢占了屏幕分享，自己自动断开 ===
            activeScreenSharerUid = incomingUid;
            if (agoraClient && agoraClient.uid !== incomingUid) {
                if (isScreenSharing) {
                    alert('会议中其他人开始了屏幕共享，您的共享已自动停止。');
                    this.stopScreenShare();
                }
            }
            this.ensureViewerJoined().catch(() => { });
            if (!(window.location.pathname.includes('remote') || window.isRemoteApp)) {
                mountPresenterStageToPreview();
            }
            startScreenRecoveryWatch();
        },
        setActiveScreenSharer: function(uid) {
            activeScreenSharerUid = uid;
        },
        enterPresenterPreviewMode: function(uid) {
            activeScreenSharerUid = uid ?? activeScreenSharerUid;
            if (window.location.pathname.includes('remote') || window.isRemoteApp) return;
            mountPresenterStageToPreview();
            startScreenRecoveryWatch();
        },
        exitPresenterPreviewMode: function() {
            activeScreenSharerUid = null;
            if (window.location.pathname.includes('remote') || window.isRemoteApp) {
                exitCinemaMode();
                return;
            }
            unmountPresenterStageFromPreview();
        },
        setPresenterWatchPaused: setPresenterWatchPaused,
        getActiveScreenSharerUid: function() { return activeScreenSharerUid; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUI);
    } else { initUI(); }
})();
