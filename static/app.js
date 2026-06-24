/* ════════════════════════════════════════════════════════
   app.js — PDF OCR Converter v2.1
   ════════════════════════════════════════════════════════ */

'use strict';

// ── Глобальное состояние ──────────────────────────────────
const state = {
  currentJobId: null,
  uploadedFilename: null,
  totalDocPages: 0,
  eventSource: null,
  resultFilename: null,
};

// ── Навигация ─────────────────────────────────────────────
function showSection(name) {
  document.querySelectorAll('.section').forEach(s => {
    s.classList.toggle('active', s.id === `section-${name}`);
    s.classList.toggle('hidden', s.id !== `section-${name}`);
  });
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.classList.toggle('active', b.id === `nav-${name}`)
  );
  if (name === 'settings') loadSettings();
}

// ── Init ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  injectSvgGradient();
});

function injectSvgGradient() {
  const svg = document.querySelector('.progress-ring');
  if (!svg) return;
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <linearGradient id="gradient-stroke" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#6366f1"/>
      <stop offset="50%" stop-color="#8b5cf6"/>
      <stop offset="100%" stop-color="#06b6d4"/>
    </linearGradient>`;
  svg.prepend(defs);
}

// ── Загрузка файла ────────────────────────────────────────
function handleDragOver(e) { e.preventDefault(); document.getElementById('drop-zone').classList.add('dragover'); }
function handleDragLeave() { document.getElementById('drop-zone').classList.remove('dragover'); }
function handleDrop(e) {
  e.preventDefault();
  document.getElementById('drop-zone').classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFileSelect(file);
}

async function handleFileSelect(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    showToast('Пожалуйста, выберите PDF файл', 'error');
    return;
  }

  // Показываем информацию о файле
  document.getElementById('file-name-display').textContent = file.name;
  document.getElementById('file-size-display').textContent = formatSize(file.size);
  document.getElementById('file-info').classList.remove('hidden');
  document.getElementById('drop-zone').style.display = 'none';

  // Автозаполняем имя выходного файла
  document.getElementById('output-name').value =
    file.name.replace(/\.pdf$/i, '') + '_ocr.pdf';

  const startBtn = document.getElementById('start-btn');
  startBtn.disabled = true;
  startBtn.innerHTML = spinnerBtnHtml('Загрузка файла...');

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Ошибка загрузки');

    state.currentJobId = data.job_id;
    state.uploadedFilename = data.filename;
    state.totalDocPages = data.page_count || 0;

    if (data.page_count) {
      document.getElementById('page-count-text').textContent = `${data.page_count} стр.`;
      document.getElementById('page-count-badge').classList.remove('hidden');
      updatePageRangePresets(data.page_count);
    }

    document.getElementById('options-card').classList.remove('hidden');
    startBtn.disabled = false;
    startBtn.innerHTML = playBtnHtml();
    updateRunSummary();
    addLog(`Файл загружен: ${data.filename} (${data.file_size_mb} МБ, ${data.page_count || '?'} стр.)`, 'ok');

  } catch (err) {
    showToast(`Ошибка загрузки: ${err.message}`, 'error');
    resetFile();
  }
}

// ════════════════════════════════════════════════════════
// КЛЮЧЕВОЙ ФИХ: сброс file-input чтобы повторно выбрать
// тот же или другой файл без обновления страницы
// ════════════════════════════════════════════════════════
function resetFile() {
  state.currentJobId = null;
  state.uploadedFilename = null;
  state.totalDocPages = 0;

  // ⚡ Сброс file input — это фикс главного бага
  const fileInput = document.getElementById('file-input');
  if (fileInput) fileInput.value = '';

  document.getElementById('file-info').classList.add('hidden');
  document.getElementById('drop-zone').style.display = '';
  document.getElementById('options-card').classList.add('hidden');
  document.getElementById('page-count-badge').classList.add('hidden');
  document.getElementById('page-range-preview').classList.add('hidden');
  document.getElementById('run-summary').classList.add('hidden');

  const startBtn = document.getElementById('start-btn');
  startBtn.disabled = true;
  startBtn.innerHTML = playBtnHtml();

  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.preset-btn')?.classList.add('active');
  document.getElementById('page-ranges').value = '';
  document.getElementById('output-name').value = '';
}

// ── Пресеты страниц ───────────────────────────────────────
function updatePageRangePresets(total) {
  const half = Math.floor(total / 2);
  const ph = document.getElementById('preset-half');
  const ps = document.getElementById('preset-second');
  if (ph) ph.dataset.range = `1-${half}`;
  if (ps) ps.dataset.range = `${half + 1}-${total}`;
}

function setPagePreset(name, btn) {
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const total = state.totalDocPages;
  const input = document.getElementById('page-ranges');

  switch (name) {
    case 'all':    input.value = ''; document.getElementById('page-range-preview').classList.add('hidden'); break;
    case 'first10': input.value = `1-${Math.min(10, total)}`; break;
    case 'first50': input.value = `1-${Math.min(50, total)}`; break;
    case 'half': case 'second': input.value = btn.dataset.range || ''; break;
  }
  validatePageRange(input);
  updateRunSummary();
}

// ── Валидация диапазона ───────────────────────────────────
function validatePageRange(input) {
  const preview = document.getElementById('page-range-preview');
  const val = input.value.trim();

  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));

  if (!val) {
    preview.classList.add('hidden');
    document.querySelector('.preset-btn')?.classList.add('active');
    updateRunSummary();
    return;
  }

  const result = parsePageRangesJS(val, state.totalDocPages || 9999);
  preview.classList.remove('hidden');

  if (result.error) {
    preview.className = 'page-range-preview error';
    preview.textContent = `Ошибка: ${result.error}`;
  } else {
    preview.className = 'page-range-preview';
    const pages = result.pages;
    preview.textContent = pages.length <= 20
      ? `Выбрано ${pages.length} стр.: ${pages.join(', ')}`
      : `Выбрано ${pages.length} стр.: ${pages.slice(0, 8).join(', ')} … ${pages.slice(-4).join(', ')}`;
  }
  updateRunSummary();
}

function parsePageRangesJS(str, total) {
  const pages = new Set();
  for (const part of str.split(',')) {
    const p = part.trim();
    if (!p) continue;
    if (p.includes('-')) {
      const [a, b] = p.split('-').map(x => parseInt(x.trim()));
      if (isNaN(a) || isNaN(b)) return { error: `Неверный диапазон: "${p}"` };
      const [start, end] = [Math.min(a, b), Math.max(a, b)];
      if (start < 1) return { error: 'Страница не может быть меньше 1' };
      for (let i = start; i <= Math.min(end, total); i++) pages.add(i);
    } else {
      const n = parseInt(p);
      if (isNaN(n)) return { error: `Неверный номер: "${p}"` };
      if (n < 1) return { error: 'Страница не может быть меньше 1' };
      if (n <= total) pages.add(n);
    }
  }
  if (pages.size === 0) return { error: 'Ни одна страница не попала в диапазон' };
  return { pages: [...pages].sort((a, b) => a - b) };
}

// ── PSM ───────────────────────────────────────────────────
const PSM_HINTS = {
  'auto':   'Авто-определение структуры (лучший выбор для книг)',
  'column': 'Для документов с одним столбцом текста',
  'block':  'Для страниц с однородным текстом без разметки',
  'sparse': 'Для таблиц, формуляров, разреженного текста',
  'math':   '⚠ Частичная поддержка — только простые символы (±, √, α, β...)',
};

function onPsmChange(value) {
  document.getElementById('psm-hint').textContent = PSM_HINTS[value] || '';
  document.getElementById('math-warning').classList.toggle('hidden', value !== 'math');
  updateRunSummary();
}

// ── Сводка ────────────────────────────────────────────────
function updateRunSummary() {
  const summary = document.getElementById('run-summary');
  if (!state.currentJobId) { summary.classList.add('hidden'); return; }

  const rangeVal = document.getElementById('page-ranges')?.value.trim() || '';
  const lang     = document.getElementById('lang-select')?.value || '';
  const dpi      = document.getElementById('dpi-select')?.value || '';
  const psm      = document.getElementById('psm-select')?.value || '';

  let pagesText;
  if (!rangeVal) {
    pagesText = state.totalDocPages ? `Все ${state.totalDocPages} стр.` : 'Все страницы';
  } else {
    const parsed = parsePageRangesJS(rangeVal, state.totalDocPages || 9999);
    pagesText = parsed.error ? '⚠ Ошибка диапазона' : `${parsed.pages.length} стр.`;
  }

  const langLabels = { 'rus+eng': '🇷🇺+🇬🇧', 'rus': '🇷🇺 Рус', 'eng': '🇬🇧 Eng' };
  const psmLabels  = { 'auto': 'Авто', 'column': 'Столбец', 'block': 'Блок', 'sparse': 'Таблица', 'math': '⚠ Мат.' };

  document.getElementById('summary-pages').innerHTML = `<strong>${pagesText}</strong>`;
  document.getElementById('summary-lang').innerHTML  = langLabels[lang] || lang;
  document.getElementById('summary-dpi').innerHTML   = `<strong>${dpi}</strong> DPI`;
  document.getElementById('summary-mode').innerHTML  = `Режим: <strong>${psmLabels[psm] || psm}</strong>`;
  summary.classList.remove('hidden');
}

// ── Запуск OCR ────────────────────────────────────────────
async function startProcessing() {
  if (!state.currentJobId) {
    showToast('Сначала загрузите PDF файл', 'error');
    return;
  }

  const rangeVal   = document.getElementById('page-ranges').value.trim();
  const lang       = document.getElementById('lang-select').value;
  const dpi        = parseInt(document.getElementById('dpi-select').value);
  const psmMode    = document.getElementById('psm-select').value;
  const outputName = document.getElementById('output-name').value.trim() || 'ocr_result.pdf';

  if (rangeVal) {
    const parsed = parsePageRangesJS(rangeVal, state.totalDocPages || 9999);
    if (parsed.error) { showToast(`Ошибка диапазона: ${parsed.error}`, 'error'); return; }
  }

  document.getElementById('options-card').classList.add('hidden');
  document.getElementById('upload-card').classList.add('hidden');
  document.getElementById('progress-card').classList.remove('hidden');
  document.getElementById('result-card').classList.add('hidden');
  document.getElementById('error-card').classList.add('hidden');
  document.getElementById('cancel-btn').disabled = false;

  clearLog();
  setProgress(0, 0, 'Запуск обработки...');

  try {
    const res = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job_id: state.currentJobId, lang, dpi,
        psm_mode: psmMode, page_ranges: rangeVal || 'all',
        output_filename: outputName,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Ошибка запуска');
    connectSSE(state.currentJobId, outputName);
  } catch (err) {
    showError(err.message);
  }
}

// ── SSE прогресс ─────────────────────────────────────────
function connectSSE(jobId, outputName) {
  state.eventSource?.close();
  const es = new EventSource(`/api/progress/${jobId}`);
  state.eventSource = es;
  es.onmessage = e => { try { handleSSEEvent(JSON.parse(e.data), outputName); } catch {} };
  es.onerror   = () => es.close();
}

function handleSSEEvent(data, outputName) {
  switch (data.type) {
    case 'connected': addLog('Соединение установлено', 'ok'); break;
    case 'progress':  setProgress(data.current, data.total, data.message); addLog(data.message, 'info'); break;
    case 'done':
      state.eventSource?.close();
      state.resultFilename = data.output_filename || outputName;
      showResult({ pages: data.pages_processed, totalDocPages: data.total_doc_pages,
                   size: data.file_size_mb, filename: state.resultFilename });
      // Удаляем временный загруженный файл
      fetch(`/api/cleanup/${state.currentJobId}`, { method: 'DELETE' }).catch(() => {});
      break;
    case 'error':
      state.eventSource?.close();
      showError(data.message);
      break;
    case 'cancelled':
      state.eventSource?.close();
      addLog('Отменено', 'error');
      setTimeout(startOver, 1500);
      break;
  }
}

// ── Прогресс UI ───────────────────────────────────────────
function setProgress(current, total, message) {
  const pct = total > 0 ? Math.min(Math.round(current / total * 100), 100) : 0;
  document.getElementById('progress-percent').textContent = `${pct}%`;
  document.getElementById('stat-current').textContent = current;
  document.getElementById('stat-total').textContent   = total > 0 ? total : '—';
  document.getElementById('status-text').textContent  = message;
  document.getElementById('progress-bar-fill').style.width = `${pct}%`;
  document.getElementById('progress-bar-glow').style.width = `${pct}%`;
  document.getElementById('ring-fill').style.strokeDashoffset =
    314.16 - (pct / 100 * 314.16);
}

// ── Результат / ошибка ────────────────────────────────────
function showResult({ pages, totalDocPages, size }) {
  document.getElementById('progress-card').classList.add('hidden');
  const isPartial = totalDocPages && pages < totalDocPages;
  document.getElementById('result-stats').innerHTML = `
    <div class="result-stat">
      <span class="result-stat-value">${pages}</span>
      <span class="result-stat-label">Страниц обработано${isPartial ? ` из ${totalDocPages}` : ''}</span>
    </div>
    <div class="result-stat">
      <span class="result-stat-value">${size} МБ</span>
      <span class="result-stat-label">Размер файла</span>
    </div>`;
  document.getElementById('result-card').classList.remove('hidden');
}

function showError(message) {
  document.getElementById('progress-card').classList.add('hidden');
  document.getElementById('error-message').textContent = message;
  document.getElementById('error-card').classList.remove('hidden');
}

// ── Скачивание ────────────────────────────────────────────
async function downloadResult() {
  if (!state.currentJobId) return;
  const btn = document.getElementById('download-btn');
  btn.disabled = true;
  btn.innerHTML = spinnerBtnHtml('Подготовка...');
  try {
    const res = await fetch(`/api/download/${state.currentJobId}`);
    if (!res.ok) throw new Error('Файл недоступен');
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: state.resultFilename || 'ocr_result.pdf' });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast(`Ошибка: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = downloadBtnHtml();
  }
}

