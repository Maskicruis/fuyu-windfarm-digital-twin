# 独立知识组件接入

EXE 独立运行文件存储、MinerU 解析队列、分组、检索、会话、模型设置及原文阅读器。原项目的 `/api/v1` 和 schema 契约保留，能力发现见 `/api/v1/capabilities`。服务绑定 127.0.0.1；运行端口写在 EXE 同目录 `workspace/data/component-service.json`。默认 8790，冲突时自动选择空闲端口。

```powershell
.\SpecFlow-Knowledge-Component-1.3.2-x64.exe --background --data-dir "G:\其他项目\知识数据" --port 8791
```

`--data-dir` 是包含 settings.json、documents.json 等文件的直接数据目录。各项目使用不同目录；API 设置与历史会话在重启后沿用。同一数据目录只启动一个后台服务；后台模式运行时再次双击同目录 EXE 会打开已有服务的窗口。后台模式关闭窗口仍继续解析；普通双击启动时关闭窗口会退出并保留队列。

Node/桌面宿主使用 `client.cjs`，同目录保留 `../ui-modules/stream-client.js`，直接复用原版 SSE 客户端。浏览器可同源嵌入 `http://127.0.0.1:端口/`，或通过宿主自己的受认证网关转发接口。跨来源默认关闭；部署到多人服务器前应由宿主提供访问控制，避免直接暴露本地设置接口。

```js
const {SpecFlowKnowledgeClient}=require('./client.cjs');
const client=new SpecFlowKnowledgeClient('http://127.0.0.1:8790');
await client.askStream({question:'请核查该工序要求',conversationId:'',retrievalMode:'knowledge',searchScope:'all'}, event=>{
  // 原始事件：reasoning / delta / citations / done。不要用计时器模拟输出。
  console.log(event);
});
```

主要接口：

| 用途 | 接口 |
| --- | --- |
| 文件导入与排队 | POST /api/v1/jobs（二进制 PDF + X-File-Name） |
| 本地文件夹批量导入 | POST /api/v1/import/folder，JSON `{directory,groupId}`；异步复制，返回 jobs/skipped |
| 索引与两条解析队列状态 | GET /api/v1/health，index / queue / ocrQueue |
| 解析状态 | GET /api/v1/jobs/:id |
| 文件分组 | GET/POST /api/v1/groups |
| 检索 | GET /api/v1/search?q=…&doc=…&group=… |
| 连续对话 | POST /api/v1/ask/stream（沿用 conversationId） |
| 会话恢复 | GET /api/v1/conversations/:id |
| 精确定位所需块与坐标 | GET /api/v1/documents/:id/content |
| 原 PDF | GET /api/v1/documents/:id/source |
| 原版引用跳转 | /?openCitation=1&doc=…&page=…&item=…&bbox=… |
| 模型和解析设置 | GET/PATCH /api/v1/settings（仅可信本地管理端） |

当前上下文沿用原版会话历史，界面默认固定全库。数字孪生宿主可把经核验的对象、位置、工序作为问题背景传入；三维对象的定位由宿主依据文档 ID / 内容块 ID 的映射处理，不执行模型生成的脚本或任意坐标。PDF 跳转沿用原版页码、内容块与 bbox，不猜测高亮区域。

回答模式 `general` 跳过检索，`knowledge` 仅按资料回答且无依据不调用通用模型，`auto` 有证据时走严格资料分支、无证据时走通用模型。`done.grounding` 为 `knowledge/general`；`done.timings` 包含 retrievalMs、firstTokenMs、totalMs。流式 `reasoning` 是提供方返回的内容，前端不得模拟；只在提供方实际返回时展示。

检索用持久化 SQLite FTS5，索引初次建立时可返回 INDEX_BUILDING，通用模式仍可使用。扫描件 OCR 在后台排队，`ready` 文件才参与检索。原文阅读使用 source 接口的 HTTP Range，精确定位保留 docId/page/itemId/bbox/bboxNormalized；页码从 1 开始，使用 PDF 文件页码。宿主不得把页码或三维位置从模型自然语言中随意猜测出来。

当前导入 PDF，先做文字层提取，扫描件由 MinerU 处理。其他格式可由宿主先转换 PDF，再通过同一导入接口处理。此组件以独立 Release 发布；数字孪生主程序的在线更新清单保持独立。

1.2.0：界面问答始终发送 `searchScope:"all"`，忽略历史 docIds/groupId 限制。API 保留显式范围能力；传 searchScope:all 会覆盖文档、分组限制。响应 retrieval.coverage 提供 totalDocuments/indexedDocuments/pendingDocuments/searchedDocuments/relatedDocuments/evidenceDocuments。原始 search 接口为检索工具；问答会对全库每份已索引文件公平召回候选，再按相关性组合跨文档依据。

离线资源安装可加 `--offline-resources`；该参数禁止缺包时自动联网下载。预置库与引擎的 ZIP 应放在 EXE 旁，首次启动自动安装。
