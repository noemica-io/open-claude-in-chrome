# Install script for Open Claude in Chrome extension on Windows.
# Registers the native messaging host for Chrome, Edge, and Brave.
#
# Usage: .\install.ps1 <extension-id> [extension-id-2] [extension-id-3] ...
#
# Pass one extension ID per browser. Each Chromium browser assigns a different
# ID when loading unpacked extensions.

param(
    [Parameter(Mandatory=$true)]
    [string[]]$ExtensionIds
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HostDir = Join-Path $ScriptDir "host"
$HostName = "com.anthropic.open_claude_in_chrome"
$NativeHostBat = Join-Path $HostDir "native-host.bat"
$ManifestPath = Join-Path $HostDir "$HostName.json"

# Verify node is available
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "node is not installed. Install Node.js first."
    exit 1
}

# Verify npm dependencies
if (-not (Test-Path (Join-Path $HostDir "node_modules"))) {
    Write-Host "Installing npm dependencies..."
    Push-Location $HostDir
    npm install
    Pop-Location
}

# Verify native-host.bat exists
if (-not (Test-Path $NativeHostBat)) {
    Write-Error "native-host.bat not found at $NativeHostBat"
    exit 1
}

# Build allowed_origins array
$Origins = ($ExtensionIds | ForEach-Object { "chrome-extension://$_/" }) -join ",`n    "

# Generate manifest
$Manifest = @"
{
  "name": "$HostName",
  "description": "Open Claude in Chrome Native Messaging Host",
  "path": "$($NativeHostBat -replace '\\', '\\')",
  "type": "stdio",
  "allowed_origins": [
    $Origins
  ]
}
"@

# Write manifest
$Manifest | Out-File -FilePath $ManifestPath -Encoding utf8 -NoNewline
Write-Host "Created manifest: $ManifestPath"

# Register for each installed browser
$Browsers = @(
    @{Name="Google Chrome"; Path="HKCU:\Software\Google\Chrome\NativeMessagingHosts"},
    @{Name="Microsoft Edge"; Path="HKCU:\Software\Microsoft Edge\NativeMessagingHosts"},
    @{Name="Brave Browser"; Path="HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts"}
)

foreach ($browser in $Browsers) {
    $keyPath = Join-Path $browser.Path $HostName
    try {
        New-Item -Path $keyPath -Force | Out-Null
        New-ItemProperty -Path $keyPath -Name "(default)" -Value $ManifestPath -PropertyType String -Force | Out-Null
        Write-Host "  Registered for $($browser.Name)"
    } catch {
        Write-Host "  Skipping $($browser.Name) (not installed or access denied)"
    }
}

Write-Host ""
Write-Host "Done! Next steps:"
Write-Host ""
Write-Host "  1. Restart your browser (close all windows and reopen)"
Write-Host "  2. Add the MCP server to Claude Code:"
Write-Host ""
Write-Host "     claude mcp add open-claude-in-chrome -- node $HostDir\mcp-server.js"
Write-Host ""
Write-Host "  3. Start a new Claude Code session and test:"
Write-Host ""
Write-Host '     Ask Claude: "Navigate to reddit.com and take a screenshot"'
