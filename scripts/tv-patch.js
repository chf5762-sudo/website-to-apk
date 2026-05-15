// ==UserScript==
// @name        Android TV Optimization Patch
// @match       *://easyshow.beundredig.eu.org/remote.html*
// @run-at      document-start
// ==/UserScript==

(function() {
    console.log("📺 Android TV Optimization Patch Active");

    // 1. 立即注入 CSS 优化 (移除所有 backdrop-filter)
    const style = document.createElement('style');
    style.textContent = `
        * {
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
        }
        .controls-container, .discussion-sidebar, .tech-card, #chat-fab, .screen-idle-badge {
            background-color: rgba(20, 20, 20, 0.95) !important;
            backdrop-filter: none !important;
        }
        #pdfCanvas, #pdfCanvasNext, #imageDisplay, #imageDisplayNext {
            transition: opacity 0.2s ease-in-out !important;
        }
    `;
    document.documentElement.appendChild(style);

    // 2. 限制 devicePixelRatio (防止电视 GPU 溢出)
    if (window.devicePixelRatio > 1.5) {
        Object.defineProperty(window, 'devicePixelRatio', {
            get: function() { return 1.5; }
        });
    }

    // 3. 等待 body 加载后进行 DOM 增强
    window.addEventListener('DOMContentLoaded', () => {
        console.log("🛠️ Injecting Double Buffering Elements...");
        
        // 自动补全可能缺失的 Next 元素 (如果远程代码还没更新)
        if (!document.getElementById('pdfCanvasNext')) {
            const original = document.getElementById('pdfCanvas');
            if (original) {
                const next = original.cloneNode(true);
                next.id = 'pdfCanvasNext';
                next.style.display = 'none';
                original.parentNode.insertBefore(next, original.nextSibling);
            }
        }

        if (!document.getElementById('imageDisplayNext')) {
            const original = document.getElementById('imageDisplay');
            if (original) {
                const next = original.cloneNode(true);
                next.id = 'imageDisplayNext';
                next.style.display = 'none';
                original.parentNode.insertBefore(next, original.nextSibling);
            }
        }
    });

    // 4. 暴力兼容性补丁 (Polyfills)
    if (!Object.assign) {
        Object.assign = function(target, ...sources) {
            if (target == null) throw new TypeError('Cannot convert undefined or null to object');
            target = Object(target);
            for (var i = 0; i < sources.length; i++) {
                var source = sources[i];
                if (source != null) {
                    for (var key in source) {
                        if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
                    }
                }
            }
            return target;
        };
    }
})();
