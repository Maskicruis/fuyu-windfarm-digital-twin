param([Parameter(Mandatory=$true)][string]$Plan)
$ErrorActionPreference='Stop'
$updatePlan=Get-Content -LiteralPath $Plan -Raw -Encoding UTF8 | ConvertFrom-Json
$appRoot=[IO.Path]::GetFullPath($updatePlan.root)
$staged=[IO.Path]::GetFullPath($updatePlan.file)
$destination=[IO.Path]::GetFullPath((Join-Path $appRoot $updatePlan.name))
if($updatePlan.name -notmatch '^SpecFlow-Knowledge-Component-\d+\.\d+\.\d+-x64\.exe$'){throw 'Invalid component file name'}
if(-not $destination.StartsWith($appRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Update destination is outside app root'}
if(-not $staged.StartsWith((Join-Path $appRoot 'workspace\data\updates\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Update cache is outside app root'}
$resultPath=Join-Path $appRoot 'workspace\data\updates\last-result.json'
try {
  $until=(Get-Date).AddSeconds(120)
  while((Get-Process -Id $updatePlan.pid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $until){Start-Sleep -Milliseconds 300}
  if(Get-Process -Id $updatePlan.pid -ErrorAction SilentlyContinue){throw 'Component did not exit; installation cancelled'}
  $hashStream=[IO.File]::OpenRead($staged)
  $hasher=[Security.Cryptography.SHA256]::Create()
  try {$actualHash=[BitConverter]::ToString($hasher.ComputeHash($hashStream)).Replace('-','').ToLowerInvariant()} finally {$hashStream.Dispose();$hasher.Dispose()}
  if($actualHash -ne $updatePlan.sha256){throw 'Update checksum mismatch'}
  Copy-Item -LiteralPath $staged -Destination ($destination+'.new') -Force
  Move-Item -LiteralPath ($destination+'.new') -Destination $destination -Force
  $links=@($updatePlan.shortcuts | Where-Object { $_ })
  $shell=New-Object -ComObject WScript.Shell
  foreach($link in $links){if(Test-Path -LiteralPath $link){$shortcut=$shell.CreateShortcut($link);if($shortcut.TargetPath.StartsWith($appRoot+'\',[StringComparison]::OrdinalIgnoreCase)){$shortcut.TargetPath=$destination;$shortcut.WorkingDirectory=$appRoot;$shortcut.Save()}}}
  @{success=$true;version=$updatePlan.version;message='Component update installed';time=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
  Start-Process -FilePath $destination -WorkingDirectory $appRoot -WindowStyle Hidden
} catch {
  @{success=$false;message=$_.Exception.Message;time=(Get-Date).ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $resultPath -Encoding UTF8
  if($updatePlan.previous -and (Test-Path -LiteralPath $updatePlan.previous)){Start-Process -FilePath $updatePlan.previous -WorkingDirectory $appRoot -WindowStyle Hidden}
}
