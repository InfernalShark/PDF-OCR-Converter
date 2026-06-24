@echo off
chcp 65001 > nul
echo ============================================
echo   PDF OCR Converter — Запуск
echo ============================================
echo.
echo Открываю браузер...
start http://localhost:8000
echo.
echo Сервер запущен. Не закрывайте это окно!
echo Для остановки нажмите Ctrl+C
echo.
python app.py
pause
