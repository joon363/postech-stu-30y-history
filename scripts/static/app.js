// BookScan Studio Desktop Application Logic
let pages = [];
let selectedPageId = null;
let currentTab = 'preview';
let saveDebounceTimer = null;
let pollTimer = null;
let ollamaAvailable = false;
let currentPreset = 1;
let imageViewer = null;

// High-Performance Zoom & Pan Controller for Book Scan Images
class ImageViewer {
  constructor(viewportId, imgId, badgeId) {
    this.viewport = document.getElementById(viewportId);
    this.img = document.getElementById(imgId);
    this.badge = document.getElementById(badgeId);
    this.scale = 1.0;
    this.panX = 0;
    this.panY = 0;
    this.isDragging = false;
    this.startX = 0;
    this.startY = 0;
    this.rotation = 0;

    if (this.viewport && this.img) {
      this.initEvents();
    }
  }

  initEvents() {
    // 1. Mouse wheel zoom with anchoring
    this.viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
      this.zoomAtPoint(zoomFactor, e.clientX, e.clientY);
    }, { passive: false });

    // 2. Mouse drag to pan
    this.viewport.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // Primary left button only
      this.isDragging = true;
      this.startX = e.clientX - this.panX;
      this.startY = e.clientY - this.panY;
      this.viewport.classList.add('is-dragging');
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      this.panX = e.clientX - this.startX;
      this.panY = e.clientY - this.startY;
      this.applyTransform();
    });

    window.addEventListener('mouseup', () => {
      if (this.isDragging) {
        this.isDragging = false;
        this.viewport.classList.remove('is-dragging');
      }
    });

    // 3. Double click to fit / reset
    this.viewport.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.reset();
    });

    // 4. Touch support for trackpads / tablets
    let initialPinchDist = 0;
    this.viewport.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        this.isDragging = true;
        this.startX = e.touches[0].clientX - this.panX;
        this.startY = e.touches[0].clientY - this.panY;
      } else if (e.touches.length === 2) {
        this.isDragging = false;
        initialPinchDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
      }
    }, { passive: true });

    this.viewport.addEventListener('touchmove', (e) => {
      if (this.isDragging && e.touches.length === 1) {
        this.panX = e.touches[0].clientX - this.startX;
        this.panY = e.touches[0].clientY - this.startY;
        this.applyTransform();
      } else if (e.touches.length === 2 && initialPinchDist > 0) {
        const currentDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const factor = currentDist / initialPinchDist;
        this.scale = Math.max(0.2, Math.min(5.0, this.scale * factor));
        initialPinchDist = currentDist;
        this.applyTransform();
      }
    }, { passive: true });

    this.viewport.addEventListener('touchend', () => {
      this.isDragging = false;
      initialPinchDist = 0;
    });

    // 5. Connect Toolbar buttons
    const btnIn = document.getElementById('btn-zoom-in');
    const btnOut = document.getElementById('btn-zoom-out');
    const btnFit = document.getElementById('btn-zoom-fit');
    const btnRotate = document.getElementById('btn-rotate-img');

    if (btnIn) btnIn.onclick = () => this.zoomBy(1.25);
    if (btnOut) btnOut.onclick = () => this.zoomBy(0.8);
    if (btnFit) btnFit.onclick = () => this.reset();
    if (btnRotate) btnRotate.onclick = () => this.rotate();
  }

  zoomAtPoint(factor, clientX, clientY) {
    const prevScale = this.scale;
    const newScale = Math.max(0.2, Math.min(5.0, this.scale * factor));
    if (prevScale === newScale) return;

    const rect = this.viewport.getBoundingClientRect();
    const offsetX = clientX - rect.left - rect.width / 2;
    const offsetY = clientY - rect.top - rect.height / 2;

    this.panX -= (offsetX - this.panX) * (newScale / prevScale - 1);
    this.panY -= (offsetY - this.panY) * (newScale / prevScale - 1);
    this.scale = newScale;
    this.applyTransform();
  }

  zoomBy(factor) {
    this.scale = Math.max(0.2, Math.min(5.0, this.scale * factor));
    this.applyTransform();
  }

  rotate() {
    this.rotation = (this.rotation + 90) % 360;
    this.applyTransform();
  }

  reset() {
    this.scale = 1.0;
    this.panX = 0;
    this.panY = 0;
    this.rotation = 0;
    this.applyTransform();
  }

  applyTransform() {
    if (!this.img) return;
    this.img.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale}) rotate(${this.rotation}deg)`;
    if (this.badge) {
      this.badge.textContent = `${Math.round(this.scale * 100)}%`;
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initApp();
  setupEventListeners();
  startPolling();
});

async function initApp() {
  imageViewer = new ImageViewer('image-viewer-container', 'main-preview-image', 'zoom-badge');
  await fetchServerInfo();
  await loadPages();
}

function updatePresetUI(presetNum) {
  currentPreset = parseInt(presetNum, 10) || 1;
  document.querySelectorAll('.preset-btn').forEach(btn => {
    if (parseInt(btn.dataset.preset, 10) === currentPreset) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

async function setPreset(presetNum) {
  updatePresetUI(presetNum);
  try {
    await fetch(`/api/preset?preset=${currentPreset}`, { method: 'POST' });
  } catch (e) {
    console.error('Failed to sync preset:', e);
  }
  const label = currentPreset === 1 ? '프리셋 1: 연도별 연표' : '프리셋 2: 일반 단체/목록';
  showToast(`📑 ${label} 모드 활성화 (단축키: ${currentPreset})`, 'info');
}

// 1. Server Info & LLM Status
async function fetchServerInfo() {
  try {
    const res = await fetch('/api/info');
    const data = await res.json();

    // Update preset if returned
    if (data.current_preset) {
      updatePresetUI(data.current_preset);
    }

    // Update Mobile URLs
    const mobileHttpsText = document.getElementById('text-mobile-https-url');
    if (mobileHttpsText && data.mobile_https_url) mobileHttpsText.textContent = data.mobile_https_url;

    const adbFeedback = document.getElementById('adb-status-feedback');
    if (adbFeedback && data.adb) {
      if (data.adb.connected) {
        adbFeedback.innerHTML = `<span style="color: var(--accent-emerald);">✅ ${data.adb.message}</span>`;
      } else {
        adbFeedback.innerHTML = `<span style="color: var(--text-muted);">${data.adb.message}</span>`;
      }
    }

    // Update Book Title
    const titleInput = document.getElementById('input-book-title');
    if (titleInput && data.book_title) titleInput.value = data.book_title;

    // Update LLM Status Badge
    updateLLMStatusUI(data.ollama);
  } catch (err) {
    console.error('Failed to fetch server info:', err);
  }
}

function updateLLMStatusUI(ollama) {
  const dot = document.getElementById('dot-llm-status');
  const label = document.getElementById('label-llm-status');
  const modalBadge = document.getElementById('llm-modal-status-badge');
  const selectModel = document.getElementById('select-llm-model');

  if (ollama && ollama.available) {
    ollamaAvailable = true;
    dot.className = 'status-dot online';
    label.textContent = `Ollama (${ollama.default_model})`;
    modalBadge.textContent = '연결됨 (정상 작동 중)';
    modalBadge.style.color = 'var(--accent-emerald)';

    // Populate model options
    if (ollama.models && ollama.models.length > 0) {
      selectModel.innerHTML = '';
      ollama.models.forEach(model => {
        const opt = document.createElement('option');
        opt.value = model;
        opt.textContent = `${model} ${model.includes('qwen') ? '(권장)' : ''}`;
        if (model === ollama.default_model) opt.selected = true;
        selectModel.appendChild(opt);
      });
      // Add fallback option
      const regexOpt = document.createElement('option');
      regexOpt.value = 'smart_regex';
      regexOpt.textContent = '스마트 정규식 서식기 (LLM 미사용/즉시)';
      selectModel.appendChild(regexOpt);
    }
  } else {
    ollamaAvailable = false;
    dot.className = 'status-dot offline';
    label.textContent = '스마트 서식기 모드 (Ollama 대기)';
    modalBadge.textContent = 'Ollama 미연결 (스마트 서식기로 자동 대체됨)';
    modalBadge.style.color = 'var(--accent-amber)';
  }
}

// 2. Load & Render Pages
async function loadPages() {
  try {
    const res = await fetch('/api/pages');
    pages = await res.json();

    const countLabel = document.getElementById('count-total-pages');
    if (countLabel) countLabel.textContent = pages.length;

    renderPagesList();

    if (pages.length > 0) {
      // Keep selected or select first
      if (!selectedPageId || !pages.some(p => p.id === selectedPageId)) {
        selectPage(pages[0].id);
      } else {
        updateActivePageDetail();
      }
    } else {
      selectedPageId = null;
      renderEmptyState();
    }
  } catch (err) {
    console.error('Failed to load pages:', err);
  }
}

function renderPagesList() {
  const container = document.getElementById('pages-list-container');
  if (!container) return;

  if (pages.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 40px 10px; font-size: 13px;">
        아직 추가된 페이지가 없습니다.<br>
        스마트폰에서 촬영하거나 사진/PDF를 추가하세요!
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  pages.forEach(page => {
    const item = document.createElement('div');
    item.className = `page-item ${page.id === selectedPageId ? 'active' : ''}`;
    item.id = `page-item-${page.id}`;
    item.onclick = () => selectPage(page.id);

    // Status badge text
    let badgeText = '대기';
    let badgeClass = 'pending';
    if (page.status === 'ocr_running') {
      badgeText = 'OCR 분석중';
      badgeClass = 'ocr_done';
    } else if (page.status === 'formatting') {
      badgeText = '서식화중';
      badgeClass = 'ocr_done';
    } else if (page.status === 'done') {
      badgeText = '완료';
      badgeClass = 'done';
    } else if (page.status === 'ocr_done') {
      badgeText = 'OCR 완료';
      badgeClass = 'ocr_done';
    } else if (page.status === 'error') {
      badgeText = '오류';
      badgeClass = 'error';
    }

    const snippet = page.formatted_text || page.ocr_text || '(텍스트 없음)';
    const presetPill = page.preset === 2
      ? `<span class="badge-preset preset-2" style="font-size: 9px; padding: 1px 4px;">P2</span>`
      : `<span class="badge-preset preset-1" style="font-size: 9px; padding: 1px 4px;">P1</span>`;

    item.innerHTML = `
      <div class="page-thumb-wrapper">
        <img src="${page.thumb_url || page.image_url}" alt="Page ${page.page_number}" class="page-thumb-img" onerror="this.style.display='none'">
      </div>
      <div class="page-info">
        <div class="page-title-row">
          <span class="page-number-label">Page ${page.page_number} ${presetPill}</span>
          <span class="page-badge ${badgeClass}">${badgeText}</span>
        </div>
        <div class="page-preview-snippet">${escapeHtml(snippet)}</div>
      </div>
      <button class="page-delete-btn" title="페이지 삭제" onclick="event.stopPropagation(); deletePage('${page.id}');">
        ✕
      </button>
    `;
    container.appendChild(item);
  });
}

function selectPage(pageId) {
  selectedPageId = pageId;

  // Highlight in sidebar
  document.querySelectorAll('.page-item').forEach(el => el.classList.remove('active'));
  const activeEl = document.getElementById(`page-item-${pageId}`);
  if (activeEl) activeEl.classList.add('active');

  updateActivePageDetail();
}

function updateActivePageDetail() {
  const page = pages.find(p => p.id === selectedPageId);
  if (!page) return;

  // Title & Preset Badge
  document.getElementById('selected-page-title').textContent = `사진: Page ${page.page_number}`;
  const badgePreset = document.getElementById('badge-page-preset');
  if (badgePreset) {
    const pagePreset = page.preset || 1;
    badgePreset.textContent = pagePreset === 2 ? '프리셋 2 (일반)' : '프리셋 1 (연도)';
    badgePreset.className = `badge-preset preset-${pagePreset}`;
    badgePreset.style.display = 'inline-block';
  }

  // Image Preview & Reset Zoom/Pan
  const imgEl = document.getElementById('main-preview-image');
  const placeholder = document.getElementById('no-image-placeholder');
  if (imgEl && page.image_url) {
    imgEl.src = page.image_url;
    imgEl.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';
    if (imageViewer) imageViewer.reset();
  }

  // OCR Text (hidden fallback)
  const ocrTextarea = document.getElementById('textarea-ocr-raw');
  if (ocrTextarea) ocrTextarea.value = page.ocr_text || '';

  // Markdown Editor Text & Live Preview
  const mdTextarea = document.getElementById('textarea-markdown-edit');
  const textContent = page.formatted_text || page.ocr_text || '';
  if (mdTextarea) {
    mdTextarea.value = textContent;
    const charCountEl = document.getElementById('md-char-count');
    if (charCountEl) charCountEl.textContent = textContent.length;
  }
  renderMarkdownPreview(textContent);
}

function renderEmptyState() {
  document.getElementById('selected-page-title').textContent = '사진: 선택 없음';
  const badgePreset = document.getElementById('badge-page-preset');
  if (badgePreset) badgePreset.style.display = 'none';

  const imgEl = document.getElementById('main-preview-image');
  const placeholder = document.getElementById('no-image-placeholder');
  if (imgEl) imgEl.style.display = 'none';
  if (placeholder) placeholder.style.display = 'block';
  if (imageViewer) imageViewer.reset();

  const ocrTextarea = document.getElementById('textarea-ocr-raw');
  if (ocrTextarea) ocrTextarea.value = '';

  const mdTextarea = document.getElementById('textarea-markdown-edit');
  if (mdTextarea) mdTextarea.value = '';

  const charCountEl = document.getElementById('md-char-count');
  if (charCountEl) charCountEl.textContent = '0';

  const previewPane = document.getElementById('pane-markdown-preview');
  if (previewPane) {
    previewPane.innerHTML = `
      <p style="color: var(--text-muted); font-style: italic;">
        페이지를 선택하면 마크다운 결과가 실시간으로 렌더링됩니다.
      </p>
    `;
  }
}

function renderMarkdownPreview(markdownText) {
  const previewPane = document.getElementById('pane-markdown-preview');
  if (!previewPane) return;

  if (!markdownText || !markdownText.trim()) {
    previewPane.innerHTML = `<p style="color: var(--text-muted); font-style: italic;">내용이 없습니다.</p>`;
    return;
  }

  if (window.marked && typeof window.marked.parse === 'function') {
    previewPane.innerHTML = marked.parse(markdownText);
  } else {
    // Basic fallback parser if marked CDN is offline
    let html = escapeHtml(markdownText)
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      .replace(/^\> (.*$)/gim, '<blockquote>$1</blockquote>')
      .replace(/\n\n/g, '<br><br>');
    previewPane.innerHTML = html;
  }
}

// Sidebar Collapse / Expand Toggle
function setupTabs() {
  const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
  const appWorkspace = document.getElementById('app-workspace');
  if (btnToggleSidebar && appWorkspace) {
    btnToggleSidebar.onclick = () => {
      const isCollapsed = appWorkspace.classList.toggle('sidebar-collapsed');
      btnToggleSidebar.textContent = isCollapsed ? '▶' : '◀';
      btnToggleSidebar.title = isCollapsed ? '사이드바 펼치기' : '사이드바 접기';
    };
  }
}

// 4. Single Page Operations
async function runSingleOCR() {
  if (!selectedPageId) return showToast('선택된 페이지가 없습니다.', 'error');
  const btn = document.getElementById('btn-run-single-ocr');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> 인식 중...`;

  try {
    const res = await fetch(`/api/ocr/${selectedPageId}?preset=${currentPreset}`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('OCR 인식이 완료되었습니다!', 'success');
      await loadPages();
    } else {
      showToast('OCR 실패: ' + (data.detail || '오류 발생'), 'error');
    }
  } catch (err) {
    showToast('OCR 요청 중 통신 오류가 발생했습니다.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `⚡ 이 페이지 OCR 실행`;
  }
}

