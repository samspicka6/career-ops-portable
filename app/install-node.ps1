# app/install-node.ps1 - used by "_Start Career-Ops (Windows).bat" when the
# computer has no Node.js and winget is not available: downloads the current
# Node.js LTS installer (.msi) from nodejs.org and runs it.
$ErrorActionPreference = 'Stop'
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$base = 'https://nodejs.org/dist/latest-v24.x'
$sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content -split "`n"
$line = $sums | Where-Object { $_ -match "-$arch\.msi\s*$" } | Select-Object -First 1
if (-not $line) { throw 'Could not find the Node.js installer.' }
$name = ($line.Trim() -split '\s+')[1]
$out = Join-Path $env:TEMP $name
Write-Host "Downloading $name ..."
Invoke-WebRequest -UseBasicParsing "$base/$name" -OutFile $out
Write-Host 'Opening the Node.js installer. Click Next through it, then come back to this window.'
Start-Process msiexec.exe -ArgumentList '/i', "`"$out`"" -Wait
