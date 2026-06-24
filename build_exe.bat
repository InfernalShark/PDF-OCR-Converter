@echo off
echo Building PDF OCR Converter...
pyinstaller --name "PDF_OCR_Converter" --onefile --noconsole --add-data "static;static" app.py
echo Build complete. Executable is in the dist/ folder.
