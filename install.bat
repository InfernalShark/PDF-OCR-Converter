@echo off
chcp 65001 > nul
echo ============================================
echo   PDF OCR Converter — Установка зависимостей
echo ============================================
echo.

python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ОШИБКА] Python не найден! Установите Python 3.8+ с https://python.org
    pause
    exit /b 1
)

echo [OK] Python найден
echo.
echo Устанавливаю Python-пакеты...
pip install -r requirements.txt

if %errorlevel% neq 0 (
    echo.
    echo [ОШИБКА] Не удалось установить пакеты. Попробуйте запустить от имени администратора.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Установка завершена успешно!
echo ============================================
echo.
echo Следующие шаги:
echo.
echo 1. Установите Tesseract OCR (с поддержкой русского языка):
echo    https://github.com/UB-Mannheim/tesseract/wiki
echo    При установке отметьте: Russian + English language packs
echo.
echo 2. Установите Poppler для Windows:
echo    https://github.com/oschwartz10612/poppler-windows/releases
echo    Распакуйте архив в удобное место (например, C:\poppler)
echo.
echo 3. Запустите приложение: start.bat
echo.
pause
