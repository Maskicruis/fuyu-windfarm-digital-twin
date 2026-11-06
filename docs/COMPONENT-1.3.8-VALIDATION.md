# 独立知识组件 1.3.8：SiliconFlow 与第三方 API

本次为模型接入和设置页的定向修复。未更改规范库、OCR 引擎或 1.3.7 的更新中继。

## 兼容处理

- SiliconFlow 根地址、/v1 地址和完整 chat/completions 地址使用同一规范化规则；补齐已知平台的 /v1，避免重复路径分隔符。自定义服务保留用户的代理前缀和查询参数。
- 保留用户填写的平台完整模型 ID（包括 Pro/、deepseek-ai/），不把第三方模型改成 DeepSeek 官方别名。图片仍需所选平台支持的视觉模型。
- DeepSeek 官方使用 thinking.type；SiliconFlow 支持切换的 DeepSeek V3.1/V3.2/V4、Qwen3 使用 enable_thinking。R1 等不支持切换的固定推理模型不强加该参数；其他平台不盲目发送厂商字段。
- 增加 SiliconFlow 示例、读取模型列表及测试连接。检查使用当前表单但不保存，不发送资料库内容、不写入对话；用户测试成功后仍需保存配置。
- 切换源站不能留空沿用旧平台密钥；同源站修正接口路径可保留密钥。Bearer 前缀可规范处理。
- 展示平台错误码、错误说明和可用的 SiliconFlow trace ID；隐藏密钥。向量接口沿用相同的平台地址解析规则。

## 验证及限制

85 项 Node 测试通过，包含受控平台的模型列表、连接测试、HTTP 错误/trace ID、平台参数和密钥隔离；原有 JSON/SSE、检索、PDF、恢复与更新测试通过。最终 EXE 独立验证包括连续上下文、思考与回答事件、原文定位、设置/历史/端口重启保留。

本地没有 SiliconFlow 的账户密钥，没有声称使用该账户完成真实付费推理。未携带凭据访问官方 /v1/models 返回 401，只说明该接口可访问。账户余额、模型授权和当前模型是否在线，请使用设置页的“测试连接”核对。

官方接口资料：[对话 API](https://docs.siliconflow.cn/docs/api/chat-completions-post)、[模型列表](https://docs.siliconflow.cn/docs/api/models-get)、[推理参数](https://docs.siliconflow.cn/docs/userguide/capabilities/reasoning)。

EXE SHA256：`85afd2e843e01e29f3d330f97f45d8809ffc797fc829c983f2b9d753eed8ba27`。
