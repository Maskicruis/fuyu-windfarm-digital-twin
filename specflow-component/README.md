# SpecFlow 知识组件 1.3.2 · 规范与离线解析完整版

独立运行的文件存储、PDF 解析、规范检索、连续问答与原文阅读组件。基于 SpecFlow 0.11.1 裁剪，并针对批量规范处理作适配；保留 SpecFlow 图标、流式客户端、会话渲染及引用数据契约。

[下载 EXE、资源与快速入门](https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/tag/component-v1.3.2) · [接入接口](integration/README.md)

完整版预置「施工验收规范」71 份 PDF 原件、已解析内容与持久化索引，以及独立 CPython 3.12.7、MinerU 3.4.5、CPU PyTorch、中文 OCR、版面和表格模型。无需另装 Python、MinerU 或下载默认解析模型。

## 完整下载与默认数据库

本版 Release 直接提供 EXE、解析引擎和默认数据库，资源不再放在旧版发布页。下载下面全部 5 个文件，放在同一文件夹，双击 EXE；程序自动校验、解压并登记资料，无需安装 Python、MinerU 或另外下载默认模型。也无需再手动导入这些规范。

| 文件 | 内容 |
| --- | --- |
| [SpecFlow-Knowledge-Component-1.3.2-x64.exe](https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/download/component-v1.3.2/SpecFlow-Knowledge-Component-1.3.2-x64.exe) | 独立桌面程序 |
| [SpecFlow-1.3.2-Parsing-Engine-Windows-x64.zip](https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/download/component-v1.3.2/SpecFlow-1.3.2-Parsing-Engine-Windows-x64.zip) | 解析引擎、CPython、CPU PyTorch、中文 OCR、版面、表格模型与运行库 |
| [SpecFlow-1.3.2-Default-Database-01.zip](https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/download/component-v1.3.2/SpecFlow-1.3.2-Default-Database-01.zip) | 默认数据库第 1 包 |
| [SpecFlow-1.3.2-Default-Database-02.zip](https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/download/component-v1.3.2/SpecFlow-1.3.2-Default-Database-02.zip) | 默认数据库第 2 包 |
| [SpecFlow-1.3.2-Default-Database-03.zip](https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/download/component-v1.3.2/SpecFlow-1.3.2-Default-Database-03.zip) | 默认数据库第 3 包 |

只下载 EXE 时，联网启动会自动获取同一发布页的上述资源包；下载全部 5 个文件后，可完全离线完成安装。建议至少留出 12 GB 空间用于资源包、解压后的程序和资料。首次安装显示当前包及文件进度。

默认数据库包含用户提供的 **71 份施工验收规范 PDF 原件**，默认分组为「施工验收规范」。[在 GitHub 查看全部规范目录](presets/施工验收规范目录.csv)。资源快照中 **66 份已预解析并带 SQLite 检索索引**，可直接检索；其余 5 份原件同样随包、可阅读，首次运行继续后台 OCR，完成后自动加入检索。不会将尚未解析的文件计入已读证据。

新增材料：打开「文档数据库 → 导入文档」，上传 PDF，或用「导入规范文件夹」批量追加。可以新建分组；不会替换默认规范库。个人新增资料、API 密钥和会话仅保存在本机，不会上传 GitHub。升级时保留已有资料及修正内容。

## 开始问答

1. 双击 EXE，等待首次资源安装；打开「文档数据库」可查看预置的 71 份规范。
2. 在「设置 → 模型接口」填写接口地址、模型名和密钥并保存。修改地址或模型时，密钥留空会保留原值；清除需使用单独按钮。
3. 选择回答模式并提问。严格规范模式只使用实际检索到的文件证据；引用可跳转 PDF 原文页并高亮。PDF 页码可能不同于书籍印刷页码。

| 回答模式 | 有相关资料 | 没有相关资料 |
| --- | --- | --- |
| 通用模型 | 不检索资料库，使用对话历史 | 使用通用模型 |
| 严格规范 | 仅按检索片段回答并附引用 | 说明依据不足 |
| 智能回答 | 按相关资料回答，明确未覆盖内容 | 切换通用回答并标明来源分支 |

## 解析状态与自动恢复

界面显示已完成页数、当前步骤、用时、输出活跃状态和已保存检查点。连续 5 分钟无输出，或 15 分钟没有完成新页面，会终止本次引擎并在队尾自动恢复一次；再次失败会保留原因，继续处理其他文件。每 8 页保存检查点，重启后按原件 SHA256 与解析选项匹配，从已保存页面之后继续。关闭程序会停止当前解析，下次启动继续；已完成文件可随时检索。

