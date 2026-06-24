"""
ocr_engine.py — Ядро OCR обработки PDF файлов.

Алгоритм:
  Tesseract генерирует PDF со встроенным текстовым слоем через
  image_to_pdf_or_hocr(extension='pdf'). Это обеспечивает правильную
  кодировку Unicode для кириллицы и других языков.

  Для каждой выбранной страницы:
    1. Конвертируем страницу PDF → изображение (pdf2image / Poppler)
    2. Tesseract → однострадничный PDF с изображением + текстовым слоем
    3. Вставляем страницу в итоговый документ (PyMuPDF)

  Примечание о математике:
    Tesseract плохо справляется со сложными формулами (дроби, интегралы,
    матрицы). Простые символы (±, ×, √, α, β...) распознаются нормально.
    Для серьёзного math-OCR используйте специализированные инструменты
    (pix2tex, Mathpix, LaTeX-OCR).
"""

import gc
import os
import tempfile
from pathlib import Path
from typing import Callable, List, Optional

import fitz  # PyMuPDF
import pytesseract
from pdf2image import convert_from_path
from PIL import Image


# ────────────────────────────────────────────────────────────────────────────
# Конфигурация путей
# ────────────────────────────────────────────────────────────────────────────

DEFAULT_TESSERACT_CMD = r"C:\Program Files\Tesseract-OCR\tesseract.exe"
DEFAULT_POPPLER_PATH: Optional[str] = None


def configure_paths(tesseract_path: str, poppler_path: Optional[str]) -> None:
    pytesseract.pytesseract.tesseract_cmd = tesseract_path
    global DEFAULT_POPPLER_PATH
    DEFAULT_POPPLER_PATH = poppler_path or None


# ────────────────────────────────────────────────────────────────────────────
# Проверка зависимостей
# ────────────────────────────────────────────────────────────────────────────

def check_tesseract(path: str = DEFAULT_TESSERACT_CMD) -> tuple[bool, str]:
    try:
        pytesseract.pytesseract.tesseract_cmd = path
        version = pytesseract.get_tesseract_version()
        return True, str(version)
    except Exception as e:
        return False, str(e)


def check_poppler(poppler_path: Optional[str] = None) -> tuple[bool, str]:
    try:
        doc = fitz.open()
        doc.new_page(width=100, height=100)
        pdf_bytes = doc.tobytes()
        doc.close()

        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            f.write(pdf_bytes)
            tmp_path = f.name

        try:
            imgs = convert_from_path(
                tmp_path, dpi=72, poppler_path=poppler_path,
                first_page=1, last_page=1,
            )
            if imgs:
                return True, "Poppler найден"
        finally:
            os.unlink(tmp_path)

    except Exception as e:
        return False, str(e)

    return False, "Неизвестная ошибка"


def get_pdf_page_count(pdf_path: str) -> int:
    """Возвращает количество страниц в PDF."""
    doc = fitz.open(pdf_path)
    count = doc.page_count
    doc.close()
    return count


def get_available_languages(tesseract_path: str = DEFAULT_TESSERACT_CMD) -> list[str]:
    try:
        pytesseract.pytesseract.tesseract_cmd = tesseract_path
        langs = pytesseract.get_languages(config="")
        return [l for l in langs if l != "osd"]
    except Exception:
        return ["rus", "eng"]


# ────────────────────────────────────────────────────────────────────────────
# Парсинг диапазонов страниц
# ────────────────────────────────────────────────────────────────────────────

