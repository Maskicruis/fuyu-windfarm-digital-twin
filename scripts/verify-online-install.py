"""Exercise the real Windows replace/restart and rollback worker in an isolated workspace."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import time
import urllib.request

ROOT=Path(__file__).resolve().parent.parent
VERSION=json.loads((ROOT/'config/app-version.json').read_text('utf-8'))['version']
NEXT_VERSION='.'.join(VERSION.split('.')[:2]+[str(int(VERSION.split('.')[-1])+1)])
AREA=ROOT/'开发源码/验收产物/update-worker-proof'
SOURCE=ROOT/('开发源码/验收产物/v'+VERSION.replace('.','')+'-build/扶余一号数字孪生.exe')
TARGET=AREA/'test-application.exe'
WORK=AREA/'workspace'
UPDATES=WORK/'data/updates'


def health():
    record=json.loads((WORK/'data/service.json').read_text('utf-8'))
    with urllib.request.urlopen('http://127.0.0.1:'+str(record['port'])+'/api/health',timeout=2) as r:
        state=json.load(r)['service']
    assert Path(state['workspace']).resolve()==WORK.resolve()
    return record,state


def wait_health():
    for _ in range(60):
        try:return health()
        except (OSError,ValueError,KeyError):time.sleep(1)
    raise RuntimeError('Test EXE failed to start')


def stop():
    # Query and stop only executables created in this proof directory.
    command="$target='"+str(TARGET).replace("'","''")+"';Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $target} | ForEach-Object {taskkill /PID $_.ProcessId /T /F | Out-Null}"
    subprocess.run(['powershell.exe','-NoProfile','-Command',command],capture_output=True)


def cycle(expected,port):
    stop()
    before=hashlib.sha256(TARGET.read_bytes()).hexdigest()
    start=subprocess.Popen([str(TARGET),'--headless','--data-dir',str(WORK),'--port',str(port)],creationflags=0x08000000)
    record,_=wait_health()
    result=UPDATES/'last-install.json';result.unlink(missing_ok=True)
    package=UPDATES/'candidate.exe';package.write_bytes(SOURCE.read_bytes()+b'FUYU_UPDATE_QA:'+expected.encode())
    candidate_hash=hashlib.sha256(package.read_bytes()).hexdigest()
    worker=subprocess.Popen(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(ROOT/'updater-worker.ps1'),
        '-Target',str(TARGET),'-Package',str(package),'-ParentPid',str(record['pid']),'-Workspace',str(WORK),
        '-ExpectedVersion',expected,'-ExpectedHash',hashlib.sha256(package.read_bytes()).hexdigest(),'-Port',str(port)],
        stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=0x08000000)
    time.sleep(1)
    subprocess.run(['taskkill','/PID',str(start.pid),'/T','/F'],capture_output=True)
    for _ in range(150):
        if result.exists():
            worker.wait(timeout=10)
            payload=json.loads(result.read_text('utf-8-sig'))
            assert (WORK/'data/preserved.txt').read_text('utf-8')=='unchanged project data'
            assert hashlib.sha256(TARGET.read_bytes()).hexdigest()==(candidate_hash if payload['status']=='installed' else before)
            wait_health()
            return payload
        time.sleep(1)
    worker.terminate()
    raise RuntimeError('Update worker did not finish')


def main():
    UPDATES.mkdir(parents=True,exist_ok=True);shutil.copy2(SOURCE,TARGET)
    (WORK/'data/preserved.txt').write_text('unchanged project data','utf-8')
    try:
        good=cycle(VERSION,38891);assert good['status']=='installed',good
        print(json.dumps({'actual_replace_restart':good}),flush=True)
        failed=cycle(NEXT_VERSION,38892);assert failed['status']=='rolled_back',failed
        print(json.dumps({'failed_start_rollback':failed}),flush=True)
        proof={'passed':True,'real_windows_worker':True,'replace_and_restart':True,'startup_failure_rollback':True,
               'workspace_data_preserved':True,'package':hashlib.sha256(SOURCE.read_bytes()).hexdigest()}
        (ROOT/'开发源码/验收产物/online-update-install-verification.json').write_text(json.dumps(proof,indent=2),'utf-8')
    finally:stop()


if __name__=='__main__':main()
