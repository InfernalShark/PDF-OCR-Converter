"""
app.py — FastAPI сервер PDF OCR Converter v2.1
"""

import asyncio
import json
import os
import shutil
import subprocess
import threading
import time
import urllib.request
import uuid
import zipfile
from pathlib import Path
from typing import Optional

import aiofiles
import uvicorn
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import ocr_engine

# ────────────────────────────────────────────────────────────────────────────
# Пути
# ────────────────────────────────────────────────────────────────────────────

import sys

BASE_DIR   = Path(__file__).parent

# Поддержка PyInstaller
if getattr(sys, 'frozen', False):
    BUNDLE_DIR = Path(sys._MEIPASS)
    DATA_DIR = Path(sys.executable).parent
else:
    BUNDLE_DIR = BASE_DIR
    DATA_DIR = BASE_DIR

STATIC_DIR = BUNDLE_DIR / "static"

UPLOAD_DIR = DATA_DIR / "uploads"
OUTPUT_DIR = DATA_DIR / "output"
POPPLER_DIR = DATA_DIR / "poppler"
SETTINGS_FILE = DATA_DIR / "settings.json"

UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

# ────────────────────────────────────────────────────────────────────────────
# Приложение
# ────────────────────────────────────────────────────────────────────────────

app = FastAPI(title="PDF OCR Converter", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# ────────────────────────────────────────────────────────────────────────────
# Состояние задач
# ────────────────────────────────────────────────────────────────────────────

class JobState:
    def __init__(self):
        self.status: str = "pending"
        self.current_page: int = 0
        self.total_pages: int = 0
        self.message: str = "Ожидание..."
        self.output_path: Optional[str] = None
        self.output_filename: Optional[str] = None
        self.file_size_mb: float = 0.0
        self.error: Optional[str] = None
        self.cancel_flag: list = [False]
        self.events: list = []
        self.lock = threading.Lock()

    def push_event(self, data: dict) -> None:
        with self.lock:
            self.events.append(json.dumps(data))

    def pop_events(self) -> list[str]:
        with self.lock:
            evts = list(self.events)
            self.events.clear()
            return evts


jobs: dict[str, JobState] = {}

# ────────────────────────────────────────────────────────────────────────────
# Настройки
# ────────────────────────────────────────────────────────────────────────────

DEFAULT_SETTINGS = {
    "tesseract_path": r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    "poppler_path": "",
    "default_lang": "rus+eng",
    "default_dpi": 300,
    "default_psm": "auto",
}


def load_settings() -> dict:
    if SETTINGS_FILE.exists():
        try:
            data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            for k, v in DEFAULT_SETTINGS.items():
                data.setdefault(k, v)
            return data
        except Exception:
            pass
    return DEFAULT_SETTINGS.copy()


def save_settings(data: dict) -> None:
    SETTINGS_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )

# ────────────────────────────────────────────────────────────────────────────
# Основные роуты
# ────────────────────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def root():
    return HTMLResponse(content=(STATIC_DIR / "index.html").read_text(encoding="utf-8"))


@app.get("/api/settings")
async def get_settings():
    return load_settings()


class SettingsModel(BaseModel):
    tesseract_path: str
    poppler_path: str
    default_lang: str
    default_dpi: int
    default_psm: str = "auto"


@app.post("/api/settings")
async def post_settings(body: SettingsModel):
    save_settings(body.model_dump())
    return {"ok": True}


@app.post("/api/check-deps")
async def check_deps(body: SettingsModel):
    tess_ok, tess_msg = ocr_engine.check_tesseract(body.tesseract_path)
    pop_ok, pop_msg   = ocr_engine.check_poppler(body.poppler_path or None)
    langs = []
    if tess_ok:
        langs = ocr_engine.get_available_languages(body.tesseract_path)
    return {
        "tesseract": {"ok": tess_ok, "message": tess_msg},
        "poppler":   {"ok": pop_ok,  "message": pop_msg},
        "languages": langs,
    }


@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Поддерживаются только PDF файлы")

    job_id = str(uuid.uuid4())
    upload_path = UPLOAD_DIR / f"{job_id}.pdf"

    async with aiofiles.open(upload_path, "wb") as f:
        content = await file.read()
        await f.write(content)

    file_size_mb = len(content) / (1024 * 1024)

    try:
        page_count = ocr_engine.get_pdf_page_count(str(upload_path))
    except Exception:
        page_count = None

    return {
        "job_id": job_id,
        "filename": file.filename,
        "file_size_mb": round(file_size_mb, 2),
        "page_count": page_count,
    }


class ProcessRequest(BaseModel):
    job_id: str
    lang: str = "rus+eng"
    dpi: int = 300
    psm_mode: str = "auto"
    page_ranges: str = "all"
    output_filename: Optional[str] = None


@app.post("/api/process")
async def start_process(body: ProcessRequest):
    input_path = UPLOAD_DIR / f"{body.job_id}.pdf"
    if not input_path.exists():
        raise HTTPException(404, "Файл не найден. Сначала загрузите PDF.")
    if body.job_id in jobs and jobs[body.job_id].status == "processing":
        raise HTTPException(409, "Обработка уже запущена")

    settings = load_settings()
    out_name = body.output_filename or f"ocr_{body.job_id}.pdf"
    if not out_name.lower().endswith(".pdf"):
        out_name += ".pdf"
    output_path = OUTPUT_DIR / out_name

    job = JobState()
    job.status = "processing"
    job.output_filename = out_name
    jobs[body.job_id] = job

    def run_ocr():
        def on_progress(current: int, total: int, msg: str):
            job.current_page = current
            job.total_pages  = total
            job.message = msg
            job.push_event({
                "type": "progress", "current": current, "total": total,
                "message": msg, "percent": round(current / max(total, 1) * 100, 1),
            })

        result = ocr_engine.process_pdf(
            input_path=str(input_path), output_path=str(output_path),
            lang=body.lang, dpi=body.dpi, psm_mode=body.psm_mode,
            page_ranges_str=body.page_ranges,
            tesseract_path=settings["tesseract_path"],
            poppler_path=settings["poppler_path"] or None,
            progress_callback=on_progress, cancel_flag=job.cancel_flag,
        )

        if result["success"]:
            job.status = "done"
            job.output_path = str(output_path)
            job.file_size_mb = result.get("file_size_mb", 0)
            job.push_event({
                "type": "done", "output_filename": out_name,
                "file_size_mb": job.file_size_mb,
                "pages_processed": result["pages_processed"],
                "total_doc_pages": result.get("total_doc_pages", 0),
            })
        elif job.cancel_flag[0]:
            job.status = "cancelled"
            job.push_event({"type": "cancelled"})
        else:
            job.status = "error"
            job.error = result.get("error", "Неизвестная ошибка")
            job.push_event({"type": "error", "message": job.error})

    threading.Thread(target=run_ocr, daemon=True).start()
    return {"ok": True, "job_id": body.job_id}


