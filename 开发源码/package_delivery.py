"""Package the application and recorded validation, excluding local operational data."""
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import quote
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parent.parent
REVISION = '10.1'
ARCHIVE = ROOT.parent / '扶余一号_V10.1_API持久化与引用流式修复.zip'
UI_REPORTS = (
    'admin-tests/admin-test-report.json',
    'construction-update-test-report.json',
    'system-settings-test-report.json',
    'scene-playback-test-report.json',
    'knowledge-ui-test-report.json',
    'agent-rag-test-report.json',
    'system-admin-test-report.json',
    'stream-ui-test-report.json',
)
PDF_ASSETS = (
    'lib/pdf.min.mjs', 'lib/pdf.worker.min.mjs',
    'lib/PDFJS_LICENSE.txt', 'lib/PDFJS_NOTICE.txt',
)


class Inspector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.external = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs:
            self.ids.append(attrs['id'])
        if tag == 'script' and attrs.get('src'):
            self.external.append(attrs['src'])


def load_passed_report(path):
    report = json.loads(path.read_text('utf-8'))
    if report.get('passed') is not True:
        raise RuntimeError(f'验证未通过，停止打包：{path.name}')
    return report


def positive_count(report, field, label):
    value = report.get(field)
    if type(value) is not int or value <= 0:
        raise RuntimeError(f'验证报告缺少有效数量：{label} / {field}')
    return value


def included_file(path):
    relative = path.relative_to(ROOT)
    excluded_parts = {
        'data', '.git', 'node_modules', '__pycache__', '验收产物',
        'reference', '效果图', '.venv', 'venv', 'credentials',
    }
    if any(part.lower() in excluded_parts for part in relative.parts):
        return False
    name = path.name.lower()
    if (name.startswith('.env') and name != '.env.example') or name.endswith(
        ('.key', '.pem', '.log', '.pid', '.zip', '.pyc', '.pyo')
    ):
        return False
    if '.sqlite' in name or name.endswith(('.db', '.db-shm', '.db-wal', '.db-journal')):
        return False
    return True


def main():
    for name in ('frontend.html', 'admin.html', '使用说明.html', '本轮界面配置说明.html'):
        inspector = Inspector()
        inspector.feed((ROOT / name).read_text('utf-8'))
        if len(inspector.ids) != len(set(inspector.ids)) or inspector.external:
            raise RuntimeError(f'页面 ID 重复或引用外部脚本：{name}')
    for name in PDF_ASSETS:
        if not (ROOT / name).is_file():
            raise RuntimeError(f'缺少 PDF 阅读组件：{name}')

    backend = load_passed_report(ROOT / '开发源码/backend-test-report.json')
    reports = {
        name: load_passed_report(ROOT / '开发源码' / name)
        for name in UI_REPORTS
    }
    python_tests = positive_count(backend, 'tests', 'backend')
    ui_groups = sum(
        positive_count(report, 'groups' if 'groups' in report else 'tests', name)
        for name, report in reports.items()
    )
    ui_assertions = sum(
        positive_count(report, 'assertions', name)
        for name, report in reports.items()
    )
    browser_path = ROOT / '开发源码/验收产物/V10.1-browser/verification.json'
    browser = load_passed_report(browser_path) if browser_path.is_file() else {
        'status': 'not_recorded',
        'note': '尚未登记本次浏览器验收记录，不据自动化测试宣称视觉验证通过。',
    }
    record = {
        'revision': REVISION,
        'python_tests': python_tests,
        'ui_groups': ui_groups,
        'ui_assertions': ui_assertions,
        'backend_report': backend,
        'reports': reports,
        'frontend_sha256': hashlib.sha256((ROOT / 'frontend.html').read_bytes()).hexdigest(),
        'verification': {
            'automated': 'HTTP integration, backend and DOM tests passed; counts loaded from their reports.',
            'browser': browser,
        },
        'ocr': 'Native text/PDF/Office and simulated MinerU structured output tested; actual OCR not verified.',
        'reference': 'SpecFlow b076c50fe5df28c628f97b5eafa052c1dff0188b',
        'repository': 'https://github.com/Maskicruis/fuyu-windfarm-digital-twin',
    }
    (ROOT / f'V{REVISION}_交付验证记录.json').write_text(
        json.dumps(record, ensure_ascii=False, indent=2), 'utf-8'
    )
    (ROOT / '交付清单.txt').write_text(
        f'扶余一号 V{REVISION}\n'
        'frontend.html：展示与使用前端。\n'
        'admin.html：界面、数据、知识库和接口控制后台。\n'
        'lib/：PDF 原件阅读模块、工作线程和许可；运行时需保留。\n'
        '使用启动脚本运行，操作见 README.md 与使用说明.html。\n'
        f'Python {python_tests} 项、DOM {ui_groups} 组 {ui_assertions} 断言通过；'
        f'浏览器及真实模型验收详见 V{REVISION}_交付验证记录.json。\n'
        '本版修复：DeepSeek 配置按 Windows 账户持久保存；引用严格校验后定位原文；思考与回答实时流式显示。\n'
        '程序包不包含 data 运行数据与密钥。更新时保留原有 data；迁移时另行备份原件与索引。'
        '同一 Windows 账户移动目录无需重填 DeepSeek 配置，更换账户或电脑需重新设置密钥。\n'
        '新安装从 config/default-ui.json 初始化；实际 OCR 需另行安装并验证 MinerU 环境。\n'
        f'原 V9 目录名保留以维持入口；程序版本为 V{REVISION}。\n',
        'utf-8-sig',
    )

    files = sorted(path for path in ROOT.rglob('*') if path.is_file() and included_file(path))
    with zipfile.ZipFile(ARCHIVE, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, ROOT.name + '/' + path.relative_to(ROOT).as_posix())
    with zipfile.ZipFile(ARCHIVE) as archive:
        if archive.testzip() is not None:
            raise RuntimeError('程序包 CRC 校验失败。')
        names = set(archive.namelist())
        if not all(ROOT.name + '/' + name in names for name in PDF_ASSETS):
            raise RuntimeError('程序包缺少 PDF 阅读模块。')
        if any(not included_file(ROOT / name.split('/', 1)[1]) for name in names):
            raise RuntimeError('程序包包含运行数据或凭据，停止交付。')
    nav = (
        f'<!doctype html><meta charset="utf-8"><title>扶余一号 V{REVISION}</title>'
        '<style>body{background:#0d2030;color:#cee8f3;font:17px/2 Microsoft YaHei;padding:5vh 8vw}'
        'a{display:block;color:#74dcf0;margin:15px 0}</style>'
        f'<h1>扶余一号 V{REVISION}</h1><p>请双击启动脚本运行本机服务。</p>'
        + ''.join(
            '<a href="' + quote(ROOT.name + '/' + name, safe='/') + '">' + label + '</a>'
            for label, name in (
                ('启动控制后台', '启动控制后台.cmd'), ('展示前端', 'frontend.html'),
                ('控制后台', 'admin.html'), ('操作说明', '使用说明.html'), ('项目说明', 'README.md'),
            )
        )
    )
    (ROOT.parent / '00_最新演示与布局后台.html').write_text(nav, 'utf-8')
    print(json.dumps({
        'archive': str(ARCHIVE), 'files': len(files), 'bytes': ARCHIVE.stat().st_size,
        'python_tests': python_tests, 'ui_groups': ui_groups, 'ui_assertions': ui_assertions,
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
