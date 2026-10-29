# 知识与智能体组件 v1

此目录是独立的模型问答、资料解析与来源定位组件。它不依赖 Three.js、Cesium、Unity 或扶余风场模型，复用同一套 AgentService、KnowledgeStore 与 API 设置实现。

## 独立运行与嵌入

EXE 的独立组件模式只运行本机知识服务和 `/plugin/widget.html`。调用宿主的 `--plugin-only` 入口；项目数据根目录应独立指定，不要让不同项目共用一份资料库。EXE 入口、数据根目录参数以主程序使用说明为准。解析依赖与界面运行资源由 EXE 打包；扫描件的 MinerU OCR 环境仍需另行配置。

打开本机服务的 `/plugin/integration-demo.html`，可验证浮窗、上下文切换和设置入口。独立窗口 `/plugin/widget.html` 提供 API 配置、导入/后台解析、检索、会话历史、流式思考/回答和精确原文阅读，不启动风场三维场景。

```html
<script src="http://127.0.0.1:8779/plugin/twin-knowledge-sdk.js"></script>
<script>
const assistant = TwinKnowledge.mount({
  baseUrl: 'http://127.0.0.1:8779',
  onFocusRequest(target) {
    // 在宿主已登记对象中核验 ID；使用自己的场景引擎定位。
    if (catalog.has(target.objectId)) scene.focus(target.objectId);
  },
  onError(message) { console.warn(message); }
});
assistant.setContext({
  systemId: 'my-digital-twin', projectId: 'project-001',
  unit: 'ALL', scope: 'ALL',
  object: {id: 'A-01', label: '一号设备'},
  location: {zone: 'A 区'}, module: 'construction',
  host: {discipline: 'equipment'}
});
</script>
```

`mount` 返回 `setContext(context)`、`setOpen(bool)`、`openSettings()`、`destroy()`。可传 `container` 将浮窗放入指定容器。`onReady` 表示已经完成来源校验。组件接口协议为 `twin-knowledge/v1`，只处理登记的消息种类，并校验 message 的来源、窗口和独立 channel；不执行模型返回的脚本、任意 URL 或场景命令。

外部宿主必须在组件数据目录 `data/plugin-settings.json` 中明确登记页面 origin，重启后生效：

```json
{"allowedOrigins":["https://twin.example.com","http://127.0.0.1:8080"],"allowConfiguration":false}
```

仅嵌入 iframe 浮窗不需要把模型 API Key 或集成令牌传给宿主。组件内的设置由组件服务保存。`file://` 页面、`null` origin、通配来源及未登记来源不会接受宿主消息；请通过宿主自己的 HTTP(S) 服务加载页面。HTTPS 宿主访问本机 HTTP 服务是否需要浏览器本地网络许可，取决于宿主部署环境与浏览器策略。

## 版本化 API

基础路径 `/api/plugin/v1`，完整定义见 `openapi.json`。API 适配器仅将版本化请求映射到既有的资料/模型服务，没有第二套解析或 RAG 逻辑。

| 接口 | 用途 |
|---|---|
| `GET /manifest` | 组件版本、能力及接入来源；不含密钥 |
| `POST /context/validate` | 校验宿主上下文，返回规范对象 |
| `GET/PUT /settings` | 读取公开模型参数 / 更新配置；读取不返回原始密钥 |
| `POST /settings/test` | 使用已保存配置发送简短连接测试 |
| `POST /chat/stream` | 实际 SSE 事件：status、citations、reasoning、delta、done/error |
| `POST /chat` | 相同问答逻辑的非流式兼容入口 |
| `GET/POST /conversations`、`GET /conversations/{id}` | 本机会话历史与恢复 |
| `GET /knowledge/status` | 后台解析队列与状态 |
| `GET/PUT /knowledge/settings` | 原生解析 / MinerU 参数 |
| `GET/POST /knowledge/groups` | 资料分组 |
| `GET/POST /knowledge/documents` | 列表 / 原始文件上传，文件体最大 40 MiB |
| `GET/PUT /knowledge/documents/{id}` | 查询/修改登记与关联 |
| `POST /knowledge/documents/{id}/reparse` | 重解析，旧引用版本随之失效 |
| `GET /knowledge/search` | 限定范围检索 |
| `GET /knowledge/documents/{id}/source`、`/content`、`/locate` | 原件、解析内容及精确引用锚点 |

流式请求的标准格式：

```json
{"messages":[{"role":"user","content":"当前对象有什么施工要求？"}],"context":{"unit":"ALL","scope":"ALL","projectId":"project-001","object":{"id":"A-01"}},"knowledge":{"enabled":true,"mode":"auto","unit":"ALL","groupId":"all","documentIds":[]}}
```

后续轮次传入 `conversationId`，只提交最新用户问题即可由服务端带入已完成的历史。`reasoning` 为 API 实际返回，独立存储且不回灌历史消息。`knowledge` 模式返回原文摘录，不调用模型；未命中不会扩大检索范围。

通用宿主使用 `unit/scope: ALL`。WT/RD/CL/SS 是扶余工程的可选适配值，不是所有孪生系统的必选领域。通用业务字段放入 `host`，上下文不接受凭据字段。当前是单机组件实例级隔离，不宣称多租户权限：每个项目应使用独立数据根目录/组件实例。不要仅凭 `projectId` 将多个资料库混放后期待权限隔离。

引用包含 documentId、itemId、citationVersion、page 和可选 bboxNormalized。只把完整锚点传给 `/locate`；不要自己用标题、页码首段或模型输出猜测段落。有真实坐标才显示高亮。浏览器阅读器与扶余前端共享来源校验和 PDF.js 坐标转换实现。

## 外部 API 直接调用

默认只供本机同源界面使用。跨来源/原生 API 接入需要配置 `FUYU_PLUGIN_TOKEN`（32–256 位非空白 ASCII）并使用 `Authorization: Bearer ...`；跨来源浏览器还必须位于上述 allowedOrigins 列表。令牌保留在进程环境，适配器只保存摘要，不通过 URL、manifest 或 iframe 消息传递。

```javascript
const api = new TwinKnowledge.Client({baseUrl:'http://127.0.0.1:8779', token: integrationToken});
await api.upload(file, {unit:'ALL', groupId:''});
await api.stream(request, {signal:abortController.signal, onEvent(event){/* 更新宿主自己的 UI */}});
```

宿主原生后端可用相同 API 实现 UI 替换。`allowConfiguration:false` 时，外部请求不能修改模型/解析设置，用户在组件本机设置中操作；只有明确配置 `true` 才开放外部配置权限。CORS 不启用通配来源或 credentials。模型密钥和集成令牌是两种凭据；不要把模型 API Key 当作宿主连接令牌。

## 构建

`build_assets(root)` 从当前 `开发源码/system-settings.*` 和 `knowledge-ui.*` 生成 shared 文件，确保主程序和插件共用 API 编辑、资料解析和 PDF 定位修复。widget 本身只负责对话显示与宿主桥接。EXE 必须包含整个 `plugin/` 与 `lib/` 静态资源目录。
