@echo off
title FileSearch Portal
cd /d C:\Ransack

echo.
echo  Starting FileSearch...
echo.

:: Install npm packages if missing
if not exist "C:\Ransack\node_modules\adm-zip" (
    echo  First run - installing packages...
    npm install adm-zip node-stream-zip tar --prefix "C:\Ransack"
    echo.
)

:: Open browser after 3 second delay (runs in background)
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3847"

:: Start server (this keeps the window open)
echo  Server starting at http://localhost:3847
echo  Keep this window open. Close it to stop the server.
echo.
"C:\Program Files\nodejs\node.exe" C:\Ransack\server.js

pause
