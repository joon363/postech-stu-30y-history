import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { marked } from 'marked';
import bookData from './bookData.json';
import './App.css';

marked.setOptions({
  gfm: true,
  breaks: true,
});

// Map of pageNumber to pageIndex
const pageNumToIdx = {};
bookData.pages.forEach((p) => {
  pageNumToIdx[p.pageNumber] = p.pageIndex;
});

// Footnote number -> { target: targetPageNumber, source: sourcePageNumber }
const FOOTNOTE_MAP = {
  '1': { target: 306, source: 16 },
  '2': { target: 308, source: 18 },
  '3': { target: 311, source: 23 },
  '4': { target: 313, source: 28 },
  '5': { target: 315, source: 30 },
  '6': { target: 315, source: 30 },
  '7': { target: 320, source: 36 },
  '8': { target: 322, source: 37 },
  '9': { target: 322, source: 37 },
  '10': { target: 330, source: 63 },
  '11': { target: 331, source: 68 },
  '12': { target: 335, source: 78 },
  '13': { target: 321, source: 133 },
  '14': { target: 321, source: 235 },
};

function processMarkdownWithFootnotes(content, pageNum) {
  if (!content) return '';
  const lines = content.split('\n');
  const processedLines = lines.map((line) => {
    // 1. Footnote definition lines: e.g. '3\) 311페이지에 기록' or '8) 322페이지에 기록' or '\* 321페이지에 기록'
    const defMatch = line.match(/^\s*(\*|\\\*|\d+)(?:\\?\))\s*(\d+)페이지에 기록(.*)$/);
    if (defMatch) {
      const fn = defMatch[1].replace('\\', '');
      const targetPage = defMatch[2];
      const rest = defMatch[3] || '';
      return `<a href="#page-${targetPage}" class="footnote-def-link" data-page-num="${targetPage}" title="${targetPage}페이지로 바로가기">${fn}) ${targetPage}페이지에 기록</a>${rest}`;
    }

    // 2. Footnote in-text references: e.g. 전달3), 폐지되었다.4), 정책5), 사건8), 9)
    return line.replace(/([^\d\n\r])(\d{1,2})\\?\)/g, (match, prefix, num) => {
      const entry = FOOTNOTE_MAP[num];
      if (!entry) return match;
      if (pageNum === entry.source) {
        return `${prefix}<a href="#page-${entry.target}" class="footnote-ref-link" data-page-num="${entry.target}" title="${entry.target}페이지로 이동">${num})</a>`;
      }
      if (pageNum === entry.target) {
        return `${prefix}<a href="#page-${entry.source}" class="footnote-ref-link" data-page-num="${entry.source}" title="${entry.source}페이지로 이동">${num})</a>`;
      }
      return match;
    });
  });
  return marked.parse(processedLines.join('\n'));
}

