# ADR-0003：LLM 接入协议一等公民（Chat / Responses / Messages）

- 状态：已接受（2026-09-02）
- 关联：docs/api-contract.md §2/§3、shared/constants/providers.ts、server/src/services/aiService.ts、CONTEXT.md（LLM 协议 / 协议适配器 / 嵌入端点 / 模板）

## 背景

当前 LLM 接入是「provider → protocol」两级模型：`settings.ai.provider` 存预设/自定义服务商 id，协议（openai_compatible / anthropic_compatible / google_compatible / deepseek_compatible）从 provider 反查。用户要接入一个新端点只能选一个「兼容类型」，无法直接表达「我要用哪种 API 协议 + 端点 + key」。同时 OpenAI Responses API（`/v1/responses`）完全未接入——全仓零痕迹，而 Chat Completions 与 Messages 已有适配器（`doOpenAICompat` / `doAnthropic`）。

勘察发现三个既有问题：
1. **`deepseek_compatible` 是冗余协议**：dispatch 与 openai_compatible 同分支（原始 aiHandlers.cjs 的 PROVIDER_MAP 本就把它映射到 openai_compatible），无独立语义。
2. **vllm/ollama 预设默认 baseUrl 是 localhost，但 `assertSafeOutboundUrl` 拦 localhost**——选这两个预设发起调用必 400，功能实际不可用。
3. **协议未上契约**：api-contract §2 只定义 `provider: string`，protocol 只是服务端内部实现细节，用户无法显式配置。

## 决策

1. **协议一等公民**：`settings.ai.protocol` 是唯一协议真源，枚举 `openai_chat | openai_responses | anthropic_messages | google_compatible`。删除 `provider` 字段（无存量用户，直接改 schema，不做迁移）。HTTP 契约 §3 不变（chat/models 请求体不携带 AI 配置，协议只存在于服务端设置）；§2 的 AIProviderConfig 改为 `{ protocol, baseUrl, model, apiKey?, temperature, maxTokens }`。
2. **适配器模块化**：拆 `server/src/services/llm/`，统一接口 `{ content, chunks, toolCalls }`；三个适配器各自持有协议私有转换（system 抽取、assistant tool_calls ↔ tool_use、工具结果回填），不做跨协议统一转换层。`dispatchChat` 收敛为按 `protocol` 分发；消费面（`chat`/`chatForAgent`/`chatForRag`）签名不变，kpAgent/rag/mockAi 零改动。
3. **Responses 适配器用 openai SDK**（`client.responses.create`，依赖已有 v4.104.0），流式消费 `raw_output`：累积 `output_text.delta` 为 content，工具在 `function_call`/`output_item.done` 拿完整 arguments——**不做流式 JSON 增量聚合**（KP agent 流式消费的是 content 增量与工具完成后的完整参数，无 delta 消费方）。
4. **google_compatible 保留为一等协议**（有存量语义 `_thoughtSignature` 双向透传，无等价协议可映射），进主 UI 四卡片之一。
5. **`deepseek_compatible` 合并**：不再有独立 deepseek 协议；deepseek 用户选 `openai_chat` + 自填 `https://api.deepseek.com/v1`。
6. **嵌入端点与主协议解耦**：`POST {baseUrl}/v1/embeddings`（OpenAI 格式）固定为嵌入路径，协议切 anthropic/responses 时嵌入仍打同一 baseUrl 的 OpenAI 格式端点（anthropic/google 无等价嵌入 API）。`ragService.buildGetEmbedding` / `rag/embedding.ts` 保持现状。
7. **本地端点不豁免 SSRF**：`assertSafeOutboundUrl` 维持现状，不因协议重构放开 localhost/私有段。vllm/ollama 预设默认 baseUrl 清空（不再内置 localhost 默认值），本地部署用户需自行填入可达端点；放弃内置 localhost 默认值。
8. **工具循环归属 kpAgent**：适配器只做单次往返（一次请求 → `{ content, toolCalls }`），工具调用循环留在 kpAgentService，不因协议而异。
9. **listModels 统一实时拉取**：三协议（chat/responses/messages）统一 `GET {baseUrl}/models`（OpenAI 格式）按 `purpose=chat|embeddings` 过滤；anthropic 实时拉取失败回退静态 `AI_MODEL_LISTS`。google 保留现状（`/v1beta/models` + supportedGenerationMethods 过滤）。

## 被否决的替代

- **(a) 保留 provider 作为模板维度（Q1-A）**：用户可直接选协议 + 自填 endpoint，模板卡片（常用服务商/自定义端点两组）失去意义；无存量用户，直接删最干净。
- **(b) Responses 用 fetch 手写（Q7-B）**：openai SDK 已在依赖且是 Responses 原生载体，手写 SSE 是重复造轮子。
- **(c) 流式 JSON 增量聚合（Q8-B）**：responses 的 `function_call_arguments.delta` 分片在 `output_item.done` 前不可用，KP agent 无中间消费方；完整 events 解析 + 不拼 delta 已满足需求。
- **(d) 本地端点白名单豁免（Q6-A）**：SSRF 门禁的防护对象是「攻击者诱导服务端打内网」，本地部署用户自担风险是合理诉求；但 Q6-B 定案为不豁免，vllm/ollama 清空 localhost 默认值、由用户显式填可达端点。
- **(e) 迁移脚本/启动迁移（Q15-B/C）**：无存量用户，直接改 schema，不做迁移。

## 后果

- 设置页 provider 卡片 → 协议卡片（4 张：OpenAI Chat / OpenAI Responses / Anthropic Messages / Gemini），点选自动填充默认 endpoint + 模型列表；下方表单 baseUrl/apiKey/model/temperature/maxTokens。
- 「测试连接」保持现状语义（用当前表单发一条最小 chat），与协议解耦。
- RAG 嵌入路径零改动；GraphRAG 抽取仍走 `chatForRag`（协议无关）。
- 安全面不变：出站请求仍全部过 `assertSafeOutboundUrl`；本地部署用户需自行保证端点可达性（产品文档注明）。
- 消费面（kpAgentService/ragService/ai.routes/mockAi）零改动，`chat`/`chatForAgent`/`chatForRag` 签名不变。
- 前提：无已部署用户（v0.1.0 未发布），无兼容层。
