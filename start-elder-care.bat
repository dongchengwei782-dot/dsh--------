@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules\@deepseek-ai\dsh (
  echo First run: installing dependencies with npm install ...
  call npm install --no-fund --no-audit || goto :end
  node scripts\dsh.mjs plugin --profile web install || goto :end
)
echo Starting DeepSeek Harness (web profile), data dir: %~dp0.dsh-home
node scripts\dsh.mjs web
:end
pause