async function runSingleFormat() {
  if (!selectedPageId) return showToast('선택된 페이지가 없습니다.', 'error');
  const page = pages.find(p => p.id === selectedPageId);
  if (!page || !page.ocr_text) return showToast('서식화할 OCR 텍스트가 없습니다. 먼저 OCR을 실행하세요.', 'error');

  const btn = document.getElementById('btn-run-single-format');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> 서식화 중...`;

  const selectedModel = document.getElementById('select-llm-model').value;
  const forceRegex = selectedModel === 'smart_regex';

  try {
    const res = await fetch(`/api/format/${selectedPageId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: selectedModel,
        preset: currentPreset,
        force_regex: forceRegex
      })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`마크다운 서식화 완료! (${data.engine_used})`, 'success');
      await loadPages();
    } else {
      showToast('서식화 실패: ' + (data.detail || '오류'), 'error');
    }
  } catch (err) {
    showToast('서식화 통신 오류가 발생했습니다.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `✨ LLM 서식화`;
  }
}

// 5. Batch Operations
async function batchOCR() {
  if (pages.length === 0) return showToast('처리할 페이지가 없습니다.', 'error');
  const btn = document.getElementById('btn-batch-ocr');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> 전체 OCR 실행 중...`;

  try {
    const res = await fetch('/api/ocr-all', { method: 'POST' });
    const data = await res.json();
    showToast(`전체 OCR 완료! (${data.updated_count}개 페이지)`, 'success');
    await loadPages();
  } catch (err) {
    showToast('일괄 OCR 실행 중 오류가 발생했습니다.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `⚡ 전체 OCR`;
  }
}

// Remote Snap trigger from PC
async function triggerRemoteSnap() {
  const btn = document.getElementById('btn-remote-snap');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> 찰칵!`;
  }

  try {
    const res = await fetch(`/api/remote-snap?preset=${currentPreset}`, { method: 'POST' });
    const data = await res.json();
    if (data.phones_triggered > 0) {
      showToast(`📸 스마트폰으로 원격 촬영 신호를 보냈습니다!`, 'success');
    } else {
      showToast(data.message || '스마트폰이 연결되지 않았습니다. 폰 화면을 켜주세요.', 'error');
    }
  } catch (err) {
    showToast('원격 촬영 요청 중 통신 오류가 발생했습니다.', 'error');
  } finally {
    if (btn) {
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = `📸 폰 원격 촬영 (Space)`;
      }, 700);
    }
  }
}