export default function App() {
  const totalPages = bookData.totalPages;

  // Persistent reading page index
  const [currentPageIndex, setCurrentPageIndex] = useState(() => {
    try {
      const saved = localStorage.getItem('postech_30y_page');
      if (saved !== null) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= 0 && parsed < totalPages) {
          return parsed;
        }
      }
    } catch {
      // Ignore
    }
    return 0;
  });

  // View Mode: 'single' (한쪽 보기) | 'double' (두쪽 보기)
  const [viewMode, setViewMode] = useState(() => {
    try {
      return localStorage.getItem('postech_reader_view') || 'single';
    } catch {
      return 'single';
    }
  });

  // Fit Mode: 'height' (맞춤: 높이 - default) | 'fit' (맞춤 없음) | 'width' (너비 맞춤)
  const [fitMode, setFitMode] = useState(() => {
    try {
      return localStorage.getItem('postech_reader_fit') || 'height';
    } catch {
      return 'height';
    }
  });

  const [isTocOpen, setIsTocOpen] = useState(false);
  const [tocSearch, setTocSearch] = useState('');

  // Font preferences
  const [fontFamily, setFontFamily] = useState(() => {
    try {
      return localStorage.getItem('postech_reader_font') || 'serif';
    } catch {
      return 'serif';
    }
  });

  const [fontSize, setFontSize] = useState(() => {
    try {
      const saved = localStorage.getItem('postech_reader_size');
      return saved ? parseInt(saved, 10) : 17;
    } catch {
      return 17;
    }
  });

  const [jumpInput, setJumpInput] = useState('');
  const workspaceRef = useRef(null);
  const activeTocItemRef = useRef(null);
  const progressBarRef = useRef(null);

  // YouTube-style progress bar states
  const [isHoveringBar, setIsHoveringBar] = useState(false);
  const [hoverRatio, setHoverRatio] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  // Download dropdown state
  const [isDownloadOpen, setIsDownloadOpen] = useState(false);
  const downloadRef = useRef(null);

  // Close download dropdown when clicking outside
  useEffect(() => {
    if (!isDownloadOpen) return;
    const handleClickOutside = (e) => {
      if (downloadRef.current && !downloadRef.current.contains(e.target)) {
        setIsDownloadOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isDownloadOpen]);

  // Download handlers
  const handleDownloadMarkdown = () => {
    setIsDownloadOpen(false);
    const link = document.createElement('a');
    link.href = '/bookData.md';
    link.download = 'bookData.md';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleDownloadJson = () => {
    setIsDownloadOpen(false);
    const jsonString = JSON.stringify(bookData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'bookData.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Save state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('postech_30y_page', String(currentPageIndex));
    } catch {
      // Ignore
    }
    if (workspaceRef.current) {
      workspaceRef.current.scrollTop = 0;
    }
    setJumpInput(String(currentPageIndex + 1));
  }, [currentPageIndex]);

  useEffect(() => {
    try {
      localStorage.setItem('postech_reader_view', viewMode);
      localStorage.setItem('postech_reader_fit', fitMode);
    } catch {
      // Ignore
    }
  }, [viewMode, fitMode]);

  useEffect(() => {
    try {
      localStorage.setItem('postech_reader_font', fontFamily);
      localStorage.setItem('postech_reader_size', String(fontSize));
    } catch {
      // Ignore
    }
  }, [fontFamily, fontSize]);

  // Navigate function with bounds check
  const goToPage = useCallback((index) => {
    if (index >= 0 && index < totalPages) {
      setCurrentPageIndex(index);
    }
  }, [totalPages]);

  // Navigation handlers (adapted for single & double view)
  const goToNextPage = useCallback(() => {
    if (viewMode === 'double') {
      if (currentPageIndex === 0) {
        goToPage(1);
      } else {
        const spreadOffset = (currentPageIndex - 1) % 2;
        const leftIdx = currentPageIndex - spreadOffset;
        const nextSpread = leftIdx + 2;
        if (nextSpread < totalPages) {
          goToPage(nextSpread);
        }
      }
    } else {
      if (currentPageIndex < totalPages - 1) {
        goToPage(currentPageIndex + 1);
      }
    }
  }, [viewMode, currentPageIndex, totalPages, goToPage]);

  const goToPrevPage = useCallback(() => {
    if (viewMode === 'double') {
      if (currentPageIndex <= 2) {
        goToPage(0);
      } else {
        const spreadOffset = (currentPageIndex - 1) % 2;
        const leftIdx = currentPageIndex - spreadOffset;
        const prevSpread = leftIdx - 2;
        goToPage(Math.max(1, prevSpread));
      }
    } else {
      if (currentPageIndex > 0) {
        goToPage(currentPageIndex - 1);
      }
    }
  }, [viewMode, currentPageIndex, goToPage]);

  // Cycle fit mode: height -> fit -> width -> height
  const cycleFitMode = () => {
    setFitMode((prev) => {
      if (prev === 'height') return 'fit';
      if (prev === 'fit') return 'width';
      return 'height';
    });
  };

  const fitModeLabel = useMemo(() => {
    if (fitMode === 'height') return '높이';
    if (fitMode === 'width') return '너비';
    return '없음';
  }, [fitMode]);

  // Calculate pages for current view
  // In single view: single page
  // In double view:
  // - page 0 is cover alone
  // - pages 1, 2 are a spread (p.2 on left, p.3 on right)
  // - pages 3, 4 are a spread (p.4 on left, p.6 on right)
  const { leftPage, rightPage, isDoubleSpread } = useMemo(() => {
    if (viewMode === 'single' || currentPageIndex === 0) {
      return {
        leftPage: bookData.pages[currentPageIndex] || bookData.pages[0],
        rightPage: null,
        isDoubleSpread: false,
      };
    }
    const spreadOffset = (currentPageIndex - 1) % 2;
    const leftIdx = currentPageIndex - spreadOffset;
    const rightIdx = leftIdx + 1 < totalPages ? leftIdx + 1 : null;
    return {
      leftPage: bookData.pages[leftIdx],
      rightPage: rightIdx !== null ? bookData.pages[rightIdx] : null,
      isDoubleSpread: true,
    };
  }, [viewMode, currentPageIndex, totalPages]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) {
        if (e.key === 'Escape') {
          setIsTocOpen(false);
          e.target.blur();
        }
        return;
      }

      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        goToNextPage();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        goToPrevPage();
      } else if (e.key === 'Escape') {
        setIsTocOpen(false);
      } else if (e.key === 'm' || e.key === 'M') {
        setIsTocOpen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goToNextPage, goToPrevPage]);

  // Wheel navigation when there is no vertical scroll available
  const wheelAccumulatorRef = useRef(0);
  const lastWheelTimeRef = useRef(0);

  useEffect(() => {
    const handleWheel = (e) => {
      // Don't trigger if inside TOC drawer or input
      if (e.target.closest('.toc-drawer, input, textarea, select')) return;

      // Check if target or any parent has active vertical scroll room
      let el = e.target;
      let hasScrollableParent = false;

      while (el && el !== document.body && el !== document.documentElement) {
        const overflowY = window.getComputedStyle(el).overflowY;
        const canScroll = overflowY === 'auto' || overflowY === 'scroll';
        if (canScroll && el.scrollHeight > el.clientHeight + 2) {
          // Check if it's currently at boundary or has room to scroll
          const isScrollingDown = e.deltaY > 0;
          const isAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
          const isAtTop = el.scrollTop <= 2;

          if (isScrollingDown && !isAtBottom) {
            hasScrollableParent = true;
            break;
          }
          if (!isScrollingDown && !isAtTop) {
            hasScrollableParent = true;
            break;
          }
        }
        el = el.parentElement;
      }

      if (hasScrollableParent) {
        wheelAccumulatorRef.current = 0;
        return;
      }

      // No vertical scroll possible in this context: use wheel to navigate pages
      if (Math.abs(e.deltaY) < 6) return;

      const now = Date.now();
      // Reset accumulator if user stopped scrolling for a moment
      if (now - lastWheelTimeRef.current > 400) {
        wheelAccumulatorRef.current = 0;
      }
      lastWheelTimeRef.current = now;

      wheelAccumulatorRef.current += e.deltaY;

      // Threshold to trigger page flip (prevents accidental trigger on small trackpad gestures)
      const THRESHOLD = 50;

      if (wheelAccumulatorRef.current >= THRESHOLD) {
        e.preventDefault();
        wheelAccumulatorRef.current = 0;
        goToNextPage();
      } else if (wheelAccumulatorRef.current <= -THRESHOLD) {
        e.preventDefault();
        wheelAccumulatorRef.current = 0;
        goToPrevPage();
      }
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, [goToNextPage, goToPrevPage]);

  // Intercept footnote and page hyperlinks
  const handleMarkdownLinkClick = useCallback((e) => {
    const link = e.target.closest('a[data-page-num]');
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      const targetPageNum = parseInt(link.getAttribute('data-page-num'), 10);
      const targetIdx = pageNumToIdx[targetPageNum];
      if (targetIdx !== undefined) {
        goToPage(targetIdx);
      }
    }
  }, [goToPage]);

  // Click on single page card handler
  const handleSinglePageClick = (e) => {
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) return;
    if (e.target.closest('a, button, input, select, textarea')) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    if (clickX < rect.width * 0.18) {
      goToPrevPage();
    } else {
      goToNextPage();
    }
  };

  // Click on double spread left page (navigates backward)
  const handleLeftPageClick = (e) => {
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) return;
    if (e.target.closest('a, button, input, select, textarea')) return;
    goToPrevPage();
  };

  // Click on double spread right page (navigates forward)
  const handleRightPageClick = (e) => {
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) return;
    if (e.target.closest('a, button, input, select, textarea')) return;
    goToNextPage();
  };

  // YouTube-style progress bar drag & hover logic
  const getIndexFromRatio = useCallback((ratio) => {
    return Math.max(0, Math.min(totalPages - 1, Math.round(ratio * (totalPages - 1))));
  }, [totalPages]);

  const handleBarMouseMove = (e) => {
    if (!progressBarRef.current) return;
    const rect = progressBarRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const ratio = x / rect.width;
    setHoverRatio(ratio);
    if (isDragging) {
      const targetIdx = getIndexFromRatio(ratio);
      goToPage(targetIdx);
    }
  };

  const handleBarMouseDown = (e) => {
    e.preventDefault();
    setIsDragging(true);
    if (!progressBarRef.current) return;
    const rect = progressBarRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const ratio = x / rect.width;
    setHoverRatio(ratio);
    const targetIdx = getIndexFromRatio(ratio);
    goToPage(targetIdx);
  };

  // Global mousemove/mouseup when dragging
  useEffect(() => {
    if (!isDragging) return;

    const onGlobalMouseMove = (e) => {
      if (!progressBarRef.current) return;
      const rect = progressBarRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const ratio = x / rect.width;
      setHoverRatio(ratio);
      const targetIdx = getIndexFromRatio(ratio);
      goToPage(targetIdx);
    };

    const onGlobalMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', onGlobalMouseMove);
    window.addEventListener('mouseup', onGlobalMouseUp);
    return () => {
      window.removeEventListener('mousemove', onGlobalMouseMove);
      window.removeEventListener('mouseup', onGlobalMouseUp);
    };
  }, [isDragging, getIndexFromRatio, goToPage]);

  // Identify active H1 section for header indicator & TOC highlight
  const activeTocItem = useMemo(() => {
    const targetIdx = leftPage ? leftPage.pageIndex : currentPageIndex;
    let current = null;
    for (const item of bookData.toc) {
      if (item.pageIndex <= targetIdx) {
        current = item;
      } else {
        break;
      }
    }
    return current;
  }, [leftPage, currentPageIndex]);

  // Scroll active TOC item into view when TOC opens
  useEffect(() => {
    if (isTocOpen && activeTocItemRef.current) {
      activeTocItemRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [isTocOpen]);

  // Filter TOC items
  const filteredToc = useMemo(() => {
    if (!tocSearch.trim()) return bookData.toc;
    const query = tocSearch.trim().toLowerCase();
    return bookData.toc.filter((item) => item.title.toLowerCase().includes(query));
  }, [tocSearch]);

  // Render markdown HTML for pages with footnote link transformation
  const renderedLeftHtml = useMemo(() => {
    if (!leftPage || !leftPage.content || !leftPage.content.trim()) return '';
    return processMarkdownWithFootnotes(leftPage.content, leftPage.pageNumber);
  }, [leftPage]);

  const renderedRightHtml = useMemo(() => {
    if (!rightPage || !rightPage.content || !rightPage.content.trim()) return '';
    return processMarkdownWithFootnotes(rightPage.content, rightPage.pageNumber);
  }, [rightPage]);

  // Handle jump form submit
  const handleJumpSubmit = (e) => {
    e.preventDefault();
    const val = parseInt(jumpInput, 10);
    if (!isNaN(val)) {
      if (val >= 1 && val <= totalPages) {
        goToPage(val - 1);
      }
    }
  };

  // Progress metrics
  const progressPercent = ((currentPageIndex / (totalPages - 1)) * 100).toFixed(2);
  const previewIndex = isDragging ? currentPageIndex : getIndexFromRatio(hoverRatio);
  const previewPage = bookData.pages[previewIndex] || bookData.pages[0];
  const previewChapter = useMemo(() => {
    let current = null;
    for (const item of bookData.toc) {
      if (item.pageIndex <= previewIndex) {
        current = item;
      } else {
        break;
      }
    }
    return current;
  }, [previewIndex]);

  const previewTooltipPercent = Math.max(5, Math.min(95, isDragging ? progressPercent : hoverRatio * 100));

  return (
    <div className="reader-app">
      {/* Header Bar */}
      <header className="reader-header">
        <div className="header-left">
          <button
            type="button"
            className="btn-header"
            onClick={() => setIsTocOpen(true)}
            title="목차 열기 (단축키: M)"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
            <span>목차</span>
          </button>

          {/* {activeTocItem && (
            <span className="current-chapter-title" title={activeTocItem.title}>
              {activeTocItem.title}
            </span>
          )} */}
        </div>

        <div className="header-center">
          <h1 className="book-title-header">{bookData.title}</h1>
        </div>

        <div className="header-right">
          {/* View Mode (한쪽 보기 / 두쪽 보기) */}
          <div className="view-mode-controls">
            <button
              type="button"
              className={`btn-view-toggle ${viewMode === 'single' ? 'active' : ''}`}
              onClick={() => setViewMode('single')}
              title="한쪽 보기"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="5" y="3" width="14" height="18" rx="2" />
              </svg>
              <span>한쪽 보기</span>
            </button>
            <button
              type="button"
              className={`btn-view-toggle ${viewMode === 'double' ? 'active' : ''}`}
              onClick={() => setViewMode('double')}
              title="두쪽 보기 (펼침면)"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="3" width="9" height="18" rx="1.5" />
                <rect x="13" y="3" width="9" height="18" rx="1.5" />
              </svg>
              <span>두쪽 보기</span>
            </button>
          </div>

          {/* Fit Mode (화면 맞춤: 높이 / 맞춤 없음 / 너비) */}
          <button
            type="button"
            className="btn-fit-toggle"
            onClick={cycleFitMode}
            title="화면 맞춤 전환 (높이 → 없음 → 너비)"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {fitMode === 'height' && (
                <>
                  <line x1="12" y1="2" x2="12" y2="22" />
                  <polyline points="8 6 12 2 16 6" />
                  <polyline points="8 18 12 22 16 18" />
                </>
              )}
              {fitMode === 'fit' && (
                <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
              )}
              {fitMode === 'width' && (
                <>
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <polyline points="6 8 2 12 6 16" />
                  <polyline points="18 8 22 12 18 16" />
                </>
              )}
            </svg>
            <span>{fitMode === 'fit' ? '맞춤 없음' : `맞춤: ${fitModeLabel}`}</span>
          </button>

          {/* Font Controls */}
          <div className="font-controls">
            <button
              type="button"
              className="btn-font-toggle"
              onClick={() => setFontFamily((prev) => (prev === 'serif' ? 'sans' : 'serif'))}
              title="글꼴 변경 (바탕체 / 고딕)"
            >
              {fontFamily === 'serif' ? '바탕체' : '고딕'}
            </button>
            <button
              type="button"
              className="btn-font-size"
              disabled={fontSize <= 14}
              onClick={() => setFontSize((s) => Math.max(14, s - 1))}
              title="글자 작게"
            >
              가-
            </button>
            <button
              type="button"
              className="btn-font-size"
              disabled={fontSize >= 22}
              onClick={() => setFontSize((s) => Math.min(22, s + 1))}
              title="글자 크게"
            >
              가+
            </button>
            <button
              type="button"
              className="btn-font-size btn-font-reset"
              disabled={fontSize === 17}
              onClick={() => setFontSize(17)}
              title="글자 크기 초기화 (17px)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          </div>

          {/* Download Dropdown */}
          <div className="download-dropdown-container" ref={downloadRef}>
            <button
              type="button"
              className={`btn-header-download ${isDownloadOpen ? 'active' : ''}`}
              onClick={() => setIsDownloadOpen((prev) => !prev)}
              title="도서 원문 다운로드 (Markdown, JSON)"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>

            </button>

            {isDownloadOpen && (
              <div className="download-menu">
                <div className="download-menu-header">원문 파일 다운로드</div>
                <button
                  type="button"
                  className="download-menu-item"
                  onClick={handleDownloadMarkdown}
                >
                  <div className="download-item-info">
                    <span className="download-item-title">Markdown (.md)</span>
                  </div>
                </button>
                <button
                  type="button"
                  className="download-menu-item"
                  onClick={handleDownloadJson}
                >
                  <div className="download-item-info">
                    <span className="download-item-title">JSON (.json)</span>
                  </div>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Workspace */}
      <main className={`reader-workspace fit-${fitMode}`} ref={workspaceRef}>
        {/* Floating Side Navigation Buttons */}
        <button
          type="button"
          className="side-nav-btn side-nav-prev"
          disabled={currentPageIndex === 0}
          onClick={goToPrevPage}
          title="이전 페이지 (←)"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>

        <button
          type="button"
          className="side-nav-btn side-nav-next"
          disabled={currentPageIndex === totalPages - 1}
          onClick={goToNextPage}
          title="다음 페이지 (→, Space)"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>

        {/* Spread Container */}
        <div className={`spread-container view-${isDoubleSpread ? 'double' : 'single'} fit-${fitMode}`}>
          {/* Left Page (or Single Page) */}
          {leftPage && (
            <article
              className="reader-page-card left-page"
              onClick={isDoubleSpread ? handleLeftPageClick : handleSinglePageClick}
              title={isDoubleSpread ? "클릭 시 이전 페이지로 이동" : "클릭 시 다음 페이지로 이동 (좌측 클릭 시 이전)"}
            >
              {!isDoubleSpread && <div className="page-click-indicator-prev" />}

              {/* Book Page Header */}
              {/* <div className="page-card-header">
                <span className="page-card-header-title">
                  {activeTocItem?.title || bookData.title}
                </span>
                <span className="page-card-header-num">
                  p. {leftPage.pageNumber}
                </span>
              </div> */}

              {/* Book Page Content */}
              {leftPage.pageIndex === 0 ? (
                <div className="book-cover-container">
                  <div className="cover-bg-num cover-bg-3" aria-hidden="true">3</div>
                  <div className="cover-bg-num cover-bg-0" aria-hidden="true">0</div>
                  <div className="cover-center-box">
                    <div className="cover-title-group">
                      <div className="cover-title-line">포항공과대학교</div>
                      <div className="cover-title-line">총학생회</div>
                      <div className="cover-title-line">30년사</div>
                    </div>
                    <div className="cover-divider" />
                    <div className="cover-author">
                      총학생회 30년사 편찬위원회 엮음
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  className={`page-card-content font-${fontFamily}`}
                  style={{ fontSize: `${fontSize}px` }}
                >
                  {renderedLeftHtml ? (
                    <div
                      className="page-markdown"
                      onClick={handleMarkdownLinkClick}
                      dangerouslySetInnerHTML={{ __html: renderedLeftHtml }}
                    />
                  ) : (
                    <div className="blank-page-notice">
                      본문이 없는 여백 페이지입니다.
                    </div>
                  )}
                </div>
              )}

              {/* Book Page Footer */}
              <div className="page-card-footer">
                <span className="page-card-footer-number">
                  - {leftPage.pageNumber} -
                </span>
              </div>
            </article>
          )}

          {/* Right Page (Double View) */}
          {isDoubleSpread && rightPage && (
            <article
              className="reader-page-card right-page"
              onClick={handleRightPageClick}
              title="클릭 시 다음 페이지로 이동"
            >
              {/* Book Page Header */}
              {/* <div className="page-card-header">
                <span className="page-card-header-title">
                  {bookData.title}
                </span>
                <span className="page-card-header-num">
                  p. {rightPage.pageNumber}
                </span>
              </div> */}

              {/* Book Page Content */}
              <div
                className={`page-card-content font-${fontFamily}`}
                style={{ fontSize: `${fontSize}px` }}
              >
                {renderedRightHtml ? (
                  <div
                    className="page-markdown"
                    onClick={handleMarkdownLinkClick}
                    dangerouslySetInnerHTML={{ __html: renderedRightHtml }}
                  />
                ) : (
                  <div className="blank-page-notice">
                    본문이 없는 여백 페이지입니다.
                  </div>
                )}
              </div>

              {/* Book Page Footer */}
              <div className="page-card-footer">
                <span className="page-card-footer-number">
                  - {rightPage.pageNumber} -
                </span>
              </div>
            </article>
          )}
        </div>
      </main>

      {/* Bottom Bar with YouTube-style Progress Bar */}
      <footer className="reader-bottom-bar">
        {/* Interactive Progress Bar */}
        <div
          className={`progress-interactive-area ${isHoveringBar ? 'is-hovered' : ''} ${isDragging ? 'is-dragging' : ''}`}
          ref={progressBarRef}
          onMouseEnter={() => setIsHoveringBar(true)}
          onMouseLeave={() => !isDragging && setIsHoveringBar(false)}
          onMouseMove={handleBarMouseMove}
          onMouseDown={handleBarMouseDown}
        >
          {/* Progress Track */}
          <div className="progress-track">
            {/* Filled Progress */}
            <div
              className="progress-fill"
              style={{ width: `${progressPercent}%` }}
            />

            {/* Scrubber Dot (동그란 점) */}
            <div
              className="progress-scrubber-dot"
              style={{ left: `${progressPercent}%` }}
            />
          </div>

          {/* Floating Preview Tooltip */}
          {(isHoveringBar || isDragging) && (
            <div
              className="progress-preview-tooltip"
              style={{ left: `${previewTooltipPercent}%` }}
            >
              <div className="tooltip-page-num">

                {previewChapter ? `${previewChapter.title}` : ''}
              </div>
              <div className="tooltip-sub">
                {previewIndex + 1} / {totalPages}
              </div>
            </div>
          )}
        </div>

        <div></div>

        <div className="nav-center">
          <form className="page-jump-box" onSubmit={handleJumpSubmit}>
            <input
              type="text"
              className="page-input"
              value={jumpInput}
              onChange={(e) => setJumpInput(e.target.value)}
              onBlur={() => setJumpInput(String(currentPageIndex + 1))}
              aria-label="페이지 이동"
            />
            <span>/ {totalPages}</span>
            <span className="book-original-page-tag">
              {isDoubleSpread && rightPage
                ? `(도서 p.${leftPage.pageNumber} ~ p.${rightPage.pageNumber})`
                : `(도서 p.${leftPage?.pageNumber || 1})`}
            </span>
          </form>
        </div>

        <div></div>
      </footer>

      {/* Table of Contents Drawer */}
      {isTocOpen && (
        <div className="toc-backdrop" onClick={() => setIsTocOpen(false)}>
          <aside
            className="toc-drawer"
            onClick={(e) => e.stopPropagation()}
            aria-label="목차"
          >
            <div className="toc-header">
              <div className="toc-header-title-box">
                <span className="toc-header-title">목차</span>
                <span className="toc-count-badge">{bookData.toc.length}개</span>
              </div>
              <button
                type="button"
                className="btn-toc-close"
                onClick={() => setIsTocOpen(false)}
              >
                닫기
              </button>
            </div>

            <div className="toc-search-box">
              <input
                type="text"
                className="toc-search-input"
                placeholder="목차 검색 (예: 1987, 동아리, 사건사고...)"
                value={tocSearch}
                onChange={(e) => setTocSearch(e.target.value)}
                autoFocus
              />
            </div>

            <div className="toc-list-container">
              {filteredToc.length === 0 ? (
                <div className="toc-list-empty">검색 결과가 없습니다.</div>
              ) : (
                filteredToc.map((item) => {
                  const isActive = activeTocItem && activeTocItem.id === item.id;
                  return (
                    <button
                      key={item.id}
                      ref={isActive ? activeTocItemRef : null}
                      type="button"
                      className={`toc-item ${isActive ? 'active' : ''}`}
                      onClick={() => {
                        goToPage(item.pageIndex);
                        setIsTocOpen(false);
                      }}
                    >
                      <span className="toc-item-title">{item.title}</span>
                      <span className="toc-item-page">p.{item.pageNumber}</span>
                    </button>
                  );
                })
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
