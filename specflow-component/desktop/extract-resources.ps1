$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 otherwise writes localized errors in the OEM code page.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    Add-Type -Path (Join-Path $PSScriptRoot 'resource-extractor.cs') -ReferencedAssemblies System.IO.Compression,System.IO.Compression.FileSystem
    [SpecFlow.ResourceExtractor]::Extract($env:SF_ARCHIVE, $env:SF_DEST, ($env:SF_PRESERVE -eq '1'))
} catch {
    $message = $_.Exception.GetBaseException().Message
    [Console]::Error.WriteLine('SF_EXTRACT_ERROR ' + (@{message=$message} | ConvertTo-Json -Compress))
    exit 1
}
