import { useState, useEffect, useRef, useMemo } from 'react';
import { marked } from 'marked';
import bookData from './bookData.json';
import './App.css';

marked.setOptions({
  gfm: true,
  breaks: true,
});

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
      // Ignore localStorage read error
    }
    return 0;
  });

  const [isTocOpen, setIsTocOpen] = useState(false);
  const [tocSearch, setTocSearch] = useState('');
  
  // Font preferences (persisted)
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

  const currentPage = bookData.pages[currentPageIndex] || bookData.pages[0];

  // Save current page
  useEffect(() => {
    try {
      localStorage.setItem('postech_30y_page', String(currentPageIndex));
    } catch {
      // Ignore localStorage write error
    }
    // Scroll workspace to top on page flip
    if (workspaceRef.current) {
      workspaceRef.current.scrollTop = 0;
    }
    setJumpInput(String(currentPageIndex + 1));
  }, [currentPageIndex]);

  // Save font preferences
  useEffect(() => {
    try {
      localStorage.setItem('postech_reader_font', fontFamily);
      localStorage.setItem('postech_reader_size', String(fontSize));
    } catch {
      // Ignore
    }
  }, [fontFamily, fontSize]);

  // Navigate functions
  const goToNextPage = () => {
    setCurrentPageIndex((prev) => (prev < totalPages - 1 ? prev + 1 : prev));
  };

  const goToPrevPage = () => {
    setCurrentPageIndex((prev) => (prev > 0 ? prev - 1 : prev));
  };

  const goToPage = (index) => {
    if (index >= 0 && index < totalPages) {
      setCurrentPageIndex(index);
    }
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore key events when user is typing in search or input fields
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
  }, [totalPages]);

  // Click on book page handler (advance page on click)
  const handlePageContentClick = (e) => {
    // 1. If text was selected by mouse drag, do not flip page
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) {
      return;
    }

    // 2. If click was on a link or button, do not flip
    if (e.target.closest('a, button, input, select, textarea')) {
      return;
    }

    // 3. Determine if clicked on the left margin (18% width) to backtrack, else advance
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    if (clickX < rect.width * 0.18) {
      goToPrevPage();
    } else {
      goToNextPage();
    }
  };

  // Identify active H1 section for header indicator & TOC highlight
  const activeTocItem = useMemo(() => {
    let current = null;
    for (const item of bookData.toc) {
      if (item.pageIndex <= currentPageIndex) {
        current = item;
      } else {
        break;
      }
    }
    return current;
  }, [currentPageIndex]);

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

  // Render markdown HTML
  const renderedHtml = useMemo(() => {
    if (!currentPage.content || !currentPage.content.trim()) {
      return '';
    }
    return marked.parse(currentPage.content);
  }, [currentPage.content]);

  // Handle jump form submit
  const handleJumpSubmit = (e) => {
    e.preventDefault();
    const val = parseInt(jumpInput, 10);
    if (!isNaN(val)) {
      // If user typed 1 to 332, convert to 0-indexed
      if (val >= 1 && val <= totalPages) {
        goToPage(val - 1);
      }
    }
  };

  const progressPercent = ((currentPageIndex / (totalPages - 1)) * 100).toFixed(1);

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

          {activeTocItem && (
            <span className="current-chapter-title" title={activeTocItem.title}>
              {activeTocItem.title}
            </span>
          )}
        </div>

        <div className="header-center">
          <h1 className="book-title-header">{bookData.title}</h1>
        </div>

        <div className="header-right">
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
          </div>

          <div className="page-badge-header">
            도서 p.{currentPage.pageNumber}
          </div>
        </div>
      </header>

      {/* Main Workspace */}
      <main className="reader-workspace" ref={workspaceRef}>
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

        {/* Book Page Card */}
        <article className="reader-page-card" onClick={handlePageContentClick}>
          <div className="page-click-indicator-prev" />
          <div className="page-click-indicator-next" />

          {/* Book Page Header */}
          <div className="page-card-header">
            <span className="page-card-header-title">
              {activeTocItem?.title || bookData.title}
            </span>
            <span className="page-card-header-num">
              p. {currentPage.pageNumber}
            </span>
          </div>

          {/* Book Page Content */}
          <div
            className={`page-card-content font-${fontFamily}`}
            style={{ fontSize: `${fontSize}px` }}
          >
            {renderedHtml ? (
              <div
                className="page-markdown"
                dangerouslySetInnerHTML={{ __html: renderedHtml }}
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
              - {currentPage.pageNumber} -
            </span>
          </div>
        </article>
      </main>

      {/* Bottom Bar */}
      <footer className="reader-bottom-bar">
        <div
          className="reading-progress-bar"
          style={{ width: `${progressPercent}%` }}
        />

        <button
          type="button"
          className="btn-nav"
          disabled={currentPageIndex === 0}
          onClick={goToPrevPage}
          title="이전 페이지 (단축키: ←)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
          <span>이전</span>
        </button>

        <div className="nav-center">
          <form className="page-jump-box" onSubmit={handleJumpSubmit}>
            <span>페이지</span>
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
              (도서 p.{currentPage.pageNumber})
            </span>
          </form>
        </div>

        <button
          type="button"
          className="btn-nav"
          disabled={currentPageIndex === totalPages - 1}
          onClick={goToNextPage}
          title="다음 페이지 (단축키: →, Space)"
        >
          <span>다음</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </button>
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