def parse_page_ranges(ranges_str: str, total_pages: int) -> List[int]:
    """
    Парсит строку с диапазонами страниц в отсортированный список номеров.

    Форматы:
      "all"           → [1, 2, 3, ..., total_pages]
      "1-10"          → [1, 2, ..., 10]
      "1,5,10"        → [1, 5, 10]
      "1-5, 10, 15-20"→ [1,2,3,4,5,10,15,16,17,18,19,20]
      ""              → все страницы

    Страницы 1-индексированные. Выходит за пределы — обрезается.
    """
    s = ranges_str.strip().lower()

    if not s or s == "all" or s == "все":
        return list(range(1, total_pages + 1))

    pages: set[int] = set()

    for part in s.split(","):
        part = part.strip()
        if not part:
            continue

        if "-" in part:
            bounds = part.split("-", 1)
            try:
                start = int(bounds[0].strip())
                end = int(bounds[1].strip())
                if start > end:
                    start, end = end, start
                for p in range(start, end + 1):
                    if 1 <= p <= total_pages:
                        pages.add(p)
            except ValueError:
                continue
        else:
            try:
                p = int(part)
                if 1 <= p <= total_pages:
                    pages.add(p)
            except ValueError:
                continue

    return sorted(pages)


# ────────────────────────────────────────────────────────────────────────────
# PSM режимы Tesseract
# ────────────────────────────────────────────────────────────────────────────

PSM_MODES = {
    "auto":   ("3",  "Авто-разметка (по умолчанию)"),
    "column": ("4",  "Один столбец текста"),
    "block":  ("6",  "Однородный блок текста"),
    "sparse": ("11", "Разреженный текст (таблицы, списки)"),
    "math":   ("6",  "Математика (улучшенный, но Tesseract ограничен)"),
}


def _build_tesseract_config(psm_mode: str, math_mode: bool = False) -> str:
    """Строит строку конфигурации Tesseract."""
    psm = PSM_MODES.get(psm_mode, PSM_MODES["auto"])[0]

    config_parts = [f"--oem 3 --psm {psm}"]

    if math_mode or psm_mode == "math":
        # Для математики: отключаем некоторые эвристики, улучшаем точность
        config_parts.append("-c tessedit_do_invert=0")
        config_parts.append("-c language_model_penalty_non_freq_dict_word=0.1")

    return " ".join(config_parts)


# ────────────────────────────────────────────────────────────────────────────
# Основная функция обработки
# ────────────────────────────────────────────────────────────────────────────

