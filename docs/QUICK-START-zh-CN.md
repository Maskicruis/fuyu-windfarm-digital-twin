# 快速入门 · 扶余一号数字孪生 V0.9.2

仓库为私有，下载前请登录有仓库访问权限的 GitHub 账号。

## 下载

打开 [V0.9.2 发布页](https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/tag/v0.9.2)，展开页面底部的 **Assets**。

| 文件 | 用途 |
| --- | --- |
| [Fuyu-Digital-Twin-0.9.2-x64.exe](https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/download/v0.9.2/Fuyu-Digital-Twin-0.9.2-x64.exe) | 数字孪生主程序，约 20.4 MB；包含展示界面、拖拽控制后台、设置与在线更新。 |
| [SpecFlow-Knowledge-Component-1.0.0-x64.exe](https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/download/v0.9.2/SpecFlow-Knowledge-Component-1.0.0-x64.exe) | 独立知识组件，约 101.1 MB；包含文件存储、PDF 解析、检索、连续对话和引用定位。 |
| [fuyu-crrc-wind.ico](https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/download/v0.9.2/fuyu-crrc-wind.ico) | Windows 图标，供快捷方式等使用。 |
| [fuyu-crrc-wind.png](https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/download/v0.9.2/fuyu-crrc-wind.png) · [SVG](https://github.com/Maskicruis/fuyu-windfarm-digital-twin/releases/download/v0.9.2/fuyu-crrc-wind.svg) | 图标预览和可编辑矢量原稿。 |
| fuyu-update.json | 主程序在线更新清单，程序自动读取。 |

普通使用请选择 EXE 附件；GitHub 自动生成的 Source code（zip / tar.gz）供开发使用。两款程序均为 Windows x64 便携程序，无需安装 Python 或 Node.js。独立知识组件沿用自己的 1.0.0 版本。

## 启动数字孪生主程序

1. 在桌面等可写位置新建“扶余一号数字孪生”文件夹，将主程序 EXE 放入其中，双击启动。建议使用固定目录。
2. 启动后直接进入项目总览。顶部切换风机、场内交通、集电线路和升压站；“播放场景”只控制设备动画，仍可拖动、滚轮缩放和复位。
3. 点击右上角 **设置**，配置项目名称、装机容量、规模、进度和模型 API。API 根地址、模型标识及密钥保存后，再点击“测试已保存配置”。留空保存密钥会沿用原值。

内嵌窗口使用 Microsoft Edge WebView2；内嵌环境不可用时，程序提供浏览器入口。图中机位、进度和预警示例均有标注，请按项目实际情况配置。

## 调整界面

点击顶部 **控制后台** → 选择工程 → 选择组件。拖动青色选框标签调整位置，使用尺寸手柄或右侧属性调整大小；“内容”页编辑文字。“保存草稿”保存编辑内容，**发布前端** 后展示界面生效。

## 使用独立知识组件

将知识组件 EXE 放入另一个固定文件夹，双击启动。在左下角设置中配置模型 API 和本机 MinerU，建立文档分组，导入 PDF 并解析，随后进行连续问答或点击引用定位原 PDF。PDF 解析需要本机已配置的 MinerU。

主程序和独立组件各自使用自己的 workspace，资料不会自动同步。对外接入说明见 [组件集成指南](https://github.com/Maskicruis/fuyu-windfarm-digital-twin/tree/main/specflow-component/integration)。

## 在线更新与资料保留

主程序：**设置 → 在线更新 → 检查更新 → 下载更新 → 安装并重启**。

私有更新源可复用本机 Git 登录，也可在“更新源与授权”中保存一次具备目标仓库 Contents:Read 权限的 GitHub 令牌；该令牌与模型 API Key 分开保存。

资料、会话和布局位于对应程序目录的 workspace 中。更新时保留整个 workspace；主程序会自动保留它。模型密钥由当前 Windows 账户加密保存。此在线更新入口用于数字孪生主程序，独立知识组件按自身版本发布。

## 图标在哪里

红色 CRRC 标识与风机、风能图形已经内置于主程序 EXE 和窗口图标中，包含 16、24、32、48、64、128、256 像素七档资源，运行程序无需额外安装图标。

发布附件提供 ICO、PNG、SVG 单独文件。可先 [查看图标预览](https://github.com/Maskicruis/fuyu-windfarm-digital-twin/blob/main/lib/brand/fuyu-crrc-wind.png)。若已有快捷方式仍显示旧图标，右键快捷方式 → 属性 → 更改图标，选择下载的 ICO 文件。
