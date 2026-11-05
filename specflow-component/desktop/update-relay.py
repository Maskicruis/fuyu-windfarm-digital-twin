"""GUI-subsystem relay: keep the updater outside Electron's process lifetime.

Windows PowerShell may silently exit with DETACHED_PROCESS and no console.
pythonw supports this mode; it runs PowerShell with CREATE_NO_WINDOW instead.
Only the already bundled Python runtime is needed, not a system installation.
"""
from pathlib import Path
import json, subprocess, sys

plan_file = Path(sys.argv[1])
folder = plan_file.parent
try:
    with (folder / 'helper-console.log').open('ab') as log:
        result = subprocess.run(
            ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
             '-File', str(folder / 'apply-component-update.ps1'), '-Plan', str(plan_file)],
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            creationflags=0x08000000,
        )
    sys.exit(result.returncode)
except Exception as error:
    try:
        plan = json.loads(plan_file.read_text('utf8'))
        (folder / 'last-result.json').write_text(json.dumps({
            'phase': 'failed', 'success': False, 'requestId': plan.get('requestId'),
            'version': plan.get('version'), 'message': 'Update relay failed: ' + str(error),
        }), encoding='utf8')
    except Exception:
        pass
    sys.exit(1)