async function batchFormat() {
  if (pages.length === 0) return showToast('처리할 페이지가 없습니다.', 'error');
  const btn = document.getElementById('btn-batch-format');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> 전체 서식화 중...`;

  const selectedModel = document.getElementById('select-llm-model').value;

  try {
    const res = await fetch('/api/format-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: selectedModel, force_regex: selectedModel === 'smart_regex' })
    });
    const data = await res.json();
    showToast(`전체 서식화 완료! (${data.count}개 페이지)`, 'success');
    await loadPages();
  } catch (err) {
    showToast('일괄 서식화 중 오류가 발생했습니다.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `✨ 전체 서식화`;
  }
}

async function saveBookMarkdown() {
  if (pages.length === 0) return showToast('저장할 페이지가 없습니다.', 'error');
  const btn = document.getElementById('btn-save-book');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span> 저장 중...`;

  try {
    const res = await fetch('/api/save-book', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`책 저장 완료! (${data.filename})`, 'success');
      // Trigger download directly
      window.location.href = data.download_url;
    } else {
      showToast('저장 실패: ' + (data.detail || '오류'), 'error');
    }
  } catch (err) {
    showToast('저장 요청 중 오류가 발생했습니다.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `💾 책 저장 (.md)`;
  }
}

async function downloadZip() {
  if (pages.length === 0) return showToast('다운로드할 페이지가 없습니다.', 'error');
  window.location.href = '/api/download-zip';
  showToast('ZIP 아카이브 생성을 시작합니다...', 'info');
}

