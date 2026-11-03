@echo off
chcp 65001 >nul
set "PYTHONUTF8=1"
"%~dp0..\engines\python\python.exe" "%~dp0install.py" --root "%~dp0.."
if errorlevel 1 (
  echo 修复未完成，请查看上面的原因。
) else (
  echo 修复完成。请在文档数据库中对失败的文件点击“重解析”，继续使用已保存的检查点。
)
pause