// ── Отмена / сброс ────────────────────────────────────────
async function cancelProcessing() {
  if (!state.currentJobId) return;
  await fetch(`/api/cancel/${state.currentJobId}`, { method: 'POST' }).catch(() => {});
  addLog('Сигнал отмены отправлен...', 'error');
  document.getElementById('cancel-btn').disabled = true;
}

function startOver() {
  state.eventSource?.close();
  state.resultFilename = null;

  ['progress-card','result-card','error-card'].forEach(id =>
    document.getElementById(id).classList.add('hidden')
  );
  ['upload-card'].forEach(id =>
    document.getElementById(id).classList.remove('hidden')
  );

  resetFile();  // сбрасывает currentJobId, file-input и всё остальное
  clearLog();
  setProgress(0, 0, 'Подготовка...');
  document.getElementById('math-warning').classList.add('hidden');
  document.getElementById('psm-select').value = 'auto';
  document.getElementById('psm-hint').textContent = PSM_HINTS['auto'];
}

// ── Настройки ─────────────────────────────────────────────
async function loadSettings() {
  try {
    const data = await (await fetch('/api/settings')).json();
    const f = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
    f('tess-path', data.tesseract_path);
    f('poppler-path', data.poppler_path);
    if (data.default_lang) {
      const sel = document.getElementById('lang-select');
      if (sel) for (const o of sel.options) if (o.value === data.default_lang) o.selected = true;
    }
    if (data.default_dpi) {
      const sel = document.getElementById('dpi-select');
      if (sel) for (const o of sel.options) if (+o.value === data.default_dpi) o.selected = true;
    }
    if (data.default_psm) {
      const sel = document.getElementById('psm-select');
      if (sel) { sel.value = data.default_psm; onPsmChange(data.default_psm); }
    }
  } catch {}
}

