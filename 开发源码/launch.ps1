$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$pythonCandidates=@('C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe','python.exe','py.exe')
$pythonPath=$null
foreach($candidate in $pythonCandidates){if(Test-Path -LiteralPath $candidate){$pythonPath=$candidate;break};$cmd=Get-Command $candidate -ErrorAction SilentlyContinue;if($cmd){$pythonPath=$cmd.Source;break}}
if(!$pythonPath){Write-Host '未找到 Python 3。仍可双击 frontend.html 展示或 admin.html 离线编辑。';Read-Host '按 Enter 关闭';exit 1}
$adminUrl='http://127.0.0.1:8779/admin.html'
$running=$false
try{$state=Invoke-RestMethod -Uri 'http://127.0.0.1:8779/api/state' -TimeoutSec 2;if($state.draft.version -eq 2){$running=$true}}catch{}
if(!$running){$serverPath=Join-Path $PSScriptRoot 'server.py';$processArgs=@('"'+$serverPath+'"','--port','8779');if([IO.Path]::GetFileName($pythonPath)-eq'py.exe'){$processArgs=@('-3')+$processArgs};$proc=Start-Process -FilePath $pythonPath -ArgumentList $processArgs -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru;$proc.Id|Set-Content -LiteralPath (Join-Path $projectRoot 'data\server.pid') -Encoding ascii;for($i=0;$i -lt 30;$i++){try{$state=Invoke-RestMethod -Uri 'http://127.0.0.1:8779/api/state' -TimeoutSec 1;if($state.draft.version -eq 2){$running=$true;break}}catch{};Start-Sleep -Milliseconds 300}}
if($running){Start-Process $adminUrl}else{Write-Host '本地服务未启动，请检查8779端口是否被占用。';Read-Host '按 Enter 关闭'}
