"""Prepare executable delivery docs and SDK. Existing workspace data is untouched."""
from pathlib import Path
import hashlib
import json
import shutil

ROOT=Path(__file__).resolve().parent.parent
DELIVERY=ROOT.parent/'扶余一号数字孪生'

def main():
    executable=DELIVERY/'扶余一号数字孪生.exe'
    if executable.read_bytes()[:2]!=b'MZ':
        raise RuntimeError('缺少有效 Windows EXE')
    backend=json.loads((ROOT/'开发源码/backend-test-report.json').read_text('utf-8'))
    reports=[json.loads(p.read_text('utf-8')) for p in (ROOT/'开发源码').glob('*-test-report.json') if p.name!='backend-test-report.json']
    reports.append(json.loads((ROOT/'开发源码/admin-tests/admin-test-report.json').read_text('utf-8')))
    if not backend.get('passed') or not all(r.get('passed') for r in reports):
        raise RuntimeError('测试报告未全部通过')
    checksum=hashlib.sha256(executable.read_bytes()).hexdigest()
    binary=json.loads((ROOT/'开发源码/验收产物/EXE-native-verification.json').read_text('utf-8'))
    if binary.get('passed') is not True or binary.get('sha256')!=checksum:
        raise RuntimeError('当前 EXE 尚未登记对应的实际运行验收')
    sdk=DELIVERY/'组件接入资料';sdk.mkdir(exist_ok=True)
    for name in ('README.md','openapi.json','twin-knowledge-sdk.js','integration-demo.html'):
        shutil.copy2(ROOT/'plugin'/name,sdk/name)
    (DELIVERY/'使用说明.md').write_text('''# 扶余一号数字孪生 · 桌面版

双击“扶余一号数字孪生.exe”。前端展示、界面控制后台、知识组件和 API/解析设置均在顶部导航。

## API 设置

选择“API 与解析设置”，填写接口类型、模型标识、API 根地址和密钥，再点击“保存设置”。已保存的密钥不回显；留空继续沿用，输入新 Key 后保存即替换。修改地址和模型后先保存，再点击“测试已保存配置”。测试可以取消，期间仍能修改字段。

DeepSeek 官方地址可以使用 https://api.deepseek.com 或 /v1。其他服务选择 OpenAI 兼容接口，填写服务商根地址和模型标识；不要附加 /chat/completions。HTTP 仅允许本机回环地址。

## 资料与后台

“资料导入与解析”支持文件导入、分组、后台解析、检索和精确原文核查。文字 PDF、TXT/MD/DOCX/XLSX 可直接解析；扫描件 OCR 需要已安装并配置 MinerU。

“控制后台”调整界面组件、文字、布局、对象数据与数据接口。草稿需要发布后才影响展示页。

## 数据与更新

当前资料、会话和界面数据位于 workspace/data；升级前备份位于“数据备份”。更新时只替换 EXE，保留 workspace。API 密钥由当前 Windows 账户加密保存，不在 EXE 内；更换电脑或 Windows 账户需重新填写。

Windows 使用 Edge WebView2 显示桌面窗口，当前电脑已实测；未具备内嵌环境时程序提供浏览器入口。

## 接入其他数字孪生系统

独立组件快捷方式或命令：

```powershell
.\\扶余一号数字孪生.exe --plugin-only --data-dir "G:\\另一个项目\\知识工作区"
```

独立模式不加载扶余风场三维界面。每个项目使用独立数据根目录。组件提供 /api/plugin/v1、OpenAPI 文档、JS 浮窗 SDK、上下文输入、SSE 思考/回答及 focus.request 定位事件。详见“组件接入资料/README.md”。

外部宿主 origin 必须明确登记；跨来源/原生 API 使用独立集成令牌，不能使用或获取模型 API Key。组件只发送定位请求，具体三维跳转由宿主核验并执行。
''','utf-8-sig')
    result={'version':'11.0','format':'Windows x64 standalone EXE',
        'executable':executable.name,'bytes':executable.stat().st_size,
        'sha256':checksum,
        'backend_tests':backend['tests'],
        'ui_groups':sum(r.get('groups',r.get('tests',0)) for r in reports),
        'ui_assertions':sum(r.get('assertions',0) for r in reports),
        'plugin_protocol':'twin-knowledge/v1','api':'/api/plugin/v1',
        'binary_validation':binary,
        'contains_model_key':False,'data_location':'workspace/data',
        'actual_ocr_verified':False}
    (DELIVERY/'交付验证记录.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf-8')
    (ROOT/'交付清单.txt').write_text('当前交付：../扶余一号数字孪生/扶余一号数字孪生.exe\n包含前端展示、控制后台、API/解析设置、独立知识组件；操作说明和接入资料位于 EXE 同目录。\n','utf-8-sig')
    print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':main()