async function deletePage(pageId) {
  if (!confirm('이 페이지를 삭제하시겠습니까?')) return;
  try {
    const res = await fetch(`/api/pages/${pageId}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('페이지가 삭제되었습니다.', 'info');
      await loadPages();
    }
  } catch (err) {
    showToast('삭제 실패', 'error');
  }
}

async function clearAllPages() {
  if (pages.length === 0) return;
  if (!confirm('경고: 모든 페이지와 이미지가 삭제됩니다. 계속하시겠습니까?')) return;

  try {
    const res = await fetch('/api/clear', { method: 'POST' });
    if (res.ok) {
      showToast('모든 페이지가 초기화되었습니다.', 'info');
      await loadPages();
    }
  } catch (err) {
    showToast('초기화 실패', 'error');
  }
}

// 6. Upload Handling (Images, PDF, Drag & Drop)
async function uploadFiles(files, isPdf = false) {
  if (!files || files.length === 0) return;

  showToast(`${files.length}개 파일 업로드 중...`, 'info');

  if (isPdf) {
    const formData = new FormData();
    formData.append('file', files[0]);
    formData.append('auto_ocr', 'true');

    try {
      const res = await fetch('/api/upload-pdf', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.success) {
        showToast(`PDF에서 ${data.count}개 페이지를 성공적으로 추출했습니다!`, 'success');
        await loadPages();
      }
    } catch (err) {
      showToast('PDF 처리 중 오류가 발생했습니다.', 'error');
    }
    return;
  }

  // Images upload
  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append('files', files[i]);
  }
  formData.append('preset', currentPreset.toString());
  formData.append('auto_ocr', 'true');

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (data.success) {
      showToast(`${data.count}장의 사진이 추가되었습니다. OCR 진행 중...`, 'success');
      await loadPages();
    }
  } catch (err) {
    showToast('업로드 중 오류가 발생했습니다.', 'error');
  }
}

// 7. Auto-save Debouncing for textareas
function setupAutoSave() {
  const ocrTextarea = document.getElementById('textarea-ocr-raw');
  const mdTextarea = document.getElementById('textarea-markdown-edit');

  if (ocrTextarea) {
    ocrTextarea.addEventListener('input', () => {
      scheduleSave({ ocr_text: ocrTextarea.value });
    });
  }

  if (mdTextarea) {
    mdTextarea.addEventListener('input', () => {
      const charCountEl = document.getElementById('md-char-count');
      if (charCountEl) charCountEl.textContent = mdTextarea.value.length;
      renderMarkdownPreview(mdTextarea.value);
      scheduleSave({ formatted_text: mdTextarea.value });
    });
  }
}

function scheduleSave(payload) {
  if (!selectedPageId) return;
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(async () => {
    try {
      await fetch(`/api/pages/${selectedPageId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      // Update local memory
      const p = pages.find(x => x.id === selectedPageId);
      if (p) Object.assign(p, payload);
    } catch (e) {
      console.error('Auto save failed', e);
    }
  }, 600);
}

