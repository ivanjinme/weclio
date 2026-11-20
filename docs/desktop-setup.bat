@echo off
chcp 65001 >nul
setlocal
title Weclio 初始配置
cd /d "%~dp0"

set "DEST=%USERPROFILE%\.pi\agent"
set "STAMP="
for /f %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%T"
if not defined STAMP set "STAMP=manual"

echo ============================================
echo   Weclio 初始配置
echo ============================================
echo.
echo 将把 models.json 和 tavily.json 复制到：
echo   %DEST%
echo.

if not exist "%DEST%" mkdir "%DEST%" 2>nul
if not exist "%DEST%" (
  echo [失败] 无法创建目录 %DEST%
  echo.
  pause
  exit /b 1
)

for %%F in (models.json tavily.json) do (
  if not exist "%%F" (
    echo [跳过] 没找到 %%F，请确认它和本文件在同一个文件夹里。
  ) else (
    if exist "%DEST%\%%F" (
      copy /y "%DEST%\%%F" "%DEST%\%%F.bak-%STAMP%" >nul 2>&1
      echo [备份] 原有 %%F 已保存为 %%F.bak-%STAMP%
    )
    copy /y "%%F" "%DEST%\%%F" >nul 2>&1
    if errorlevel 1 (
      echo [失败] 复制 %%F 失败，请关闭正在运行的 Weclio 后重试。
    ) else (
      echo [完成] 已复制 %%F
    )
  )
)

echo.
echo 下一步：打开 Weclio，在「设置 - 模型」里选择要用的模型即可。
echo.
pause
