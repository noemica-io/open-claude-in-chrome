# install-windows.ps1 — Windows equivalent of install.sh (which supports macOS/Linux only).
# Registers the native messaging host for Chrome/Edge/Brave under HKCU (no admin needed).
#
# Usage (PowerShell):
#   .\install-windows.ps1 <extension-id> [<extension-id> ...]
#
# Get the extension id from chrome://extensions after loading the `extension/`
# folder unpacked (Developer mode → Load unpacked). Restart the browser fully
# afterwards so it re-reads native messaging manifests.

param(
  [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
  [string[]]$ExtensionIds
)

$ErrorActionPreference = 'Stop'
$HostName = 'com.anthropic.open_claude_in_chrome'
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$HostDir = Join-Path $RepoRoot 'host'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found on PATH. Install Node.js v18+ first.' }

if (-not (Test-Path (Join-Path $HostDir 'node_modules'))) {
  Write-Host "Installing host dependencies (npm install in $HostDir)..."
  Push-Location $HostDir
  npm install
  Pop-Location
}

# Wrapper .bat — the manifest's "path" must be a Windows-executable file.
$wrapper = Join-Path $HostDir 'native-host-wrapper.bat'
@"
@echo off
"$node" "$(Join-Path $HostDir 'native-host.js')" %*
"@ | Set-Content -Path $wrapper -Encoding ASCII
Write-Host "Wrote $wrapper"

# Native messaging host manifest.
$manifestPath = Join-Path $HostDir "$HostName.json"
$manifest = [ordered]@{
  name            = $HostName
  description     = 'Open Claude in Chrome native messaging host'
  path            = $wrapper
  type            = 'stdio'
  allowed_origins = @($ExtensionIds | ForEach-Object { "chrome-extension://$_/" })
}
$manifest | ConvertTo-Json | Set-Content -Path $manifestPath -Encoding UTF8
Write-Host "Wrote $manifestPath (allowed origins: $($ExtensionIds -join ', '))"

# Registry keys per Chromium browser (HKCU — current user only).
$regRoots = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
  'HKCU:\Software\Chromium\NativeMessagingHosts'
)
foreach ($root in $regRoots) {
  $key = Join-Path $root $HostName
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(Default)' -Value $manifestPath
  Write-Host "Registered $key"
}

Write-Host ''
Write-Host 'Done. Now:'
Write-Host '  1. Fully restart the browser (all windows) so it re-reads native messaging manifests.'
Write-Host "  2. MCP server command for your client: node `"$(Join-Path $HostDir 'mcp-server.js')`""