// 8. Event Listeners Setup
function setupEventListeners() {
  setupTabs();
  setupAutoSave();

  // Preset Buttons (1: 연도, 2: 일반)
  const btnPreset1 = document.getElementById('btn-preset-1');
  const btnPreset2 = document.getElementById('btn-preset-2');
  if (btnPreset1) btnPreset1.onclick = () => setPreset(1);
  if (btnPreset2) btnPreset2.onclick = () => setPreset(2);

  // Book Title change
  const titleInput = document.getElementById('input-book-title');
  titleInput.addEventListener('change', async () => {
    const newTitle = titleInput.value.trim();
    if (!newTitle) return;
    try {
      await fetch('/api/title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle })
      });
      showToast('책 제목이 변경되었습니다.', 'info');
    } catch (e) {}
  });

  // Action Buttons
  const remoteSnapBtn = document.getElementById('btn-remote-snap');
  if (remoteSnapBtn) remoteSnapBtn.onclick = triggerRemoteSnap;

  document.getElementById('btn-run-single-ocr').onclick = runSingleOCR;
  document.getElementById('btn-run-single-format').onclick = runSingleFormat;
  document.getElementById('btn-batch-ocr').onclick = batchOCR;
  document.getElementById('btn-batch-format').onclick = batchFormat;
  document.getElementById('btn-save-book').onclick = saveBookMarkdown;
  document.getElementById('btn-download-zip').onclick = downloadZip;
  document.getElementById('btn-clear-pages').onclick = clearAllPages;

  // Import Spell-checked Markdown back into editor
  const btnImportMd = document.getElementById('btn-import-md');
  const inputImportMd = document.getElementById('input-file-md');
  if (btnImportMd && inputImportMd) {
    btnImportMd.onclick = () => inputImportMd.click();

    inputImportMd.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const formData = new FormData();
      formData.append('file', file);

      showToast(`'${file.name}' 분석 및 편집기 페이지별 반영 중...`, 'info');

      try {
        const res = await fetch('/api/import-markdown', {
          method: 'POST',
          body: formData
        });
        const data = await res.json();
        if (data.success) {
          showToast(`✅ ${data.updated_pages_count}개 페이지에 교정된 내용이 성공적으로 반영되었습니다!`, 'success');
          await loadPages();
        } else {
          showToast('불러오기 실패: ' + (data.detail || '오류 발생'), 'error');
        }
      } catch (err) {
        showToast('마크다운 파일 불러오기 중 통신 오류가 발생했습니다.', 'error');
      } finally {
        inputImportMd.value = '';
      }
    };
  }

  // Spacebar Hotkey for Remote Snap & 1/2 Keys for Preset Switch
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') return;

    if (e.code === 'Space') {
      e.preventDefault();
      triggerRemoteSnap();
    } else if (e.key === '1') {
      setPreset(1);
    } else if (e.key === '2') {
      setPreset(2);
    }
  });

  // Copy Markdown Button
  document.getElementById('btn-copy-markdown').onclick = () => {
    const mdText = document.getElementById('textarea-markdown-edit').value;
    if (!mdText) return showToast('복사할 마크다운이 없습니다.', 'error');
    navigator.clipboard.writeText(mdText);
    showToast('마크다운 본문이 클립보드에 복사되었습니다!', 'success');
  };

  // Upload buttons
  const inputImages = document.getElementById('input-file-images');
  const inputPdf = document.getElementById('input-file-pdf');

  document.getElementById('btn-trigger-add-images').onclick = () => inputImages.click();
  document.getElementById('btn-trigger-add-pdf').onclick = () => inputPdf.click();

  inputImages.onchange = (e) => uploadFiles(e.target.files, false);
  inputPdf.onchange = (e) => uploadFiles(e.target.files, true);

  // Dropzone drag & drop
  const dropzone = document.getElementById('desktop-dropzone');
  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
  });
  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
    });
  });
  dropzone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length === 1 && files[0].type === 'application/pdf') {
      uploadFiles(files, true);
    } else {
      uploadFiles(files, false);
    }
  });

  // Modals
  setupModals();
}