async function checkDeps() {
  const tessPath    = document.getElementById('tess-path').value.trim();
  const popplerPath = document.getElementById('poppler-path').value.trim();
  setDepStatus('tesseract', 'loading', 'Проверка...');
  setDepStatus('poppler',   'loading', 'Проверка...');
  try {
    const res  = await fetch('/api/check-deps', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tesseract_path: tessPath, poppler_path: popplerPath,
                             default_lang: 'rus+eng', default_dpi: 300, default_psm: 'auto' }),
    });
    const data = await res.json();
    setDepStatus('tesseract',
      data.tesseract.ok ? 'ok' : 'error',
      data.tesseract.ok ? `Версия: ${data.tesseract.message}` : `Не найден: ${data.tesseract.message}`
    );
    setDepStatus('poppler',
      data.poppler.ok ? 'ok' : 'error',
      data.poppler.ok ? 'Найден и работает' : `Не найден: ${data.poppler.message}`
    );
    if (data.languages?.length) updateLangSelect(data.languages);
    if (data.tesseract.ok && data.poppler.ok) {
      await fetch('/api/settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tesseract_path: tessPath, poppler_path: popplerPath,
                               default_lang: document.getElementById('lang-select')?.value || 'rus+eng',
                               default_dpi: 300, default_psm: 'auto' }),
      });
      showToast('Настройки сохранены! Всё готово к работе.', 'ok');
    } else {
      showToast('Некоторые зависимости не найдены', 'error');
    }
  } catch (err) {
    setDepStatus('tesseract', 'error', 'Ошибка');
    setDepStatus('poppler',   'error', 'Ошибка');
    showToast(`Ошибка: ${err.message}`, 'error');
  }
}