@app.get("/api/progress/{job_id}")
async def sse_progress(job_id: str, request: Request):
    if job_id not in jobs:
        raise HTTPException(404, "Задача не найдена")
    job = jobs[job_id]

    async def event_generator():
        yield f"data: {json.dumps({'type': 'connected'})}\n\n"
        while True:
            if await request.is_disconnected():
                break
            for evt in job.pop_events():
                yield f"data: {evt}\n\n"
            if job.status in ("done", "error", "cancelled"):
                await asyncio.sleep(0.1)
                for evt in job.pop_events():
                    yield f"data: {evt}\n\n"
                break
            await asyncio.sleep(0.3)

    return StreamingResponse(event_generator(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/download/{job_id}")
async def download_file(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Задача не найдена")
    job = jobs[job_id]
    if job.status != "done" or not job.output_path:
        raise HTTPException(400, "Файл ещё не готов")
    output_path = Path(job.output_path)
    if not output_path.exists():
        raise HTTPException(404, "Файл не найден на диске")
    return FileResponse(path=str(output_path), filename=job.output_filename,
                        media_type="application/pdf")


@app.post("/api/cancel/{job_id}")
async def cancel_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Задача не найдена")
    jobs[job_id].cancel_flag[0] = True
    return {"ok": True}


@app.delete("/api/cleanup/{job_id}")
async def cleanup_job(job_id: str):
    """Удаляет временный загруженный файл после обработки."""
    upload_file = UPLOAD_DIR / f"{job_id}.pdf"
    if upload_file.exists():
        upload_file.unlink()
    if job_id in jobs:
        del jobs[job_id]
    return {"ok": True}


# ────────────────────────────────────────────────────────────────────────────
# Авто-установка Tesseract (через winget)
# ────────────────────────────────────────────────────────────────────────────

@app.get("/api/install/tesseract")
async def install_tesseract(request: Request):
    """Устанавливает Tesseract через winget, стримит прогресс по SSE."""

    async def generate():
        def sse(type_: str, msg: str, **kw):
            return f"data: {json.dumps({'type': type_, 'message': msg, **kw})}\n\n"

        yield sse("log", "Проверяю наличие winget...")

        # Проверяем winget
        try:
            proc = await asyncio.create_subprocess_exec(
                "winget", "--version",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            await proc.wait()
        except FileNotFoundError:
            yield sse("error", "winget не найден. Скачайте Tesseract вручную по ссылке ниже.")
            return

        yield sse("log", "winget найден. Запускаю установку Tesseract OCR...")
        yield sse("log", "⚠ Важно: после установки зайдите в настройки и укажите путь к tesseract.exe")

        try:
            proc = await asyncio.create_subprocess_exec(
                "winget", "install", "--id", "UB-Mannheim.TesseractOCR",
                "--accept-package-agreements", "--accept-source-agreements",
                "--silent",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )

            async for line in proc.stdout:
                text = line.decode("utf-8", errors="replace").strip()
                if text:
                    yield sse("log", text)

            await proc.wait()

            if proc.returncode == 0:
                # Проверяем стандартный путь установки
                default_path = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
                if Path(default_path).exists():
                    settings = load_settings()
                    settings["tesseract_path"] = default_path
                    save_settings(settings)
                    yield sse("done", "Tesseract установлен и путь сохранён автоматически!",
                              tesseract_path=default_path)
                else:
                    yield sse("done", "Tesseract установлен. Укажите путь к tesseract.exe в настройках.")
            elif proc.returncode == -1978335189:  # уже установлен
                yield sse("done", "Tesseract уже установлен!")
            else:
                yield sse("error", f"Ошибка установки (код {proc.returncode}). "
                                   "Попробуйте скачать вручную.")
        except Exception as e:
            yield sse("error", str(e))

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ────────────────────────────────────────────────────────────────────────────
# Авто-установка Poppler (скачивание с GitHub)
# ────────────────────────────────────────────────────────────────────────────

@app.get("/api/install/poppler")
async def install_poppler(request: Request):
    """Скачивает и распаковывает Poppler из GitHub releases."""

    async def generate():
        def sse(type_: str, msg: str, **kw):
            return f"data: {json.dumps({'type': type_, 'message': msg, **kw})}\n\n"

        try:
            yield sse("log", "Запрашиваю информацию о последней версии Poppler...")

            GITHUB_API = "https://api.github.com/repos/oschwartz10612/poppler-windows/releases/latest"

            def fetch_release_info():
                req = urllib.request.Request(GITHUB_API,
                    headers={"User-Agent": "PDF-OCR-Converter/2.1"})
                with urllib.request.urlopen(req, timeout=15) as r:
                    return json.loads(r.read())

            release = await asyncio.to_thread(fetch_release_info)
            tag = release.get("tag_name", "")

            download_url = None
            filename = None
            file_size = 0
            for asset in release.get("assets", []):
                if asset["name"].endswith(".zip"):
                    download_url = asset["browser_download_url"]
                    filename = asset["name"]
                    file_size = asset.get("size", 0)
                    break

            if not download_url:
                yield sse("error", "Не найден ZIP-архив в релизе GitHub.")
                return

            size_mb = file_size // 1024 // 1024
            yield sse("log", f"Найдена версия {tag}: {filename} ({size_mb} МБ)")
            yield sse("log", f"Скачиваю архив...")

            zip_path = BASE_DIR / "_poppler_tmp.zip"
            install_dir = POPPLER_DIR

            def download():
                urllib.request.urlretrieve(download_url, str(zip_path))

            await asyncio.to_thread(download)
            yield sse("log", "Скачивание завершено. Распаковываю...")

            if install_dir.exists():
                await asyncio.to_thread(shutil.rmtree, str(install_dir))

            def extract():
                with zipfile.ZipFile(str(zip_path), "r") as z:
                    z.extractall(str(install_dir))

            await asyncio.to_thread(extract)
            zip_path.unlink(missing_ok=True)

            # Найдём pdftoppm.exe
            bin_path = None
            for exe in install_dir.rglob("pdftoppm.exe"):
                bin_path = str(exe.parent)
                break

            if not bin_path:
                yield sse("error", "Не удалось найти pdftoppm.exe в архиве.")
                return

            # Сохраняем в настройки
            settings = load_settings()
            settings["poppler_path"] = bin_path
            save_settings(settings)

            yield sse("done",
                      f"Poppler {tag} установлен! Путь сохранён автоматически.",
                      poppler_path=bin_path)

        except urllib.error.URLError as e:
            yield sse("error", f"Ошибка сети: {e}. Проверьте подключение к интернету.")
        except Exception as e:
            yield sse("error", str(e))

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ────────────────────────────────────────────────────────────────────────────
# Запуск
# ────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import webbrowser

    print("=" * 50)
    print("  PDF OCR Converter v1.0.0")
    print("  http://localhost:8000")
    print("=" * 50)

    def open_browser():
        time.sleep(1.5)
        webbrowser.open("http://localhost:8000")

    threading.Thread(target=open_browser, daemon=True).start()
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="warning")
