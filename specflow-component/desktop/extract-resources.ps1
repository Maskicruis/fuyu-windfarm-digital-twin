$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($env:SF_DEST).TrimEnd('\') + '\'
$archive = [IO.Compression.ZipFile]::OpenRead($env:SF_ARCHIVE)
try {
    $current = 0
    $total = $archive.Entries.Count
    foreach ($entry in $archive.Entries) {
        $entryPath = $entry.FullName.Replace('\', '/')
        $current++
        if ($current % 200 -eq 0 -or $current -eq 1) { [Console]::Out.WriteLine("SF_EXTRACT $current/$total") }
        $target = [IO.Path]::GetFullPath((Join-Path $root $entryPath))
        if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive entry escapes destination' }
        if ($entryPath.EndsWith('/')) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
        if ($env:SF_PRESERVE -eq '1' -and $entryPath.StartsWith('workspace/', [StringComparison]::OrdinalIgnoreCase) -and [IO.File]::Exists($target)) { continue }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
        $temporary = $target + '.sf-install-' + [Guid]::NewGuid().ToString('N')
        try {
            $inputStream = $entry.Open()
            $outputStream = [IO.File]::Create($temporary)
            try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
            if ([IO.File]::Exists($target)) { [IO.File]::Delete($target) }
            [IO.File]::Move($temporary, $target)
            [IO.File]::SetLastWriteTime($target, $entry.LastWriteTime.LocalDateTime)
        } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
    }
    [Console]::Out.WriteLine("SF_EXTRACT $total/$total")
} finally { $archive.Dispose() }