// ── Авто-установка ────────────────────────────────────────
function startInstall(tool) {
  const logEl    = document.getElementById(`install-log-${tool}`);
  const btnEl    = document.getElementById(`install-btn-${tool}`);
  const statusEl = document.getElementById(`install-status-${tool}`);

  logEl.innerHTML = '';
  logEl.closest('.install-panel').classList.remove('hidden');
  btnEl.disabled = true;
  btnEl.innerHTML = spinnerBtnHtml('Установка...');
  setInstallStatus(tool, 'loading', 'Подключаюсь...');

  const es = new EventSource(`/api/install/${tool}`);

  es.onmessage = e => {
    try {
      const data = JSON.parse(e.data);
      appendInstallLog(logEl, data.message, data.type);

      if (data.type === 'done') {
        es.close();
        setInstallStatus(tool, 'ok', '✅ ' + data.message);
        btnEl.disabled = false;
        btnEl.innerHTML = installBtnHtml(tool);

        // Обновляем поля настроек автоматически
        if (tool === 'tesseract' && data.tesseract_path) {
          document.getElementById('tess-path').value = data.tesseract_path;
        }
        if (tool === 'poppler' && data.poppler_path) {
          document.getElementById('poppler-path').value = data.poppler_path;
        }

        // Перепроверяем статус
        setTimeout(checkDeps, 500);

      } else if (data.type === 'error') {
        es.close();
        setInstallStatus(tool, 'error', '❌ ' + data.message);
        btnEl.disabled = false;
        btnEl.innerHTML = installBtnHtml(tool);
      }
    } catch {}
  };

  es.onerror = () => {
    es.close();
    setInstallStatus(tool, 'error', '❌ Ошибка соединения');
    btnEl.disabled = false;
    btnEl.innerHTML = installBtnHtml(tool);
  };
}

