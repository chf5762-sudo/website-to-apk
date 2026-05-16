Finish List
- 保留原有屏幕模式：text/image/video/svg/html/pdf/doc 渲染链路保持不变。
- 新增交互展示模式：支持 type=html_app，使用 iframe srcdoc + sandbox 渲染可执行 JS 的页面。
- 新增交互回传：remote 端监听 postMessage，并自动上报到 /api/screen/interaction。
- 新增事件查询能力：后端提供 /api/admin/screen/interactions，CLI 新增 interactions 命令可拉取最近事件。
