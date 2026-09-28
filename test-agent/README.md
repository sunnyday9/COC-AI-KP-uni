# test-agent

这里是跨 REST 与 WebSocket 的房间协议回归旅程，可使用确定性 MOCK_AI，
也可选用真实 LLM。

当前入口是：

```bash
node test-agent/run-all.mjs
```

它运行 `room-protocol.mjs`，只使用当前架构的公开契约：

1. REST 注册、AI 设置、上传与 RAG 索引；
2. `POST /api/rooms/solo` 创建单人房；
3. WebSocket `room:join` 等待快照和 opening；
4. WebSocket `room:action` 触发服务端权威 KP 回合，并断言玩家/KP 事件；
5. `GET /api/rooms/solo` 验证续玩列表。

CI 使用 `MOCK_AI=1 node test-agent/run-all.mjs`，不需要 LLM 凭据。真实 LLM
运行时不设置 `MOCK_AI=1`，并配置 `AW_BASE_URL`、`AW_API_KEY`、`AW_MODEL`；
也可以让基建从本机 ZCode opencode 配置读取端点。

当前旅程覆盖调查线索、战斗 HP、SAN 损失、结束态与结局持久化。每个场景
通过 `room:event` 的工具结果消息和状态补丁观察行为，并通过 REST 房间详情
核对持久化状态。客户端只发送 `room:join` 与 `room:action`。

`scenario-*.mjs`、`robustness.mjs`、`performance.mjs` 与 `REPORT.md` 保留了
2026-08-18 客户端工具循环时代的历史结果，不由当前入口执行。新的房间行为
应补到 `room-protocol.mjs` 或对应的 e2e journey。
