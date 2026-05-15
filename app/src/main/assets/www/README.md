# 互动演示系统 (Sync Slide System)

基于 MQTT + WebRTC + WebDAV 的实时演示与互动系统。

## 功能概览
- 主持端：`index.html`
  - 文件管理（上传、预览、重命名、移动、删除）
  - 演示控制（翻页、跳页、涂鸦同步）
  - 会议邀请与房间管理
  - Agora 音视频与屏幕共享
- 观众端：`remote.html`
  - 同步接收演示状态
  - 聊天与文件互动
  - 全屏观看与主持协作
- Worker 后端：`_worker.js`
  - WebDAV 代理
  - 登录/注册与用户隔离目录
  - 聊天接口（消息、在线心跳、文件上传）

## 聊天存储模式
Worker 聊天按以下优先级运行：
1. D1（`env.CHAT_DB`）
2. 内存临时态（fallback）

接口返回中会包含 `storageMode`，用于前端识别当前模式。

## 本地开发
这是原生前端项目，无构建流程。

```bash
npx serve .
```

然后访问：
- 主持端：`/index.html`
- 观众端：`/remote.html`

## 相关脚本
- 转换服务：`scripts/converter.js`
- VPS 部署脚本：`scripts/deploy_vps.sh`

## 编码约定
仓库文本文件统一使用 UTF-8 编码（建议 LF 换行）。
