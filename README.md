# 扶余一号数字孪生 · V12 统一施工工作台

当前交付在 G:\中车扶余数字孪生\00工作区。源码以本目录为准，GitHub 仓库为 https://github.com/Maskicruis/fuyu-windfarm-digital-twin ，沿用原有私有权限。

## 两项交付

1. `../扶余一号数字孪生/扶余一号数字孪生.exe`：展示前端、拖拽控制后台、设置、悬浮智能体及现有三维场景。
2. `../知识与大模型独立组件/SpecFlow-Knowledge-Component-1.0.0-x64.exe`：从 SpecFlow 原工程直接裁剪，只保留文件存储/解析、分组检索、LLM、流式输出、会话和精确引用阅读器。其源码在 `specflow-component/`，来源和未修改文件哈希见该目录的 provenance 文件。

## 统一界面

风机、场内交通、集电线路、升压站均采用同一工作台，不再有“施工模拟演示 / 施工管理辅助 / 施工资料记录”的二级页面切换。

- 左侧：对象目录、筛选、施工资料记录。
- 中间：工程/对象/工序背景、三维模型、工序简介、场景操作。
- 底部：当前阶段的真实工序卡片、播放/暂停、关键部位、工艺流程；风机保留三维拆解。
- 右侧：八个工序知识入口、当前工序提示、计划/实际进度、关联资料。
- 顶部：四类单位工程与项目总览、知识库、AI 助手、控制后台、设置。

资料、知识卡和工艺流程在当前工作台弹出，保留场景位置。工序名称及编码沿用全流程分解表 20260426，不将参考图中的八个示意步骤强行替换原项目 WBS。模型和进度仍为原有示意数据；工序缩略图为示意图。未登记的文件显示空状态。

## 控制后台

顶部“控制后台” → 选择单位工程 → “选取与编辑”。从左侧组件树选择面板，再拖动画布上的青色标签；右下角手柄调整尺寸。“内容”页可逐段编辑标题、按钮和提示；“数据”页编辑对象进度/状态；“布局/样式”调整位置和外观。保存草稿后点“发布前端”，展示端读取发布内容。支持撤销、导入/导出及发布历史。

旧布局带有 module-nav 标记的坐标在载入时迁移，保留文字/样式及对象数据；发布后使用新布局。原始资料和服务配置不重建。

## 设置和数据

展示端“设置”包含项目显示名称、副标题、数据基准日期、默认工程、模型 API 和资料导入/解析入口，并提供 GitHub 源码和发布页链接。项目基本参数单独保存；修改默认工程在下次启动时生效。API 密钥留空保存会沿用已有密钥，修改地址/模型后先保存再测试。密钥不写入 UI 导出配置。

数字孪生的数据在 EXE 同目录 `workspace/data`；主系统 API 凭据由当前 Windows 账户加密保存。独立 SpecFlow 组件使用自己的 `workspace/data` 和资料库，设置存储方式沿用 SpecFlow；勿上传数据目录到 GitHub。更新时替换对应 EXE，保留 workspace。

独立组件使用原版 MinerU 流程，目前导入 PDF；OCR 模型不打包进 EXE。在设置中选择已安装的 MinerU。对外接口、连续对话和引用定位见 `specflow-component/integration/README.md`。主系统现有知识库支持的格式与独立组件不同，各自说明以实际接口为准。

## 开发、测试、打包

```powershell
python -m pip install -r 开发源码/requirements.txt
npm ci
python scripts/test-backend.py
npm test
python 开发源码/build.py
python scripts/build-exe.py

npm ci --prefix specflow-component
npm test --prefix specflow-component
npm run build --prefix specflow-component
```

主系统 EXE 打包环境另需 PyInstaller、pywebview 和 pythonnet。SpecFlow 组件打包使用 Electron 44.3.0 / electron-builder 26.15.3。两者均不要求最终使用者安装 Python 或 Node。GitHub Actions 对主系统和 SpecFlow 保留模块执行校验。Windows 桌面使用 WebView2 或随包 Electron。
