# Open Claude in Chrome - Windows Install Script
# Run this AFTER loading the extension in Chrome
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1 <extension-id>

param(
    [Parameter(Mandatory=$true)]
    [string]$ExtensionId
)

$HostName = "com.anthropic.open_claude_in_chrome"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HostDir = Join-Path $ScriptDir "host"
$ManifestPath = Join-Path $HostDir "native-messaging-host.json"

# Generate the native-host.bat launcher
$BatPath = Join-Path $HostDir "native-host.bat"
$NodePath = (Get-Command node -ErrorAction Stop).Source
@"
@echo off
"$NodePath" "$HostDir\native-host.mjs"
"@ | Out-File -FilePath $BatPath -Encoding ASCII
Write-Host "[OK] Created native-host.bat"

# Generate the native messaging host manifest
$manifest = @{
    name = $HostName
    description = "Open Claude in Chrome Native Messaging Host"
    path = $BatPath
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifestJson = $manifest | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText($ManifestPath, $manifestJson, (New-Object System.Text.UTF8Encoding $false))
Write-Host "[OK] Created manifest: $ManifestPath"

# Register native messaging host in registry (correct subkey format)
$browsers = @{
    "Google Chrome" = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
    "Microsoft Edge" = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
    "Brave Browser" = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
}

foreach ($browser in $browsers.GetEnumerator()) {
    New-Item -Path $browser.Value -Force | Out-Null
    Set-ItemProperty -Path $browser.Value -Name "(Default)" -Value $ManifestPath
    Write-Host "[OK] Registered for $($browser.Key)"
}

Write-Host ""
Write-Host "Done! Next steps:"
Write-Host "  1. RESTART Chrome (close ALL windows, then reopen)"
Write-Host "  2. Run: claude mcp add open-claude-in-chrome -- node $HostDir\mcp-server.js"
Write-Host "  3. Start a new Claude Code session and test!"
