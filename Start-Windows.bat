@echo off
rem Guanchao chart launcher for Windows: opens the app in its own window (Edge/Chrome app mode).
setlocal
set "APP=%~dp0index.html"
set "URL=file:///%APP:\=/%"
for %%B in (
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
) do (
  if exist %%B (
    start "" %%B --app="%URL%" --window-size=1440,900
    exit /b 0
  )
)
rem No Edge/Chrome found: open with the default browser
start "" "%APP%"
