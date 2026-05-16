# Project-PPT-V2 项目介绍与控制协议

本系统（Project-PPT-V2）是一个基于双通道（MQTT + HTTP）模式的实时交互、文档同步及远程控制系统。

## 基础架构
- MQTT Broker: ws://broker.emqx.io:8083/mqtt (EMQX 公共服务)
- 协议: MQTT v3.1.1
- 隔离机制: 通过 BEMFA_KEY 实现房间级 Topic 隔离。

## 核心功能
- 文档同步: 支持 PDF/Image/Video 等多种格式的实时同步。
- 互动功能: 实时涂鸦（Canvas 比例坐标）、心跳检测、即时聊天、文件分享。
- 交互模式: 新增 html_app 模式，支持沙箱化运行 JS 并回传交互事件。

## 控制方式
- CONTROL_TOPIC: 翻页 (next/prev)、跳转 (goto)、退出 (exit)、全屏、刷新。
- STATUS_TOPIC: 状态广播、聊天、涂鸦数据同步。
- HTTP API: 支持 AI 指令注入及全局状态查询。
