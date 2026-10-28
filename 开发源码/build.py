from pathlib import Path
import re,json,base64,subprocess,shutil
HERE=Path(__file__).resolve().parent
ROOT=HERE.parent
V7=ROOT.parent/'扶余一号_施工模块布局优化_V7'/'扶余一号_施工模块布局与悬浮智能体_V7.html'
NODE=shutil.which('node') or str(Path(r'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'))
base=HERE/'frontend-base.html'
if not base.exists():shutil.copy2(V7,base)
source=base.read_text(encoding='utf-8')
preset=json.loads((ROOT/'config/default-ui.json').read_text(encoding='utf-8')) if (ROOT/'config/default-ui.json').exists() else {'version':2,'profiles':{}}
if (ROOT/'data/published.json').exists():
    existing=json.loads((ROOT/'data/published.json').read_text(encoding='utf-8'))
    preset=existing.get('config',existing)
script='<script id="fuyu-display-config" type="application/json" data-live="true">'+json.dumps(preset,ensure_ascii=False).replace('<','\\u003c')+'</script>'
frontend=source.replace('</head>',script+'</head>',1)
frontend=frontend.replace('</style>','\n'+(HERE/'construction-update.css').read_text(encoding='utf-8')+'</style>',1)
frontend=frontend.replace('</style>','\n'+(HERE/'scene-playback.css').read_text(encoding='utf-8')+'\n'+(HERE/'system-settings.css').read_text(encoding='utf-8')+'\n'+(HERE/'knowledge-ui.css').read_text(encoding='utf-8')+'\n'+(HERE/'system-admin.css').read_text(encoding='utf-8')+'</style>',1)
frontend=frontend.replace('</style>','\n'+(HERE/'runtime.css').read_text(encoding='utf-8')+'</style>',1)
frontend=frontend.replace('</body>','<script>'+(HERE/'construction-update.js').read_text(encoding='utf-8').replace('</script','<\\/script')+'</script></body>',1)
for feature in ['system-settings.js','knowledge-ui.js','scene-playback.js']:
    frontend=frontend.replace('</body>','<script>'+(HERE/feature).read_text(encoding='utf-8').replace('</script','<\\/script')+'</script></body>',1)
frontend=frontend.replace('</body>','<script>'+(HERE/'runtime.js').read_text(encoding='utf-8').replace('</script','<\\/script')+'</script></body>',1)
frontend=re.sub(r'<title>.*?</title>','<title>扶余一号 · 展示前端 V10.0</title>',frontend,count=1)
frontend=frontend.replace('V7.0','V10.0')
(ROOT/'frontend.html').write_text(frontend,encoding='utf-8')
adminjs=(HERE/'admin.js').read_text(encoding='utf-8').replace('__FRONTEND_B64__',base64.b64encode(frontend.encode()).decode())
admin=(HERE/'admin-template.html').read_text(encoding='utf-8').replace('__ADMIN_CSS__',((HERE/'admin.css').read_text(encoding='utf-8')+'\n'+(HERE/'system-settings.css').read_text(encoding='utf-8')+'\n'+(HERE/'knowledge-ui.css').read_text(encoding='utf-8')+'\n'+(HERE/'system-admin.css').read_text(encoding='utf-8'))).replace('__ADMIN_JS__',adminjs.replace('</script','<\\/script'))
admin=admin.replace('</body>','<script>'+(HERE/'system-settings.js').read_text(encoding='utf-8').replace('</script','<\\/script')+'</script></body>',1).replace('V9.1','V10.0').replace('V9.2','V10.0')
for feature in ['knowledge-ui.js','system-admin.js']:
    admin=admin.replace('</body>','<script>'+(HERE/feature).read_text(encoding='utf-8').replace('</script','<\\/script')+'</script></body>',1)
(ROOT/'admin.html').write_text(admin,encoding='utf-8')
for f in ['runtime.js','admin.js','construction-update.js','system-settings.js','scene-playback.js','knowledge-ui.js','system-admin.js']:subprocess.run([str(NODE),'--check',str(HERE/f)],check=True)
licensefile=ROOT.parent/'扶余一号_可视化布局控制台_V8'/'Three.js_LICENSE.txt'
if licensefile.exists():shutil.copy2(licensefile,ROOT/'Three.js_LICENSE.txt')
(ROOT/'展示配置.json').write_text(json.dumps(preset,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'frontend_bytes':(ROOT/'frontend.html').stat().st_size,'admin_bytes':(ROOT/'admin.html').stat().st_size}))