function appendInstallLog(logEl, msg, type) {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type === 'error' ? 'error' : type === 'done' ? 'ok' : 'info'}`;
  const now = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.textContent = `[${now}] ${msg}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function setInstallStatus(tool, status, msg) {
  const el = document.getElementById(`install-status-${tool}`);
  if (!el) return;
  el.className = `install-status ${status}`;
  el.textContent = msg;
}

// ── Утилиты ───────────────────────────────────────────────
function setDepStatus(name, status, message) {
  const item = document.getElementById(`dep-${name}`);
  if (!item) return;
  item.querySelector('.dep-indicator').className = `dep-indicator ${status}`;
  item.querySelector('.dep-msg').textContent = message;
}

function updateLangSelect(langs) {
  const sel = document.getElementById('lang-select');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '';
  const combos = [];
  if (langs.includes('rus') && langs.includes('eng'))
    combos.push({ value: 'rus+eng', label: 'Русский + Английский' });
  const labels = { rus: 'Русский', eng: 'Английский', deu: 'Немецкий', fra: 'Французский', ukr: 'Украинский' };
  langs.forEach(l => combos.push({ value: l, label: labels[l] || l.toUpperCase() }));
  combos.forEach(({ value, label }) => {
    const opt = Object.assign(document.createElement('option'), { value, textContent: label });
    if (value === current) opt.selected = true;
    sel.appendChild(opt);
  });
  const langHint = document.getElementById('lang-hint');
  if (langHint) langHint.textContent = `Доступно: ${langs.join(', ')}`;
}

