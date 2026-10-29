# 扶余一号 · 风电建设数字孪生 V11.0 桌面版

三维风场展示、界面控制后台、工程知识库与上下文智能体。默认仅在本机运行；GitHub 用于管理代码、文档与版本，并不自动把本机资料库部署到互联网。

当前交付为 `00工作区/扶余一号数字孪生/扶余一号数字孪生.exe`，已包含 Python 运行环境及界面资源。双击后在桌面窗口顶部切换展示大屏、控制后台、知识与智能体、API 与解析设置。当前电脑已验证 Edge WebView2 内嵌窗口；引擎不可用时提供浏览器入口。

API 类型、模型名称、根地址和新密钥均可编辑。接口类型支持 DeepSeek 与 OpenAI 兼容接口；HTTP 地址仅用于本机回环服务。输入新 Key 后保存会替换密钥，留空沿用已保存的密钥；先保存再测试，测试支持取消。

桌面工作目录为 EXE 旁的 `workspace/data/`，原有资料、会话与界面配置已迁入，升级前备份在 `数据备份/`。更新时替换 EXE 并保留 workspace。密钥继续由 Windows 账户加密保存，不嵌入 EXE。

独立组件使用 `扶余一号数字孪生.exe --plugin-only` 启动，不加载风场三维和界面编辑系统。其他项目以 `--data-dir <工作目录>` 使用独立资料库。版本化 API、浮窗 SDK、上下文与定位事件协议见 [组件接入文档](plugin/README.md)。

## 从源码运行

1. 安装 Python 3.11+；原电脑可继续使用现有启动脚本找到的运行时。
2. `python -m pip install -r 开发源码/requirements.txt`，安装文字 PDF 提取依赖。TXT/MD/DOCX/XLSX 使用标准库解析。
3. 双击 `启动控制后台.cmd` 或 `打开前端展示.cmd`。默认端口 8779；占用时自动选择其他端口，启动器会打开实际地址。
4. 前台顶部“设置”配置 API Key、接口类型、地址、模型、回复长度、记忆轮数与场景上下文。“资料导入与解析”进入知识库。源码调试使用自己的数据根目录；正式数据位于桌面交付的 workspace。

扫描 PDF、图片 OCR 需要另行安装 MinerU，在知识库“解析设置”选择可执行文件。仓库不包含 OCR 模型或 MinerU 环境；引擎缺失或解析失败会显示真实状态，不能把未解析文档当作可检索资料。

## 两个交付界面

| 界面 | 职责 |
|---|---|
| `frontend.html` | 展示孪生场景、全场播放、对象/工序浏览；配置模型；导入与解析知识资料；使用独立悬浮智能体 |
| `admin.html` | 调整组件与文字、布局、样式、对象数据、草稿与发布；管理扫描件、知识库与外部数据接口 |

后台“系统管理 → 数据接口”支持 GET JSON 接口、字段映射与连接测试。通过校验后“应用到草稿”，不会自动发布。HTTP 仅允许本机回环地址；远程接口使用 HTTPS。接口密钥单独加密保存。

## 知识与引用流程

导入原件 → 持久化后台队列 → 原生提取/MinerU → 按工程、分组、指定文档检索 → 资料增强问答 → 引用原文核查。

- 同一悬浮智能体支持资料增强问答、仅资料库检索、通用对话；没有第二个问答页面。
- “仅资料库”明确返回原文摘录，不调用模型；无命中不会自动扩大分组。
- 引用沿用 SpecFlow 的文档、解析版本、内容块及页码校验方式，核对通过后才打开原文。旧引用失效时提示重新检索，不跳到同页首段或其他内容块。
- PDF 使用随程序附带的 PDF.js 显示原件和真实页码，有有效坐标时高亮对应内容块；支持缩放、翻页和“返回引用”。原生 PDF 提取没有坐标时不生成高亮。TXT、DOCX、XLSX 按对应解析片段定位。
- 资料可以关联单位工程、对象与工序。用户明确点击“定位工程”后，才跳转到已登记的三维对象；不执行模型返回的任意命令或地址。
- 完成的对话保存在本机，刷新后可通过“本机对话”恢复；切换上下文取消本页旧请求，迟到回答不会覆盖当前对话。
- 模型的思考与回答通过 SSE 实时逐段显示。“深度思考”开启且 API 返回思考内容时，可展开查看；不生成预设思考过程。思考内容独立保存，不作为下一轮用户提问的历史正文发送。
- 质量通病、危大工程、验收标准保留界面直观提示；资源、工艺与质量要点由智能体承担。施工模拟保持独立。

