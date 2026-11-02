# 扶余一号数字孪生 · V0.9.4 · 总览布局与交互优化

当前交付在 G:\中车扶余数字孪生\00工作区。源码以本目录为准，GitHub 仓库为 https://github.com/Maskicruis/fuyu-windfarm-digital-twin ，现已公开，采用 MIT 许可证；第三方组件保留各自许可。

## 下载与快速启动

[打开 V0.9.4 发布页（EXE 附件）](https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/tag/v0.9.4) · [快速入门指南](docs/QUICK-START-zh-CN.md) · [图标预览](lib/brand/fuyu-crrc-wind.png)

发布页 Assets 提供主程序 EXE、独立知识组件 EXE、图标与离线指南。普通使用直接下载 EXE 即可。

## 两项交付

1. `../扶余一号数字孪生/扶余一号数字孪生.exe`：展示前端、拖拽控制后台、设置、悬浮智能体及现有三维场景。
2. `../知识与大模型独立组件/SpecFlow-Knowledge-Component-1.1.1-x64.exe`：[独立组件发布页](https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/tag/component-v1.1.1)。基于 SpecFlow 裁剪并增强文字层快速提取、独立 OCR、持久化 FTS 索引、三种回答模式和按页原文阅读。来源和适配模块分别登记在 `specflow-component/` 的 provenance 文件；见[使用说明](specflow-component/README.md)与[验收记录](docs/COMPONENT-1.1.1-VALIDATION.md)。主程序版本继续为 V0.9.4。

## 项目总览

首页按最新参考图组织：顶部左侧为项目规模（风机、集电回路、升压站、工程类别），右侧为项目关键参数（装机容量 MW、建设周期、用地红线）和项目状态。左侧保留项目简介、总体建设进度与三项关注事项；底部分项工程进度横向展开，将中部空间留给三维场景。

鼠标悬停底部任一专业的整块进度区域（含图标、名称、条形进度、百分比及留白），或用 Tab 键聚焦该按钮，会自动显示“当前施工阶段”浮层：前期准备、土建施工、设备安装、并网调试。各专业独立配置当前阶段，青色节点高亮；未配置的真实数据保持待配置。点击进度条仍进入对应专业工作台。

“设置 → 总览信息”可修改简介、规模、参数、项目状态、各专业当前阶段、总体与分项进度，登记按日期递增的历史进度（每行 日期,实际百分比,可选计划百分比，最多60点）。关闭演示模式后，未填指标显示 —，未登记历史时显示“进度趋势待接入”。演示的18个机位和进度不等同于项目真实统计，不采用参考图中未确认的92台、360MW等数字。

全场与四个专业均采用半透明面板，背景透明度可在总览信息设置中调整，文字保持清晰。四个专业新增红白指北针；总览保留原有动态指南针。方向随相机变化，基准为示意场景的 -Z 北向。播放只切换设备动画，保留当前相机位置，拖动、滚轮、缩放、2D/3D与复位均可继续使用。面板、底部分项进度、图例和指北针支持在控制后台调整布局。

## 专业工作台

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

数字孪生的数据在 EXE 同目录 `workspace/data`；主系统 API 凭据由当前 Windows 账户加密保存。独立 SpecFlow 组件使用自己的 `workspace/data` 和资料库，设置存储方式沿用 SpecFlow；勿上传数据目录到 GitHub。主系统从本版本起支持在设置中在线更新；独立 SpecFlow 组件继续按独立版本发布。

独立组件目前导入 PDF，文字层快速提取、扫描件独立 OCR；OCR 模型不打包进 EXE。在设置中选择已安装的 MinerU。对外接口、连续对话和引用定位见 `specflow-component/integration/README.md`。主系统现有知识库支持的格式与独立组件不同，各自说明以实际接口为准。

## 在线更新

“设置 → 在线更新”依次点击“检查更新”“下载更新”“安装并重启”。更新包来自本项目 GitHub Releases，下载完成后校验产品、版本、大小和 SHA256；替换前再次校验。程序关闭后自动安装并重新启动，启动身份检查失败时恢复旧程序。资料、API 配置、会话和布局不随 EXE 替换；旧 EXE 备份保留在 `workspace/data/updates/previous.exe`。请先保存尚未发布的编辑。

默认使用公开 GitHub Release 下载地址，无需 GitHub 登录、Git 或更新令牌，也不消耗匿名 GitHub REST API 配额。其他私有更新源仍可在“更新源与授权”中配置只读令牌；令牌使用 Windows DPAPI 加密，与模型密钥分开保存。

开发发布时修改 `config/app-version.json`，重建 EXE 后，将安装包与构建生成的 `fuyu-update.json` 上传到相同版本的稳定 Release。先传 EXE，再传清单；没有兼容清单的旧 V12 发布会被忽略。源码/浏览器服务支持检查和下载，安装必须通过桌面 EXE。

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

主程序图标采用中车红 CRRC 标识区与风机/风能图形，SVG、PNG 和 16–256 像素 ICO 位于 `lib/brand/`，打包时写入 EXE 与窗口图标。