1.3.2 使用同一 Release 内独立命名的引擎包和数据库包。已有完整本地资料库与引擎时沿用现有文件；数据库资源补齐缺失的预置内容，不覆盖用户修正或自建资料。

## 大量文件的处理方式

- 文件上传流式写入本地，复制、文字提取、OCR 结果打包和索引写入在异步任务或工作线程中完成。
- 文字提取与 OCR 各一条队列，避免大扫描件挡住文字 PDF。退出后保留任务记录，下次启动继续排队；中断文件可能重新解析。
- SQLite FTS5 持久化倒排索引，重启复用，只更新新增或变更的文档。每轮从每份已索引文件召回候选，采用跨文档轮询分配证据，避免一本长规范挤掉其他文件；连续编号条文可连带后续子项。每轮无需重新解析全部 PDF。
- 资料回答按主题综合不同规范，区分适用对象；存在差异时分别引用，不自行拼接数值或认定某规范优先。相关性筛选后提供有限证据上下文，并非把整库原文全部传给模型。
- 每轮显示全库总量、实际检索文件数、相关文件及证据来源数、待解析数量。引用来源少，不表示只搜索了这些文件；无关资料不会强行作为依据。
- PDF 阅读按 HTTP Range 分段加载；文字面板只读取目标页附近内容，避免先下载整份大 PDF。
- 左下角显示已索引/全部文件数量、后台任务数；每份文件保留状态与失败原因。检索耗时与模型首字耗时单独显示，模型和网络耗时不属于本地索引耗时。

开发阶段已用 71 份、约 2.22 GB PDF 验证批量导入和后台队列。1.2.0 在 49 份已建立索引规范上，对混凝土养护多主题问题执行三轮全库协同检索，耗时 1695 / 707 / 778 ms；32 个证据片段覆盖 27 份相关文件，真实 DeepSeek 回答对不同适用对象分别引用。该样本不是任意文件规模或查询下的性能保证，模型生成与网络耗时另计。其余 22 份扫描资料当时仍在 OCR，未被宣称已读；解析完成后自动加入检索。

## 数据、OCR 与适用边界

记录、配置与会话采用临时文件写入后原子替换保存；数据目录设占用保护。便携包每次启动使用独立临时目录，避免另一个进程退出时清理当前进程的资源。

数据默认位于 EXE 同目录 `workspace/data` 和 `workspace/资料库`，API 设置、文档、索引与会话重启后沿用。预置原件和解析内容也安装到资料库；资源包不会覆盖用户的 API 设置或聊天历史。组件默认绑定 127.0.0.1，不依赖数字孪生 EXE。后台启动参数与外部接入见 integration/README.md。

文字 PDF 直接使用随 EXE 的 PDF.js。默认扫描解析使用随资源包的 MinerU pipeline CPU 引擎，中文 OCR、版面和表格模型均从本地加载，无需依赖开发电脑的 Python、用户缓存或盘符。高级公式与 VLM 是外部引擎扩展，不包含其大型模型；使用这些模式需在设置中指定相应引擎。文字层提取优先保证快速查找与原文坐标，复杂表格或字符异常应在原 PDF 核对，并可切换 OCR 重解析。少量可复制水印不等于完整文字层，稀疏文字 PDF 会转入 OCR。

当前支持导入 PDF；其他格式需先转换 PDF。检索相关性判定和引用编号检查用于减少无依据回答，不能证明每句话语义正确，也不会自动确认规范现行有效性。可点击原文核查适用范围与数值。

API 密钥沿用 SpecFlow 的本地设置存储方式，不写入公开交付。发布资源只包含筛选后的预置规范、解析内容、索引与引擎，不包含用户 API 密钥、会话或设置文件。用户数据位于 `workspace`，不要将该目录上传 GitHub。项目源码为 MIT；规范原件及第三方引擎、模型保留各自许可，见 NOTICE.md、随包 `engines/third-party-notices` 和各 Python 包的许可证。

## 开发

Node.js 24；`npm ci --prefix specflow-component`，`npm test --prefix specflow-component`，`npm run build --prefix specflow-component`。Windows x64 portable 包包含 Electron/Node 和 PDF.js；原 SpecFlow 的非知识库业务已移除。

资源构建脚本为 `scripts/build-specflow-resources.py`，输入已安装的固定版本引擎、模型和规范库，生成不含私密设置的资源分包及校验清单。`--direct` 直接从原件和引擎源目录生成分包，建议输出到本地 SSD，避免在 U 盘内重复拷贝大文件；`--archives-only` 可从已准备目录重新生成分包。将生成的 `resources-manifest.json` 复制到组件工程后再构建 EXE；分包与源码、EXE 一起发布到同一版本的 Release。开发验收可用 `--no-bundle` 跳过预置资源安装，正常用户启动无需此参数。
