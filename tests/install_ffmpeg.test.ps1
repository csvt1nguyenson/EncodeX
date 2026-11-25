$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'install_ffmpeg.ps1'
if (-not (Test-Path -LiteralPath $scriptPath)) {
    $scriptPath = Join-Path $PSScriptRoot '..\src-tauri\src\install_ffmpeg.ps1'
}
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$null, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($function in $ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] }) {
    . ([scriptblock]::Create($function.Extent.Text))
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('encodex-tools-test-' + [guid]::NewGuid().ToString('N'))
try {
    $bin = Join-Path $root 'release\bin'
    New-Item -ItemType Directory -Path $bin -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $bin 'ffmpeg.exe'), 'fixture')
    if (Find-EncodeXToolPair $root) { throw 'An incomplete tool pair was accepted.' }
    [IO.File]::WriteAllText((Join-Path $bin 'ffprobe.exe'), 'fixture')
    if ((Find-EncodeXToolPair $root) -ne $bin) { throw 'Nested ffmpeg/ffprobe were not found.' }
    if (Find-EncodeXToolPair $root 1) { throw 'The configured scan depth was exceeded.' }
    if (Find-EncodeXToolPair (Join-Path $root 'missing')) { throw 'A missing installation was accepted.' }
    Write-Output 'PASS: complete pair, incomplete pair, missing path, bounded nested scan, PowerShell syntax.'
} finally {
    $resolvedRoot = [IO.Path]::GetFullPath($root)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolvedRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
