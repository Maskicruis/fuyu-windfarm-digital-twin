param([Parameter(Mandatory=$true)][string]$Plan)
$ErrorActionPreference='Stop'
$resultPath=Join-Path (Split-Path -Parent $Plan) 'last-result.json'
$logPath=Join-Path (Split-Path -Parent $Plan) 'install.log'
$utf8=New-Object Text.UTF8Encoding($false)
$updatePlan=$null
$oldExited=$false
$launched=$null
function Log([string]$message){[IO.File]::AppendAllText($logPath,((Get-Date).ToString('o')+' '+$message+[Environment]::NewLine),$utf8)}
function Result([string]$phase,$success,[string]$message){
  $state=@{phase=$phase;success=$success;message=$message;time=(Get-Date).ToString('o');version=$updatePlan.version;requestId=$updatePlan.requestId}
  $temporary=$resultPath+'.tmp'
  [IO.File]::WriteAllText($temporary,($state|ConvertTo-Json -Compress),$utf8)
  Move-Item -LiteralPath $temporary -Destination $resultPath -Force
  Log ($phase+': '+$message)
}
function Quoted([string]$value){return '"'+[regex]::Replace($value,'(\\+)$','$1$1')+'"'}
try {
  $updatePlan=Get-Content -LiteralPath $Plan -Raw -Encoding UTF8 | ConvertFrom-Json
  $appRoot=[IO.Path]::GetFullPath($updatePlan.root).TrimEnd('\')
  $staged=[IO.Path]::GetFullPath($updatePlan.file)
  $destination=[IO.Path]::GetFullPath((Join-Path $appRoot $updatePlan.name))
  $folder=Join-Path $appRoot 'workspace\data\updates'
  if($updatePlan.name -notmatch '^SpecFlow-Knowledge-Component-\d+\.\d+\.\d+-x64\.exe$'){throw 'Invalid component file name'}
  if(-not $destination.StartsWith($appRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Update destination is outside app root'}
  if(-not $staged.StartsWith($folder+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Update cache is outside app root'}
  $handshake=$updatePlan.schema -eq 2
  if($handshake -and $updatePlan.requestId -notmatch '^[a-f0-9]{32}$'){throw 'Invalid update request ID'}
  $arguments=@()
  if($handshake){
    $dataDir=[IO.Path]::GetFullPath($updatePlan.dataDir)
    $arguments=@('--data-dir',(Quoted $dataDir),'--update-token',$updatePlan.requestId)
    foreach($flag in $updatePlan.launchArgs){if($flag -notin @('--no-bundle','--offline-resources')){throw 'Invalid launch option'};$arguments+=@($flag)}
  }
  # The running app does not quit until it sees this exact request acknowledged.
  Result 'waiting_exit' $null 'Installer ready; waiting for the component and portable launcher to exit'
  $until=(Get-Date).AddSeconds(120)
  $owners=@($updatePlan.pid,$updatePlan.launcherPid)|Where-Object {$_ -and [int]$_ -gt 0 -and [int]$_ -ne $PID}
  foreach($owner in $owners){
    while((Get-Process -Id $owner -ErrorAction SilentlyContinue) -and (Get-Date) -lt $until){Start-Sleep -Milliseconds 200}
    if(Get-Process -Id $owner -ErrorAction SilentlyContinue){throw 'Previous component or portable launcher did not exit; installation cancelled'}
  }
  $oldExited=$true
  Result 'verifying' $null 'Verifying the staged executable checksum'
  $hashStream=[IO.File]::OpenRead($staged);$hasher=[Security.Cryptography.SHA256]::Create()
  try {$actualHash=[BitConverter]::ToString($hasher.ComputeHash($hashStream)).Replace('-','').ToLowerInvariant()} finally {$hashStream.Dispose();$hasher.Dispose()}
  if($actualHash -ne $updatePlan.sha256){throw 'Update checksum mismatch'}
  Copy-Item -LiteralPath $staged -Destination ($destination+'.new') -Force
  Move-Item -LiteralPath ($destination+'.new') -Destination $destination -Force
  $links=@($updatePlan.shortcuts | Where-Object { $_ })
  $shell=New-Object -ComObject WScript.Shell
  foreach($link in $links){if(Test-Path -LiteralPath $link){$shortcut=$shell.CreateShortcut($link);if($shortcut.TargetPath.StartsWith($appRoot+'\',[StringComparison]::OrdinalIgnoreCase)){$shortcut.TargetPath=$destination;$shortcut.WorkingDirectory=$appRoot;$shortcut.Save()}}}
  Result 'starting' $null 'Starting the updated interactive application'
  # This is the user's interactive program; hiding it caused an apparently dead restart.
  $start=@{FilePath=$destination;WorkingDirectory=$appRoot;WindowStyle='Normal';PassThru=$true}
  if($arguments.Count){$start.ArgumentList=$arguments}
  $launched=Start-Process @start
  if($handshake){
    $receipt=Join-Path $folder ('startup-'+$updatePlan.requestId+'.json')
    $seconds=120
    if($updatePlan.launchTimeoutSeconds){$seconds=[Math]::Min(180,[Math]::Max(2,[int]$updatePlan.launchTimeoutSeconds))}
    $deadline=(Get-Date).AddSeconds($seconds);$confirmed=$false
    while((Get-Date) -lt $deadline){
      if(Test-Path -LiteralPath $receipt){
        try{$ack=Get-Content -LiteralPath $receipt -Raw -Encoding UTF8|ConvertFrom-Json
          if($ack.requestId -eq $updatePlan.requestId -and $ack.version -eq $updatePlan.version -and $ack.visible -eq $true -and (Get-Process -Id $ack.pid -ErrorAction SilentlyContinue)){$confirmed=$true;break}
        }catch{}
      }
      Start-Sleep -Milliseconds 200
    }
    if(-not $confirmed){throw 'New version did not confirm a visible window and running service. Open the EXE manually and inspect desktop-error.log / install.log'}
  }
  Result 'complete' $true 'Updated service and interactive window confirmed'
} catch {
  Result 'failed' $false $_.Exception.Message
  # Do not start a second data writer while a new launcher may still be running.
  if($oldExited -and $updatePlan.previous -and (Test-Path -LiteralPath $updatePlan.previous) -and (-not $launched -or $launched.HasExited)){
    Log 'Reopening previous executable after a failed update'
    $fallback=@{FilePath=$updatePlan.previous;WorkingDirectory=$appRoot;WindowStyle='Normal'}
    if($updatePlan.dataDir){$fallback.ArgumentList=@('--data-dir',(Quoted $updatePlan.dataDir))}
    Start-Process @fallback
  }
  exit 1
}
