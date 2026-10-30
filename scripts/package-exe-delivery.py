"""Refresh delivery documentation only after the exact executable has passed validation."""
from pathlib import Path
import hashlib,json,shutil
ROOT=Path(__file__).resolve().parent.parent
DELIVERY=ROOT.parent/'扶余一号数字孪生'
def main():
    version=json.loads((ROOT/'config/app-version.json').read_text('utf-8'))['version']
    executable=DELIVERY/'扶余一号数字孪生.exe'
    checksum=hashlib.sha256(executable.read_bytes()).hexdigest()
    backend=json.loads((ROOT/'开发源码/backend-test-report.json').read_text('utf-8'))
    binary=json.loads((ROOT/('开发源码/验收产物/v'+version.replace('.','')+'-frozen-verification.json')).read_text('utf-8'))
    update=json.loads((ROOT/'开发源码/验收产物/online-update-install-verification.json').read_text('utf-8'))
    if not backend.get('passed') or binary['sha256']!=checksum or update['package']!=checksum or not update['passed']:
        raise RuntimeError('交付 EXE 与实际测试文件不一致，或测试未通过')
    shutil.copy2(ROOT/'README.md',DELIVERY/'使用说明.md')
    sdk=DELIVERY/'组件接入资料';sdk.mkdir(exist_ok=True)
    for name in ('README.md','openapi.json','twin-knowledge-sdk.js','integration-demo.html'):
        shutil.copy2(ROOT/'plugin'/name,sdk/name)
    report={'version':version,'format':'Windows x64 EXE','sha256':checksum,'bytes':executable.stat().st_size,
            'backend_tests':backend['tests'],'binary_validation':binary,'online_update':update,
            'data_location':'workspace/data','contains_user_data':False}
    (DELIVERY/'交付验证记录.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),'utf-8')
    source=json.loads((ROOT/'开发源码/交付验证记录.json').read_text('utf-8'))
    source['date']='2026-10-30';source['main']=report;source['tests']['main_backend']=backend['tests']
    source['tests']['overview']='Reference overview; independent equipment playback; dynamic compass; trend, alerts and footer'
    source['specflow']['validated_at']='2026-10-29; unchanged in V'+version
    (ROOT/'开发源码/交付验证记录.json').write_text(json.dumps(source,ensure_ascii=False,indent=2),'utf-8')
    print(json.dumps({'version':version,'sha256':checksum,'backend_tests':backend['tests']}))
if __name__=='__main__':main()
