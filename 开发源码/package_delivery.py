from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import quote
import hashlib,json,re,zipfile
ROOT=Path(__file__).resolve().parent.parent
ARCHIVE=ROOT.parent/'扶余一号_V10.0_知识库与智能体_完整程序.zip'
class Inspector(HTMLParser):
 def __init__(self):super().__init__();self.ids=[];self.external=[]
 def handle_starttag(self,tag,attrs):
  a=dict(attrs)
  if 'id' in a:self.ids.append(a['id'])
  if tag=='script' and a.get('src'):self.external.append(a['src'])
for name in ['frontend.html','admin.html','使用说明.html','本轮界面配置说明.html']:
 c=Inspector();c.feed((ROOT/name).read_text('utf-8'))
 assert len(c.ids)==len(set(c.ids)) and not c.external,name
reports={}
for f in ['admin-tests/admin-test-report.json','construction-update-test-report.json','system-settings-test-report.json','scene-playback-test-report.json','knowledge-ui-test-report.json','agent-rag-test-report.json','system-admin-test-report.json']:
 r=json.loads((ROOT/'开发源码'/f).read_text('utf-8'));assert r['passed'];reports[f]=r
record={'revision':'10.0','python_tests':97,'ui_groups':67,'ui_assertions':467,'reports':reports,'frontend_sha256':hashlib.sha256((ROOT/'frontend.html').read_bytes()).hexdigest(),'verification':'HTTP integration and DOM tests passed. Browser visual automation stopped because the tool could not reliably determine the current URL; no bypass attempted.','live_model':'No real user API key tested; configure and test in Settings.','ocr':'Native text/PDF/Office and simulated MinerU structured output tested; actual OCR not verified.','repository':'https://github.com/Maskicruis/fuyu-windfarm-digital-twin'}
(ROOT/'V10.0_交付验证记录.json').write_text(json.dumps(record,ensure_ascii=False,indent=2),'utf-8')
(ROOT/'交付清单.txt').write_text('扶余一号 V10.0\nfrontend.html：展示与使用前端。\nadmin.html：界面、数据、知识库和接口控制后台。\n使用启动脚本运行，操作见README.md与使用说明.html。\nPython97项、DOM67组467断言通过。浏览器视觉验证未完成，真实模型/OCR需用自己的配置验证。\n程序包不包含data运行数据与密钥。更新时保留原有data；迁移时另行备份原件与索引。新安装从config/default-ui.json初始化。\n原V9目录名保留以维持入口；程序版本为V10.0。\n','utf-8-sig')
excluded={'data','.git','node_modules','__pycache__','验收产物','reference','效果图'}
files=[]
for p in ROOT.rglob('*'):
 if not p.is_file():continue
 rel=p.relative_to(ROOT)
 if any(x in excluded for x in rel.parts) or p.suffix.lower() in {'.key','.env','.log','.pid','.zip','.pyc'}:continue
 files.append(p)
with zipfile.ZipFile(ARCHIVE,'w',zipfile.ZIP_DEFLATED) as z:
 for p in files:z.write(p,ROOT.name+'/'+p.relative_to(ROOT).as_posix())
with zipfile.ZipFile(ARCHIVE) as z:
 assert z.testzip() is None
 assert not any('/data/' in n or '/.git/' in n or n.endswith('.key') for n in z.namelist())
nav='<!doctype html><meta charset="utf-8"><title>扶余一号 V10.0</title><style>body{background:#0d2030;color:#cee8f3;font:17px/2 Microsoft YaHei;padding:5vh 8vw}a{display:block;color:#74dcf0;margin:15px 0}</style><h1>扶余一号 V10.0</h1><p>请双击启动脚本运行本机服务。</p>'+''.join('<a href="'+quote(ROOT.name+'/'+f,safe='/')+'">'+label+'</a>' for label,f in [('启动控制后台','启动控制后台.cmd'),('展示前端','frontend.html'),('控制后台','admin.html'),('操作说明','使用说明.html'),('项目说明','README.md')])
(ROOT.parent/'00_最新演示与布局后台.html').write_text(nav,'utf-8')
print(json.dumps({'archive':str(ARCHIVE),'files':len(files),'bytes':ARCHIVE.stat().st_size},ensure_ascii=False))
