"""Build the self-contained desktop executable; never include local data/secrets."""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import sys
import ssl

ROOT = Path(__file__).resolve().parent.parent

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT.parent/'扶余一号数字孪生')
    args = parser.parse_args()
    version=json.loads((ROOT/'config/app-version.json').read_text('utf-8'))['version']
    work = ROOT/'开发源码/验收产物/exe-build'
    work.mkdir(parents=True,exist_ok=True)
    numbers=tuple(map(int,version.split('.')))+(0,)
    version_file=work/'version-info.txt'
    version_file.write_text("VSVersionInfo(ffi=FixedFileInfo(filevers="+repr(numbers)+",prodvers="+repr(numbers)+",mask=0x3f,flags=0x0,OS=0x40004,fileType=0x1,subtype=0x0,date=(0,0)),kids=[StringFileInfo([StringTable('040904B0',[StringStruct('CompanyName','Fuyu Digital Twin'),StringStruct('FileDescription','Fuyu Windfarm Digital Twin'),StringStruct('FileVersion','"+version+"'),StringStruct('ProductName','Fuyu Windfarm Digital Twin'),StringStruct('ProductVersion','"+version+"')])]),VarFileInfo([VarStruct('Translation',[1033,1200])])])",'utf-8')
    args.output.mkdir(parents=True, exist_ok=True)
    assets = ['frontend.html', 'admin.html', 'desktop-home.html', 'updater-worker.ps1', 'config', 'lib', 'plugin', 'Three.js_LICENSE.txt']
    command = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--onefile', '--windowed',
               '--name', '扶余一号数字孪生', '--distpath', str(args.output), '--workpath', str(work/'build'),
               '--specpath', str(work), '--version-file',str(version_file), '--paths', str(ROOT/'开发源码'), '--collect-all', 'webview',
               '--collect-all', 'pythonnet', '--hidden-import', 'pypdf', '--hidden-import', 'tkinter',
               '--exclude-module', 'PyQt5', '--exclude-module', 'PyQt6', '--exclude-module', 'PySide6']
    for name in assets:
        source = ROOT/name
        if not source.exists():
            raise FileNotFoundError(source)
        destination = 'assets/'+name if source.is_dir() else 'assets'
        command.extend(['--add-data', str(source)+':'+destination])
    # This Python runtime loads its additional trust-policy resource beside ssl.py.
    # Bundle the same resource; keep certificate verification unchanged.
    trust_policy = Path(ssl.__file__).with_name('codex-rejected-cas.pem')
    if trust_policy.is_file():
        command.extend(['--add-data', str(trust_policy)+':.'])
    command.append(str(ROOT/'开发源码/desktop_app.py'))
    subprocess.run(command, cwd=ROOT, check=True)
    executable = args.output/'扶余一号数字孪生.exe'
    result = {'version':version,'executable':str(executable),'bytes':executable.stat().st_size,
              'sha256':hashlib.sha256(executable.read_bytes()).hexdigest(),
              'contains_user_data':False,'bundles_python':True,'embedded_engine':'Microsoft Edge WebView2'}
    (args.output/'构建信息.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf-8')
    manifest={'schema':'fuyu-desktop-update/v1','product':'fuyu-windfarm-digital-twin','version':version,'notes':'V0.9.1：精简项目总览，增加项目级参数与在线更新。','windows-x64':{'file':'Fuyu-Digital-Twin-'+version+'-x64.exe','size':result['bytes'],'sha256':result['sha256']}}
    (args.output/'fuyu-update.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),'utf-8')
    print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':main()