## 数据与配置

`config/default-ui.json` 为新安装的初始布局；已有 `data/draft.json`、`data/published.json` 优先，更新不会覆盖本机配置。`config/object-catalog.json` 约束外部接口可更新的场景对象。

`data/` 保存布局草稿、发布历史、扫描件、知识原件/解析/SQLite、会话和项目普通参数，全部排除 Git。DeepSeek API Key 使用 Windows DPAPI 加密，保存在当前 Windows 账户的 `%LOCALAPPDATA%/FuyuUIStudio/credentials/deepseek.key`；模型等普通参数也保存在该账户目录。页面只显示密钥是否已保存，不回传原始密钥。

刷新、重启服务或在同一 Windows 账户下移动项目目录后，可继续读取已保存的 DeepSeek 配置。升级时会自动迁移旧项目密钥及参数；主动清除密钥后不会从旧副本恢复。更换 Windows 账户或电脑时需重新配置密钥。外部数据接口的凭据仍按项目单独加密保存，与 DeepSeek 配置分开。

模型问答会把提问、所选对话历史、启用的场景上下文及命中的知识片段发送到已配置的 DeepSeek 服务。原件不自动上传到模型，解析在本机进行。关闭“自动场景上下文”不等于关闭用户主动选择的知识库检索。

当前为单机后台，没有多用户身份与权限隔离。三维、位置与初始进度是示意，界面数据不代表实时现场或审批验收结论。

## 开发与验证

```powershell
python -m pip install -r 开发源码/requirements.txt
npm install
npm test
python scripts/test-backend.py
python 开发源码/build.py
python 开发源码/package_delivery.py
# Windows 构建环境另需安装 PyInstaller、pywebview；用户端无需安装。
python scripts/build-exe.py
```

源码集中于 `开发源码/`；`build.py` 将界面模块打包为两份 HTML。本机运行请保留完整程序目录，包含 `lib/` 中的 PDF.js 主模块、工作线程和许可文件。Node.js 仅用于构建语法检查与 DOM 测试。CI 在 Windows、Python 3.12 与 Node.js 24 上执行相同功能检查。

交付脚本校验 EXE 并汇总本次后端与 UI 测试，生成使用说明、组件接入资料和交付验证记录。已验证 EXE 的窗口启动、API 编辑保存与真实 DeepSeek 连接，以及独立组件的导入、解析、检索和原文定位。扫描件 OCR 的实际 MinerU 环境仍需另行安装验证。

后续更新：修改源码 → 测试 → 构建 → Git 提交和推送。更新部署目录前备份 `data/`；导出 UI JSON 不能替代知识原件与扫描件备份。

## 技术参考

参考 [SpecFlow Engineering Studio](https://github.com/Maskicruis/specflow-engineering-studio/tree/b076c50fe5df28c628f97b5eafa052c1dff0188b) 的解析队列、分组检索、来源定位和本机服务组织方式。引用高亮使用其规范化坐标到 PDF 页面及视口的转换方式，并兼容 PDF.js 的视口矩阵。Three.js 许可见 `Three.js_LICENSE.txt`；PDF.js 许可与说明见 `lib/PDFJS_LICENSE.txt`、`lib/PDFJS_NOTICE.txt`。

桌面打包依据 [PyInstaller 运行资源机制](https://pyinstaller.org/en/stable/runtime-information.html) 和 [pywebview Windows 打包方式](https://pywebview.flowrl.com/guide/freezing)。构建时保留运行时所需证书策略资源，HTTPS 证书校验继续生效。
