"""Exercise the real Windows updater with a harmless self-contained test EXE."""
from pathlib import Path
import argparse,hashlib,json,os,subprocess,sys,time
p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args();root=a.output.resolve();root.mkdir(parents=True,exist_ok=True)
assert not (root/'workspace').exists(), 'Use a fresh verification folder'
csc=Path(os.environ['WINDIR'])/'Microsoft.NET/Framework64/v4.0.30319/csc.exe';assert csc.exists()
source=root/'fixture.cs';source.write_text('using System; using System.IO; class Program { static void Main() { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"started.txt"),"ok"); } }','utf8')
folder=root/'workspace/data/updates';folder.mkdir(parents=True)
exe=folder/'SpecFlow-Knowledge-Component-1.3.4-x64.exe'
subprocess.run([str(csc),'/nologo','/target:exe','/out:'+str(exe),str(source)],check=True,capture_output=True)
settings=root/'workspace/data/settings.json';settings.write_text('{"sentinel":"retain-test-settings"}','utf8')
dummy=subprocess.Popen([sys.executable,'-c','import time;time.sleep(3)'],creationflags=0x08000000)
plan=folder/'install-plan.json';plan.write_text(json.dumps({'root':str(root),'file':str(exe),'name':exe.name,'version':'1.3.4','sha256':hashlib.sha256(exe.read_bytes()).hexdigest(),'pid':dummy.pid,'previous':''}),'utf8')
script=Path(__file__).resolve().parent.parent/'specflow-component/desktop/apply-component-update.ps1'
result=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',str(script),'-Plan',str(plan)],capture_output=True,text=True,encoding='utf8',errors='replace',timeout=30,creationflags=0x08000000)
assert result.returncode==0,result.stderr
for _ in range(30):
    if (root/'started.txt').exists():break
    time.sleep(.2)
status=json.loads((folder/'last-result.json').read_text('utf-8-sig'))
assert status['success'],status
assert (root/'started.txt').read_text()=='ok'
assert json.loads(settings.read_text())['sentinel']=='retain-test-settings'
assert hashlib.sha256((root/exe.name).read_bytes()).digest()==hashlib.sha256(exe.read_bytes()).digest()
proof={'passed':True,'real_windows_handoff':True,'waited_for_owned_process_exit':dummy.poll() is not None,'new_executable_started':True,'settings_untouched':True,'destination_sha256_verified':True}
(root/'proof.json').write_text(json.dumps(proof,indent=2),'utf8');print(json.dumps(proof))
