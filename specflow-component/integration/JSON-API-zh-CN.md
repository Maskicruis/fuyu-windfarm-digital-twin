# 第三方软件调用：JSON 问答

启动 SpecFlow 知识组件，在组件的模型设置中配置并测试 API。第三方软件用 HTTP 调用组件，不需要传入模型服务商的密钥。默认地址为 `http://127.0.0.1:8790`；端口占用时以 EXE 同目录的 `workspace/data/component-service.json` 为准。若启动时传入 `--data-dir`，请在该数据目录中查找这个文件。

```http
POST /api/v1/ask/json
Content-Type: application/json
Accept: application/json
```

普通问答传 `{"question":"混凝土养护有哪些要求？","retrievalMode":"knowledge","searchScope":"all"}`，读取 `data.answer`、`data.citations` 和 `data.conversationId`。后续问题传入同一个 `conversationId`。需要业务字段时传 `responseSchema`，默认从 `data.result` 读取结构化对象或数组，出处保留在 `data.citations`。出处内的 `docId`、`page`、`itemId` 和定位链接沿用原文阅读接口。

要像业务系统截图一样让响应体直接是数组或对象，设置 `responseMode: "raw"`。以下命令可直接联调：

```powershell
curl.exe -i http://127.0.0.1:8790/api/v1/ask/json -H "Content-Type: application/json" --data-binary "@ask-json-example.json"
```

[示例请求文件](ask-json-example.json)的成功响应：

```json
[
  {
    "startMile": "YK17+004",
    "worklineName": "超前预报作业线",
    "childList": [
      { "nodeCode": "209723882444593971201", "time": "10-08 09:00", "title": "超前地质钻孔开始" }
    ]
  }
]
```

原样模式的会话 ID 和回答来源类型从 `X-SpecFlow-Conversation-Id`、`X-SpecFlow-Grounding` 响应头读取。需要原文引用时使用默认响应模式。里程、长节点编号、含前导零的编码等建议声明为 `string`，避免数值精度损失。

模式保持一致：`general` 不检索；`knowledge` 仅按资料库回答；`auto` 有证据时按库回答，否则使用通用模型。需要全库检索时传 `searchScope: "all"`。资料或输入缺少必要事实时，结构化请求可能返回 422，调用方可补充后重试。

先检查 HTTP 状态码。失败始终是 JSON 对象 `{"ok":false,"apiVersion":"v1","error":{"code":"...","message":"..."}}`，有检索或澄清信息时可能额外返回 `data`。400 表示请求或结构无效，413 表示请求太大，415 表示媒体类型不支持，422 表示无法生成结构化结果，502 表示模型调用失败或输出不合规，503 表示尚未配置模型。模型输出不会二次调用修补，也不会自动填补缺失数据。

`responseSchema` 接受 [JSON Schema 2020-12](https://json-schema.org/draft/2020-12) 的常用子集。顶层须为 `object` 或 `array`，各层显式声明单一 `type`。支持 `description`、`properties`、`required`、布尔 `additionalProperties`、`items`、基本值 `enum`、`minimum/maximum`、`minItems/maxItems`、`minLength/maxLength`。不接受远程引用、正则、组合模式或递归结构；大小上限 16 KiB，最多 128 个结构节点，最多 8 层嵌套（根为第 0 层）。通过结构校验不等于模型事实已被人工核实。

Postman 可导入组件在线提供的 OpenAPI 文档：`http://127.0.0.1:8790/schemas/ask-json.openapi.json`。Node 宿主也可调用 `SpecFlowKnowledgeClient.askJson(payload)`。现有 `/api/v1/ask` 和桌面流式 `/api/v1/ask/stream` 保持兼容。

接口默认只监听本机。异机调用应由宿主通过受认证的网关转发所需路由；浏览器跨来源接入可用 `KB_CORS_ORIGIN` 配置明确的可信来源。不要把整个本地管理服务暴露给外部。