def process_pdf(
    input_path: str,
    output_path: str,
    lang: str = "rus+eng",
    dpi: int = 300,
    psm_mode: str = "auto",
    page_ranges_str: str = "all",
    tesseract_path: str = DEFAULT_TESSERACT_CMD,
    poppler_path: Optional[str] = None,
    progress_callback: Optional[Callable[[int, int, str], None]] = None,
    cancel_flag: Optional[list] = None,
) -> dict:
    """
    Конвертирует выбранные страницы сканированного PDF в searchable PDF.

    Args:
        input_path:       Путь к входному PDF
        output_path:      Путь к выходному PDF
        lang:             Языки OCR (напр. "rus+eng")
        dpi:              DPI для конвертации (150–400)
        psm_mode:         Режим Tesseract PSM: auto|column|block|sparse|math
        page_ranges_str:  Диапазоны страниц: "all", "1-10", "1,3,5-10"
        tesseract_path:   Путь к tesseract.exe
        poppler_path:     Путь к папке bin Poppler
        progress_callback: fn(current, total, message)
        cancel_flag:      [False] — установить True для отмены
    """
    if cancel_flag is None:
        cancel_flag = [False]

    pytesseract.pytesseract.tesseract_cmd = tesseract_path

    def report(current: int, total: int, msg: str) -> None:
        if progress_callback:
            progress_callback(current, total, msg)

    try:
        # ── 1. Количество страниц в документе ────────────────────────────
        total_doc_pages = get_pdf_page_count(input_path)

        # ── 2. Парсим выбранные страницы ──────────────────────────────────
        selected_pages = parse_page_ranges(page_ranges_str, total_doc_pages)

        if not selected_pages:
            return {
                "success": False,
                "pages_processed": 0,
                "output_path": None,
                "error": f"Ни одна страница не выбрана. В документе {total_doc_pages} стр.",
            }

        total_selected = len(selected_pages)
        report(0, total_selected,
               f"Выбрано {total_selected} стр. из {total_doc_pages} (диапазон: {page_ranges_str})")

        # ── 3. Конфигурация Tesseract ──────────────────────────────────────
        math_mode = psm_mode == "math"
        tess_config = _build_tesseract_config(psm_mode, math_mode)
        report(0, total_selected, f"Конфиг OCR: lang={lang}, psm={psm_mode}, dpi={dpi}")

        # ── 4. Итоговый PDF документ ───────────────────────────────────────
        out_doc = fitz.open()

        # ── 5. Обработка страниц ───────────────────────────────────────────
        for idx, page_num in enumerate(selected_pages, start=1):
            if cancel_flag[0]:
                out_doc.close()
                return {
                    "success": False,
                    "pages_processed": idx - 1,
                    "output_path": None,
                    "error": "Обработка отменена пользователем",
                }

            report(
                idx, total_selected,
                f"[{idx}/{total_selected}] Стр. {page_num}: конвертация в изображение...",
            )

            # PDF страница → изображение
            images = convert_from_path(
                input_path,
                dpi=dpi,
                first_page=page_num,
                last_page=page_num,
                poppler_path=poppler_path,
                fmt="ppm",
            )

            if not images:
                report(idx, total_selected,
                       f"[{idx}/{total_selected}] Стр. {page_num}: пропускаю (не удалось конвертировать)")
                continue

            pil_img: Image.Image = images[0]

            report(
                idx, total_selected,
                f"[{idx}/{total_selected}] Стр. {page_num}: OCR ({lang})...",
            )

            # Tesseract → PDF с правильной кодировкой Unicode
            try:
                page_pdf_bytes: bytes = pytesseract.image_to_pdf_or_hocr(
                    pil_img,
                    lang=lang,
                    config=tess_config,
                    extension="pdf",
                )
            except Exception as ocr_err:
                report(
                    idx, total_selected,
                    f"[{idx}/{total_selected}] Стр. {page_num}: OCR ошибка: {ocr_err}",
                )
                page_pdf_bytes = _image_to_plain_pdf(pil_img)

            # Вставляем страницу в итоговый документ
            page_doc = fitz.open("pdf", page_pdf_bytes)
            out_doc.insert_pdf(page_doc, from_page=0, to_page=0)
            page_doc.close()

            del pil_img, images, page_pdf_bytes
            gc.collect()

        # ── 6. Сохраняем ──────────────────────────────────────────────────
        report(total_selected, total_selected, "Сохраняю итоговый PDF...")

        out_doc.save(
            output_path,
            garbage=4,
            deflate=True,
            clean=True,
        )
        out_doc.close()

        file_size_mb = Path(output_path).stat().st_size / (1024 * 1024)
        report(
            total_selected, total_selected,
            f"Готово! {Path(output_path).name} ({file_size_mb:.1f} МБ) — {total_selected} стр.",
        )

        return {
            "success": True,
            "pages_processed": total_selected,
            "total_doc_pages": total_doc_pages,
            "selected_pages": selected_pages,
            "output_path": output_path,
            "file_size_mb": round(file_size_mb, 2),
            "error": None,
        }

    except Exception as e:
        import traceback
        return {
            "success": False,
            "pages_processed": 0,
            "output_path": None,
            "error": f"{e}\n\n{traceback.format_exc()}",
        }


# ────────────────────────────────────────────────────────────────────────────
# Запасной вариант: страница только с изображением
# ────────────────────────────────────────────────────────────────────────────

def _image_to_plain_pdf(img: Image.Image) -> bytes:
    """Создаёт PDF только с изображением (без текстового слоя)."""
    import io

    doc = fitz.open()
    w_px, h_px = img.size
    scale = 72.0 / 150
    page = doc.new_page(width=w_px * scale, height=h_px * scale)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    page.insert_image(
        fitz.Rect(0, 0, w_px * scale, h_px * scale),
        stream=buf.getvalue(),
    )

    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes
