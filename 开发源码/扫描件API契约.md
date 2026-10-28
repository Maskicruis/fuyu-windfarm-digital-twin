# 本机施工扫描件 API（V9.1）

服务器仍只监听 `127.0.0.1`。原 `/api/state`、`/api/draft`、`/api/publish`、`/api/restore`、`/api/published` 保持兼容。

## 目录范围

`unit`、`branch` 为必填查询字段，目录 `category` 使用两位字符串 ID，不能省略前导零。

| unit | branch | 目录 |
|---|---|---|
| WT | main | 00设计文件、01管理体系、02施工管理、03材料、构件、04施工及验收、05单位工程验收、06统计汇总 |
| RD | main | 00设计文件、01管理体系、02施工管理、03材料、构件、04施工及验收 |
| CL | main | 00设计文件、01管理体系、02施工管理、03材料、构件、04施工记录、05试验报告、06验收记录、07统计汇总 |
| SS | civil | 00设计文件、01管理体系、02施工管理、03材料、构件、04施工记录、05验收记录、06统计汇总 |
| SS | install | 00设计文件、01管理体系、02施工管理、03安装记录、04电气设备试验、05验收记录、06统计汇总 |

## 列表

`GET /api/documents?unit=SS&branch=civil&category=00`

`category` 可省略；返回该工程分支内全部类别的记录。成功返回：

```json
{"unit":"SS","branch":"civil","categories":[{"id":"00","name":"设计文件"}],"documents":[]}
```

实际 `categories` 数组包含该分支全部目录。默认 `documents` 为空，不生成正式文件样例。

## 单个文件上传

`POST /api/documents?unit=WT&branch=main&category=00&filename=...&label=...`

请求体直接提交浏览器 `File`，不是 JSON，也不是 multipart。URL 字段由 `URLSearchParams` 编码。`Content-Type` 可为文件真实 MIME；当 Windows 未提供 MIME 时可用 `application/octet-stream`。

```js
const params = new URLSearchParams({
  unit: 'WT', branch: 'main', category: '00',
  filename: file.name, label: '风机基础设计图扫描件',
  documentCode: 'WT-SJ-001', version: 'V1',
  recordDate: '2026-10-28', objectId: 'F08', process: 'WT-07', notes: ''
});
const response = await fetch('/api/documents?' + params, {
  method: 'POST', headers: {'Content-Type': file.type || 'application/octet-stream'}, body: file
});
const result = await response.json();
```

成功 HTTP 201，返回 `{ok:true,document:{...}}`。单文件上限 **40 MiB**。支持 PDF、JPEG（`.jpg/.jpeg`）、PNG、WEBP；校验文件签名、扩展名与 MIME 一致。流式写入生成 UUID 文件名并计算 SHA-256，不使用用户文件名构造磁盘路径。

## 元数据修改

`PUT /api/documents/{id}`，请求体为 JSON。可提交任意下列字段的子集：

- `label`：资料名称，1—240 字符。
- `unit`、`branch`、`category`：修改后必须仍为有效的目录组合。
- `documentCode`（160字符）、`version`（80字符）、`objectId`（160字符）。
- `recordDate`：有效 `YYYY-MM-DD` 或空字符串。
- `process`：该工程已有工序码或空字符串；范围为 WT-01—24、RD-01—17、CL-01—21、SS-01—30。
- `notes`：4000 字符内的人工备注。
- `archiveStatus`：`registered` 或 `archived`，可逆。

上传时这些字段也可放在查询参数中；`label` 未提供时采用文件名。兼容 `title` 作为 `label` 别名，二者同时出现须一致。

响应中的 `reviewStatus` 固定为 `pending_manual`，不提供设置核验通过或验收通过的接口；人工核验情况可写入 `notes`。`filename`、`id`、`mime`、`bytes`、`sha256`、登记时间不可通过 PUT 改写。**无删除接口**，DELETE 返回 405。

## 预览与下载

- `GET /api/documents/{id}/file`：按实际 MIME 内联预览。
- `GET /api/documents/{id}/file?download=1`：按原文件名下载。
- 支持 HEAD、单区间 Range（206）、无效区间（416），方便 PDF 预览。

每条 `document` 返回：

`id,unit,branch,category,label,filename,mime,bytes,sha256,documentCode,version,recordDate,objectId,process,notes,archiveStatus,reviewStatus,uploadedAt,updatedAt,sourceType,fileUrl,verificationNote`。

`sourceType` 为 `local_upload`。`verificationNote` 明确说明扫描件真实性、完整性及验收结果待人工核验。浏览器中所有用户文本应通过 `textContent` 展示，不解释为 HTML。

## 本地持久化与限制

登记表：`data/documents/index.json`；原件：`data/documents/blobs/{UUID}.{规范扩展名}`。附件独立于 UI 配置、草稿和发布版本；上传不改动既有界面配置。服务重启可恢复登记表。

JSON 元数据更新沿用同源 Origin、Host 和 2 MiB 请求限制；附件上限单独为 40 MiB。目录与文件路径不可自定义，静态路由不开放 `data`；文件只能经 UUID 接口读取。测试仅在临时目录上传样例，不向真实项目档案写入样例。
