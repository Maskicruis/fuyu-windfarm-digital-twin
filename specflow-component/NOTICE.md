# SpecFlow 知识组件

派生自 Maskicruis/specflow-engineering-studio，版本 0.11.1，提交 b076c50fe5df28c628f97b5eafa052c1dff0188b。原项目 package.json 声明 MIT；作者 Maskicruis。

保留原文件存储、MinerU 解析流水线、文档分组、混合检索、问答、SSE 思考和回答、会话历史及精确引用 PDF 阅读器。删除项目工作区、清单、工程设计工具、规范网站监控、Harness、余额及原应用更新模块。

核心文件与 UI 模块逐文件来源及 SHA256 见 UPSTREAM-BACKEND.json 和 ui-provenance.json。1.1.2 对解析、检索、回答模式和阅读器作适配：新增文字层快速提取、独立 OCR 队列、SQLite FTS5 索引、证据分支、PDF 分段读取与单实例后台服务；未修改模块和已适配模块分别登记，不能将整个组件称为逐字节未修改。Logo 与图标沿用原 SpecFlow，已获用户许可。

1.0–1.2 版需另行配置 MinerU 及 OCR 模型；1.3 及以后通过固定版本资源包配套离线引擎与默认模型。文字 PDF 使用 PDF.js；PDF.js 及 CMaps/standard_fonts 来源为 pdfjs-dist 6.3.289，保留 Apache-2.0 和各字体许可。EXE 包含 Electron/Node 和知识组件，引擎与模型通过同源资源清单安装。模型 API 设置、资料原件与会话保存在该组件自己的 workspace；API 密钥的存储行为沿用 SpecFlow 原版，请勿上传 workspace/data/settings.json。

1.2.0 增加全库文档均衡召回、跨规范综合提示、覆盖统计和独立桌面启动修复。--background 是应用后台参数；兼容旧 --headless，但在 Chromium 初始化前移除该浏览器开关，防止原生窗口被禁用。

1.3.0 使用 MinerU 3.4.5 提供随包离线解析，独立进程运行 CPython 3.12.7、CPU PyTorch、OCR/版面/表格模型。其代码、二进制、模型及预置规范不由本项目 MIT 许可重新授权；保留各 Python 包的 dist-info 许可证、MinerU Open Source License、PDF-Extract-Kit 模型卡及 AGPL-3.0、Apache-2.0 文本。模型来源：https://huggingface.co/opendatalab/PDF-Extract-Kit-1.0；Python 来源：https://www.python.org/ftp/python/3.12.7/。源码中的资源构建脚本用于复现分包，不复制用户设置或会话。规范来自用户提供的71份原件，保留原出版信息及权利声明。

1.3.1 对 MinerU 3.4.5 的 processing-window 流程添加 JSON 检查点、恢复与进度事件钩子，同时保留上游版权声明。可复现修改脚本与辅助代码位于 engines/apply_patches.py、engines/checkpoint.py，随 EXE 和源码一起提供。没有将这些适配描述为未修改的上游代码。
