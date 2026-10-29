# SpecFlow 知识组件

派生自 Maskicruis/specflow-engineering-studio，版本 0.11.1，提交 b076c50fe5df28c628f97b5eafa052c1dff0188b。原项目 package.json 声明 MIT；作者 Maskicruis。

保留原文件存储、MinerU 解析流水线、文档分组、混合检索、问答、SSE 思考和回答、会话历史及精确引用 PDF 阅读器。删除项目工作区、清单、工程设计工具、规范网站监控、Harness、余额及原应用更新模块。

核心文件与 UI 模块逐文件来源及 SHA256 见 UPSTREAM-BACKEND.json 和 ui-provenance.json。桌面启动器仅负责独立数据路径、窗口、目录选择与服务生命周期；不改写解析和模型实现。Logo 与图标沿用原 SpecFlow，已获用户许可。

MinerU 及其模型仍是外部运行依赖，需在设置中选择可执行文件。此 EXE 包含 Electron/Node 和知识组件，不包含 OCR 模型。模型 API 设置、资料原件与会话仅保存在该组件自己的 workspace；API 密钥的存储行为沿用 SpecFlow 原版，请勿上传 workspace/data/settings.json。
