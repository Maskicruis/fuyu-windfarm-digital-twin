# 独立知识组件接入

EXE 独立运行文件存储、MinerU 解析队列、分组、检索、会话、模型设置及原文阅读器。原项目的 `/api/v1` 和 schema 契约保留，能力发现见 `/api/v1/capabilities`。服务绑定 127.0.0.1；运行端口写在 EXE 同目录 `workspace/data/component-service.json`。默认 8790，冲突时自动选择空闲端口。

```powershell
.\SpecFlow-Knowledge-Component-1.0.0-x64.exe --headless --data-dir "G:\其他项目\知识数据" --port 8791
```

`--data-dir` 是包含 settings.json、documents.json 等文件的直接数据目录。各项目使用不同目录；API 设置与历史会话在重启后沿用。

Node/桌面宿主使用 `client.cjs`，同目录保留 `../ui-modules/stream-client.js`，直接复用原版 SSE 客户端。浏览器可同源嵌入 `http://127.0.0.1:端口/`，或通过宿主自己的受认证网关转发接口。跨来源默认关闭；部署到多人服务器前应由宿主提供访问控制，避免直接暴露本地设置接口。

```js
const {SpecFlowKnowledgeClient}=require('./client.cjs');
const client=new SpecFlowKnowledgeClient('http://127.0.0.1:8790');
await client.askStream({question:'请核查该工序要求',conversationId:'',retrievalMode:'knowledge',docIds:[]}, event=>{
  // 原始事件：reasoning / delta / citations / done。不要用计时器模拟输出。
  console.log(event);
});
```

主要接口：

| 用途 | 接口 |
| --- | --- |
| 文件导入与排队 | POST /api/v1/jobs（二进制 PDF + X-File-Name） |
| 解析状态 | GET /api/v1/jobs/:id |
| 文件分组 | GET/POST /api/v1/groups |
| 检索 | GET /api/v1/search?q=…&doc=…&group=… |
| 连续对话 | POST /api/v1/ask/stream（沿用 conversationId） |
| 会话恢复 | GET /api/v1/conversations/:id |
| 精确定位所需块与坐标 | GET /api/v1/documents/:id/content |
| 原 PDF | GET /api/v1/documents/:id/source |
| 原版引用跳转 | /?openCitation=1&doc=…&page=…&item=…&bbox=… |
| 模型和解析设置 | GET/PATCH /api/v1/settings（仅可信本地管理端） |

当前上下文是原版会话历史、分组/文档范围。数字孪生宿主可把经核验的对象、位置、工序作为问题背景传入；三维对象的定位由宿主依据文档 ID / 内容块 ID 的映射处理，不执行模型生成的脚本或任意坐标。PDF 跳转沿用原版页码、内容块与 bbox，不猜测高亮区域。

独立组件沿用 SpecFlow 原版 PDF 导入和 MinerU 解析方式，不将其他文件类型伪装成已支持。其他格式可由宿主先转换 PDF，再通过同一导入接口处理。
