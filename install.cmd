@echo off
setlocal enabledelayedexpansion

REM Install script for Open Claude in Chrome extension (Windows).
REM Registers the native messaging host for Chrome, Edge, and Brave.
REM
REM Usage: install.cmd <extension-id> [extension-id-2] [extension-id-3] ...

if "%~1"=="" (
    echo Usage: install.cmd ^<extension-id^> [extension-id-2] ...
    echo.
    echo Pass one extension ID per browser you want to use.
    echo Each browser assigns a different ID to the same unpacked extension.
    echo.
    echo Steps:
    echo   1. Open chrome://extensions, edge://extensions, and/or brave://extensions
    echo   2. Enable Developer Mode
    echo   3. Click 'Load unpacked' and select the extension\ directory
    echo   4. Copy the extension ID shown under the extension name
    echo   5. Repeat for each browser
    echo   6. Run: install.cmd ^<chrome-id^> ^<edge-id^> ^<brave-id^>
    exit /b 1
)

set "SCRIPT_DIR=%~dp0"
set "HOST_DIR=%SCRIPT_DIR%host"
set "WRAPPER_PATH=%HOST_DIR%\native-host-wrapper.cmd"
set "HOST_NAME=com.anthropic.open_claude_in_chrome"
set "MANIFEST_DIR=%LOCALAPPDATA%\Google\Chrome\NativeMessagingHosts"
set "MANIFEST_PATH=%MANIFEST_DIR%\%HOST_NAME%.json"

REM Verify node is available
where node >nul 2>nul
if errorlevel 1 (
    echo Error: node is not installed. Install Node.js first.
    exit /b 1
)
for /f "delims=" %%i in ('where node') do set "NODE_PATH=%%i"

REM Install npm dependencies
if not exist "%HOST_DIR%\node_modules" (
    echo Installing npm dependencies...
    pushd "%HOST_DIR%"
    call npm install
    if errorlevel 1 (
        echo Error: npm install failed.
        popd
        exit /b 1
    )
    popd
)

REM Create the native host wrapper
(
    echo @echo off
    echo "%NODE_PATH%" "%%~dp0native-host.js"
)> "%WRAPPER_PATH%"

echo Created native host wrapper: %WRAPPER_PATH%

REM Collect extension IDs
set "COUNT=0"
:parse_args
if "%~1"=="" goto done_args
set "EXT_ID[!COUNT!]=%~1"
set /a COUNT+=1
shift
goto parse_args
:done_args

REM Generate manifest JSON
if not exist "%MANIFEST_DIR%" mkdir "%MANIFEST_DIR%"
set "JSON_PATH=%WRAPPER_PATH:\=\\%"

> "%MANIFEST_PATH%" echo {
>> "%MANIFEST_PATH%" echo   "name": "%HOST_NAME%",
>> "%MANIFEST_PATH%" echo   "description": "Open Claude in Chrome Native Messaging Host",
>> "%MANIFEST_PATH%" echo   "path": "%JSON_PATH%",
>> "%MANIFEST_PATH%" echo   "type": "stdio",
>> "%MANIFEST_PATH%" echo   "allowed_origins": [
set /a LAST=COUNT-1
for /l %%i in (0,1,!LAST!) do (
    if %%i lss !LAST! (
        >> "%MANIFEST_PATH%" echo     "chrome-extension://!EXT_ID[%%i]!/",
    ) else (
        >> "%MANIFEST_PATH%" echo     "chrome-extension://!EXT_ID[%%i]!/"
    )
)
>> "%MANIFEST_PATH%" echo   ]
>> "%MANIFEST_PATH%" echo }

echo Created manifest: %MANIFEST_PATH%
echo.
echo Installing native messaging host for browsers...

REM Register for Chrome
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /ve /d "%MANIFEST_PATH%" /f >nul 2>nul
    echo   Registered for Google Chrome
) else (
    echo   Skipping Google Chrome ^(not installed^)
)

REM Register for Edge
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /ve /d "%MANIFEST_PATH%" /f >nul 2>nul
    echo   Registered for Microsoft Edge
) else if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /ve /d "%MANIFEST_PATH%" /f >nul 2>nul
    echo   Registered for Microsoft Edge
) else (
    echo   Skipping Microsoft Edge ^(not installed^)
)

REM Register for Brave
if exist "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" (
    reg add "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST_NAME%" /ve /d "%MANIFEST_PATH%" /f >nul 2>nul
    echo   Registered for Brave Browser
) else (
    echo   Skipping Brave Browser ^(not installed^)
)

echo.
echo Done! Next steps:
echo.
echo   1. Restart your browser (close all windows and reopen)
echo   2. Add the MCP server to Claude Code:
echo.
echo      claude mcp add open-claude-in-chrome -- node "%HOST_DIR%\mcp-server.js"
echo.
echo   3. Start a new Claude Code session and test:
echo.
echo      Ask Claude: "Navigate to reddit.com and take a screenshot"
echo.
