"""Windows failure paths: a started process is not a confirmed application."""
from pathlib import Path
import argparse,hashlib,json,os,subprocess,time
p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args()
root=a.output.resolve();root.mkdir(parents=True,exist_ok=True)
assert not (root/'workspace').exists()
folder=root/'workspace/data/updates';folder.mkdir(parents=True)
csc=Path(os.environ['WINDIR'])/'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
source=root/'fixture.cs';source.write_text('using System; using System.IO; class P { static void Main() { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"rollback-opened.txt"),"ok"); } }','utf8')
previous=root/'previous.exe';subprocess.run([str(csc),'/nologo','/target:winexe','/out:'+str(previous),str(source)],check=True,capture_output=True)
source.write_text('class P { static void Main() {} }','utf8')
target=folder/'SpecFlow-Knowledge-Component-1.3.7-x64.exe';subprocess.run([str(csc),'/nologo','/target:winexe','/out:'+str(target),str(source)],check=True,capture_output=True)
settings=root/'workspace/data/settings.json';settings.write_text('{"sentinel":"unchanged"}','utf8')
plan={'schema':2,'requestId':'b'*32,'root':str(root),'dataDir':str(root/'workspace/data'),'file':str(target),'name':target.name,'version':'1.3.7','sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'pid':0,'previous':str(previous),'launchArgs':[],'launchTimeoutSeconds':2}
planFile=folder/'install-plan.json';planFile.write_text(json.dumps(plan),'utf8')
worker=Path(__file__).resolve().parent.parent/'specflow-component/desktop/apply-component-update.ps1'
result=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',str(worker),'-Plan',str(planFile)],capture_output=True,text=True,encoding='utf8',errors='replace',timeout=30,creationflags=0x08000000)
state=json.loads((folder/'last-result.json').read_text('utf-8-sig'));assert result.returncode==1 and state['success'] is False and state['phase']=='failed',state
for _ in range(30):
 if (root/'rollback-opened.txt').exists():break
 time.sleep(.1)
assert (root/'rollback-opened.txt').exists()
plan['sha256']='0'*64;planFile.write_text(json.dumps(plan),'utf8')
bad=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',str(worker),'-Plan',str(planFile)],capture_output=True,timeout=30,creationflags=0x08000000)
state=json.loads((folder/'last-result.json').read_text('utf-8-sig'));assert bad.returncode==1 and 'checksum' in state['message']
assert json.loads(settings.read_text())['sentinel']=='unchanged'
proof={'passed':True,'missing_window_receipt_never_marks_success':True,'previous_executable_reopened':True,'checksum_mismatch_rejected':True,'settings_untouched':True}
(root/'proof.json').write_text(json.dumps(proof,indent=2),'utf8');print(json.dumps(proof))
