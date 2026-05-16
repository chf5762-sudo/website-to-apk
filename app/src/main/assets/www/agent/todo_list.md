Todo List
- 增加 interaction 事件增量消费机制（last_event_id / cursor），避免 AI Agent 重复处理。
- 增加 interaction 事件鉴权与来源校验（origin/session/token），降低伪造事件风险。
- 增加 html_app 安全策略开关（sandbox 白名单、CSP、禁用高风险 capability）。
- 增加 interaction 事件清理与生命周期策略（TTL、按 room 清理、手动 clear API）。
- 为 html_app 与 interaction 链路补充端到端测试（push -> render -> postMessage -> fetch interactions）。
- 在 easyshow-screen-control/SKILL.md 补充 html_app 推送与交互回传示例。