function setupModals() {
  const mobileModal = document.getElementById('modal-mobile-connect');
  const llmModal = document.getElementById('modal-llm-settings');

  document.getElementById('btn-open-mobile-modal').onclick = () => mobileModal.classList.add('open');
  document.getElementById('btn-close-mobile-modal').onclick = () => mobileModal.classList.remove('open');

  document.getElementById('btn-open-llm-modal').onclick = () => llmModal.classList.add('open');
  document.getElementById('btn-close-llm-modal').onclick = () => llmModal.classList.remove('open');

  // Mobile Modal Tabs (USB vs HTTPS)
  const tabUsb = document.getElementById('tab-btn-conn-usb');
  const tabHttps = document.getElementById('tab-btn-conn-https');
  const paneUsb = document.getElementById('conn-pane-usb');
  const paneHttps = document.getElementById('conn-pane-https');

  if (tabUsb && tabHttps) {
    tabUsb.onclick = () => {
      tabUsb.classList.add('active');
      tabHttps.classList.remove('active');
      paneUsb.style.display = 'block';
      paneHttps.style.display = 'none';
    };
    tabHttps.onclick = () => {
      tabHttps.classList.add('active');
      tabUsb.classList.remove('active');
      paneHttps.style.display = 'block';
      paneUsb.style.display = 'none';
    };
  }

  // Copy HTTPS URL button
  const copyHttpsBtn = document.getElementById('btn-copy-https-url');
  if (copyHttpsBtn) {
    copyHttpsBtn.onclick = () => {
      const url = document.getElementById('text-mobile-https-url').textContent;
      navigator.clipboard.writeText(url);
      showToast('HTTPS 접속 주소가 복사되었습니다!', 'success');
    };
  }

  // ADB Reverse trigger button
  const adbBtn = document.getElementById('btn-trigger-adb');
  if (adbBtn) {
    adbBtn.onclick = async () => {
      adbBtn.disabled = true;
      adbBtn.innerHTML = `<span class="spinner"></span> 확인 중...`;
      try {
        const res = await fetch('/api/adb/reverse');
        const data = await res.json();
        const feedback = document.getElementById('adb-status-feedback');
        if (data.connected) {
          feedback.innerHTML = `<span style="color: var(--accent-emerald);">✅ ${data.message}</span>`;
          showToast('USB 디버깅 연결 성공! 스마트폰에서 http://localhost:8000/mobile 로 접속하세요.', 'success');
        } else {
          feedback.innerHTML = `<span style="color: var(--accent-amber);">⚠️ ${data.message}</span>`;
          showToast(data.message, 'error');
        }
      } catch (e) {
        showToast('ADB 실행 실패', 'error');
      } finally {
        adbBtn.disabled = false;
        adbBtn.innerHTML = `⚡ ADB 포트포워딩 실행 (adb reverse)`;
      }
    };
  }

  // Refresh LLM check button
  document.getElementById('btn-refresh-llm').onclick = async () => {
    const btn = document.getElementById('btn-refresh-llm');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> 확인 중...`;
    await fetchServerInfo();
    btn.disabled = false;
    btn.innerHTML = `🔄 연결 재확인`;
    showToast('LLM 상태를 다시 확인했습니다.', 'info');
  };

  // Close modals on background click
  [mobileModal, llmModal].forEach(m => {
    m.addEventListener('click', (e) => {
      if (e.target === m) m.classList.remove('open');
    });
  });
}

// 9. Background Polling for real-time mobile sync
function startPolling() {
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/pages');
      const freshPages = await res.json();
      if (freshPages.length !== pages.length || JSON.stringify(freshPages) !== JSON.stringify(pages)) {
        pages = freshPages;
        renderPagesList();
        if (selectedPageId) updateActivePageDetail();
      }
    } catch (e) {}
  }, 2500);
}

// 10. Toast Notification Helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';

  const icon = type === 'success' ? '✅' : (type === 'error' ? '⚠️' : 'ℹ️');
  toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