// ── Лог ──────────────────────────────────────────────────
function addLog(msg, type = 'info') {
  const el = document.getElementById('log-body');
  if (!el) return;
  const now   = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const entry = Object.assign(document.createElement('div'), { className: `log-entry ${type}`, textContent: `[${now}] ${msg}` });
  el.appendChild(entry);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 200) el.removeChild(el.firstChild);
}
function clearLog() { const el = document.getElementById('log-body'); if (el) el.innerHTML = ''; }

// ── Тосты ─────────────────────────────────────────────────
function showToast(message, type = 'info') {
  document.querySelector('.toast')?.remove();
  const isOk = type === 'ok';
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;padding:14px 20px;border-radius:12px;font-size:14px;font-weight:500;max-width:380px;box-shadow:0 8px 30px rgba(0,0,0,.4);animation:slideIn .3s ease;display:flex;align-items:center;gap:10px;backdrop-filter:blur(10px);${isOk?'background:rgba(16,185,129,.15);border:1px solid rgba(16,185,129,.3);color:#6ee7b7;':'background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);color:#fca5a5;'}`;
  toast.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18" style="flex-shrink:0">${isOk?'<path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>':'<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'}</svg><span>${message}</span>`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

// ── HTML-шаблоны кнопок ───────────────────────────────────
function spinnerBtnHtml(text) {
  return `<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>${text}`;
}
function playBtnHtml() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><polygon points="5 3 19 12 5 21 5 3"/></svg>Начать OCR обработку`;
}
function downloadBtnHtml() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Скачать PDF с OCR`;
}
function installBtnHtml(tool) {
  return tool === 'tesseract'
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/></svg> Установить через winget`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/></svg> Скачать и установить`;
}

// ── Форматирование ────────────────────────────────────────
function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

// ── Глобальные стили анимаций ─────────────────────────────
const extraStyle = document.createElement('style');
extraStyle.textContent = `
  @keyframes slideIn { from{opacity:0;transform:translateX(20px)} to{opacity:1;transform:translateX(0)} }
  .spin { animation: rotate 1s linear infinite; display:inline-block; }
  @keyframes rotate { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
`;
document.head.appendChild(extraStyle);
