param([Parameter(Mandatory=$true)][string]$Target,[Parameter(Mandatory=$true)][string]$Package,[int]$ParentPid,[string]$Workspace,[string]$ExpectedVersion,[string]$ExpectedHash,[int]$Port)
$ErrorActionPreference='Stop'
$exePath=[IO.Path]::GetFullPath($Target)
$workspacePath=[IO.Path]::GetFullPath($Workspace)
$updatePath=[IO.Path]::GetFullPath((Join-Path $workspacePath 'data\updates'))
$packagePath=[IO.Path]::GetFullPath($Package)
$resultPath=Join-Path $updatePath 'last-install.json'
$backupPath=Join-Path $updatePath 'previous.exe'
$stagingPath=Join-Path ([IO.Path]::GetDirectoryName($exePath)) '.fuyu-update-new.exe'
$replaced=$false
$launched=$null
function Log([string]$message){[IO.File]::AppendAllText((Join-Path $updatePath 'install.log'),[DateTime]::UtcNow.ToString('o')+' '+$message+[Environment]::NewLine,[Text.Encoding]::UTF8)}
function Report([string]$status,[string]$message){@{status=$status;message=$message;version=$ExpectedVersion;time=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $resultPath -Encoding utf8}
function Launch([string]$file){$argument='--data-dir "'+$workspacePath.Replace('"','')+'"';Start-Process -FilePath $file -ArgumentList $argument -WorkingDirectory ([IO.Path]::GetDirectoryName($exePath)) -WindowStyle Normal -PassThru}
function Rollback([string]$reason){
 if($launched -and !$launched.HasExited){taskkill /PID $launched.Id /T /F | Out-Null}
 $recordFile=Join-Path $workspacePath 'data\service.json'
 if(Test-Path -LiteralPath $recordFile){try{$r=[IO.File]::ReadAllText($recordFile,[Text.Encoding]::UTF8)|ConvertFrom-Json;$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$r.pid) -ErrorAction SilentlyContinue;if($p -and $p.ExecutablePath -eq $exePath){taskkill /PID $p.ProcessId /T /F | Out-Null}}catch{}}
 Start-Sleep -Seconds 2
 $restored=$false
 for($retry=0;$retry -lt 30;$retry++){try{Copy-Item -LiteralPath $backupPath -Destination $exePath -Force;$restored=$true;break}catch{Start-Sleep -Seconds 1}}
 if(!$restored){throw '原程序备份已保留，但程序文件仍被占用'}
 Launch $exePath | Out-Null
 Report 'rolled_back' ('已恢复原程序，workspace 保持不变。'+$reason)
}
try {
 if(!$packagePath.StartsWith($updatePath+'\',[StringComparison]::OrdinalIgnoreCase)){throw '更新包路径越界'}
 if([IO.Path]::GetExtension($exePath) -ne '.exe' -or $ExpectedVersion -notmatch '^\d+\.\d+\.\d+$'){throw '更新目标无效'}
 $hashAlgorithm=[Security.Cryptography.SHA256]::Create()
 $packageStream=[IO.File]::OpenRead($packagePath)
 try{$actualHash=[BitConverter]::ToString($hashAlgorithm.ComputeHash($packageStream)).Replace('-','').ToLowerInvariant()}finally{$packageStream.Dispose();$hashAlgorithm.Dispose()}
 if($actualHash -ne $ExpectedHash){throw '安装前校验失败'}
 foreach($path in @($exePath,$packagePath,$workspacePath,$updatePath)){if((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw '更新目标不能为链接'} }
 $process=Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
 if($process -and !$process.WaitForExit(120000)){throw '等待当前程序关闭超时，未替换程序'}
 Copy-Item -LiteralPath $exePath -Destination $backupPath -Force
 Copy-Item -LiteralPath $packagePath -Destination $stagingPath -Force
 $replaced=$false
 for($attempt=0;$attempt -lt 60;$attempt++){
  try {Move-Item -LiteralPath $stagingPath -Destination $exePath -Force;$replaced=$true;break}catch{Start-Sleep -Milliseconds 1000}
 }
 if(!$replaced){throw '程序仍被占用；已保留原程序和下载包'}
 Log 'Package verified and executable replaced.'
 $launched=Launch $exePath
 $healthy=$false
 for($i=0;$i -lt 75;$i++){
  Start-Sleep -Seconds 1
  try {$record=[IO.File]::ReadAllText((Join-Path $workspacePath 'data\service.json'),[Text.Encoding]::UTF8) | ConvertFrom-Json;$health=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$record.port+'/api/health') -TimeoutSec 2;if($health.service.revision -eq $ExpectedVersion -and $health.service.workspace -eq $workspacePath){$healthy=$true;break};if($i -eq 0){Log ('Startup identity differs; received version '+$health.service.revision)}}catch{if($i -eq 0 -or $i -eq 74){Log $_.Exception.Message}}
 }
 if(!$healthy){
  Rollback '新版本未通过启动检查。'
 }else{Report 'installed' '更新安装成功；资料与配置已保留。'}
} catch {if($replaced -and (Test-Path -LiteralPath $backupPath)){try{Rollback $_.Exception.Message}catch{Report 'error' ('自动恢复失败，原程序备份保留于 data/updates/previous.exe。'+$_.Exception.Message)}}else{Report 'error' $_.Exception.Message}}
