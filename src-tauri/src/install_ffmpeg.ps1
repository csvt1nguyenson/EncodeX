param([string]$AppDirectory = '')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Find-EncodeXToolPair([string]$Root, [int]$Depth = 3) {
    if ([string]::IsNullOrWhiteSpace($Root)) { return $null }
    if ((Test-Path -LiteralPath (Join-Path $Root 'ffmpeg.exe') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Root 'ffprobe.exe') -PathType Leaf)) { return $Root }
    if ($Depth -le 0) { return $null }
    $directories = @(Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue |
        Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
        Sort-Object FullName | Select-Object -First 128)
    foreach ($directory in $directories) {
        $found = Find-EncodeXToolPair $directory.FullName ($Depth - 1)
        if ($found) { return $found }
    }
    return $null
}

function Find-EncodeXMediaTools([string]$AppDirectory) {
    $drive = if ($env:SystemDrive) { $env:SystemDrive } else { 'C:' }
    foreach ($name in @('Mybin', 'My Bin', 'My_Bin')) {
        $found = Find-EncodeXToolPair (Join-Path ($drive + '\') $name)
        if ($found) { return $found }
    }
    foreach ($directory in ($env:PATH -split ';')) {
        if (-not [string]::IsNullOrWhiteSpace($directory) -and [IO.Path]::IsPathRooted($directory)) {
            $found = Find-EncodeXToolPair $directory 0
            if ($found) { return $found }
        }
    }
    $found = Find-EncodeXToolPair (Join-Path $env:LOCALAPPDATA 'EncodeX\tools')
    if ($found) { return $found }
    if ($AppDirectory) { return Find-EncodeXToolPair (Join-Path $AppDirectory 'bin') 0 }
    return $null
}

$existing = Find-EncodeXMediaTools $AppDirectory
if ($existing) {
    Write-Output ('FFmpeg/FFprobe already installed: ' + $existing)
    exit 0
}

$toolsRoot = Join-Path $env:LOCALAPPDATA 'EncodeX\tools'
$stage = Join-Path $toolsRoot ('download-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    $url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
    $archive = Join-Path $stage 'ffmpeg.zip'
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    $candidates = New-Object System.Collections.ArrayList
    # GitHub is the provider's published mirror. API digest is bound to the asset.
    if (Test-Path -LiteralPath $curl) {
        try {
            $apiText = & $curl --fail --silent --show-error --location --connect-timeout 15 --max-time 30 'https://api.github.com/repos/GyanD/codexffmpeg/releases/latest'
            if ($LASTEXITCODE -eq 0) {
                $release = ([string]::Join("`n", @($apiText)) | ConvertFrom-Json)
                $asset = $release.assets | Where-Object { $_.name -like '*-essentials_build.zip' } | Select-Object -First 1
                if ($asset.browser_download_url -match '^https://github\.com/GyanD/codexffmpeg/releases/download/' -and $asset.digest -match '(?i)^sha256:([0-9a-f]{64})$') {
                    [void]$candidates.Add(@{ Url = $asset.browser_download_url; Hash = $Matches[1]; Label = 'GitHub mirror' })
                }
            }
        } catch { Write-Output 'FFmpeg: mirror metadata unavailable; trying main server.' }
    }
    try {
        if (Test-Path -LiteralPath $curl) {
            $checksumText = & $curl --fail --silent --show-error --location --connect-timeout 15 --max-time 30 ($url + '.sha256')
            if ($LASTEXITCODE -ne 0) { throw 'Cannot read main-server checksum.' }
        } else {
            $checksumText = (Invoke-WebRequest -UseBasicParsing -Uri ($url + '.sha256') -TimeoutSec 30).Content
        }
        $hash = [regex]::Match([string]$checksumText, '(?i)\b[0-9a-f]{64}\b').Value
        if ($hash) { [void]$candidates.Add(@{ Url = $url; Hash = $hash; Label = 'gyan.dev' }) }
    } catch { Write-Output 'FFmpeg: main-server metadata unavailable.' }
    $verified = $false
    foreach ($candidate in $candidates) {
        try {
            Write-Output ('FFmpeg: downloading from ' + $candidate.Label + '...')
            if (Test-Path -LiteralPath $curl) {
                & $curl --fail --silent --show-error --location --connect-timeout 20 --speed-limit 1024 --speed-time 25 --max-time 300 --output $archive $candidate.Url
                if ($LASTEXITCODE -ne 0) { throw 'Transfer failed or stalled.' }
            } else {
                Invoke-WebRequest -UseBasicParsing -Uri $candidate.Url -OutFile $archive -TimeoutSec 180
            }
            Write-Output 'FFmpeg: verifying SHA-256...'
            if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash -ne $candidate.Hash) { throw 'SHA-256 mismatch.' }
            $verified = $true
            break
        } catch { Write-Output ('FFmpeg: ' + $_.Exception.Message + ' Trying another source if available.') }
    }
    if (-not $verified) { throw 'No download source produced a verified FFmpeg package. Check Internet and retry.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        foreach ($tool in @('ffmpeg.exe', 'ffprobe.exe')) {
            $entries = @($zip.Entries | Where-Object { $_.FullName -match ('(?i)(^|/)bin/' + [regex]::Escape($tool) + '$') })
            if ($entries.Count -ne 1) { throw "Missing or ambiguous executable: $tool" }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], (Join-Path $stage $tool), $true)
        }
        # Preserve license and upstream readme alongside the downloaded tools.
        foreach ($name in @('LICENSE', 'README.txt')) {
            $entry = $zip.Entries | Where-Object { $_.Name -eq $name } | Select-Object -First 1
            if ($entry) { [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $stage $name), $true) }
        }
    } finally { $zip.Dispose() }
    Write-Output 'FFmpeg: validating ffmpeg and ffprobe...'
    foreach ($tool in @('ffmpeg.exe', 'ffprobe.exe')) {
        & (Join-Path $stage $tool) -version | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Cannot run $tool on this computer." }
    }
    # Publish the validated pair in a new directory. A failed attempt never
    # modifies an existing installation or adds anything to the system PATH.
    $published = Join-Path $toolsRoot ('release-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $published | Out-Null
    Get-ChildItem -LiteralPath $stage -File | Where-Object { $_.Name -ne 'ffmpeg.zip' } | Copy-Item -Destination $published
    Write-Output 'FFmpeg: installation complete.'
} catch {
    Write-Output ('ERROR: ' + $_.Exception.Message)
    exit 1
} finally {
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    $resolvedRoot = [IO.Path]::GetFullPath($toolsRoot).TrimEnd('\') + '\'
    if ($resolvedStage.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedStage)) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
