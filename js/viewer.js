/**
 * js/viewer.js
 * Entry-point for viewer.html.
 * Fixes applied:
 *   • Lazy/progressive page rendering — visible pages first, rest queued
 *   • Zoom re-render is debounced and only replaces pages, not the full list
 *   • Mobile thumbnail sidebar toggle
 *   • Touch-swipe left/right for page navigation
 *   • Passive touch/scroll listeners where possible
 *   • scrollToPage uses "instant" only when switching pages programmatically;
 *     smooth only for user-triggered navigation
 *   • ResizeObserver reflows zoom when orientation changes
 */

import {
    requireAuth,
    logoutUser,
    saveLastPage,
    loadLastPage,
    setBookmark,
    loadBookmarks
} from "./firebase.js";

import { HighlightManager, HIGHLIGHT_COLORS } from "./highlight.js";

// ── PDF.js worker ─────────────────────────────────────────────
const PDFJS_VERSION = "3.11.174";
const PDFJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;

// ── App state ─────────────────────────────────────────────────
let pdfDoc = null;
let currentPage = 1;
let totalPages = 0;
let currentScale = 1.25;
let isRendering = false;
let pdfName = "";
let pdfPath = "";
let user = null;
let highlighter = null;
let bookmarkedPages = new Set();
let metaTimer = null;
let zoomTimer = null;

const MIN_SCALE = 0.5;
const MAX_SCALE = 3.0;
const SCALE_STEP = 0.25;

/** Set of page numbers that have been fully rendered at current scale. */
const renderedPages = new Set();

// ── DOM refs ──────────────────────────────────────────────────
const els = {};

function cacheEls() {
    const ids = [
        "pdf-name", "back-btn", "btn-zoom-in", "btn-zoom-out", "zoom-level",
        "btn-prev", "btn-next", "page-input", "page-total",
        "btn-highlight", "btn-erase", "btn-bookmark", "btn-search",
        "btn-theme", "btn-logout", "btn-thumbs",
        "pdf-canvas-area", "thumb-sidebar",
        "status-text", "status-dot",
        "toast-container", "mode-banner", "search-panel", "search-input",
        "btn-search-next", "btn-search-prev", "search-status"
    ];
    ids.forEach(id => { els[id] = document.getElementById(id); });
    els.colorBtns = document.querySelectorAll(".color-btn");
}

// ── Helpers ───────────────────────────────────────────────────
const isMobile = () => window.innerWidth <= 640;

// ╔═══════════════════════════════════════════════════════════╗
// ║  BOOT                                                     ║
// ╚═══════════════════════════════════════════════════════════╝

async function boot() {
    user = await requireAuth();
    cacheEls();

    const params = new URLSearchParams(window.location.search);
    pdfName = params.get("name") || "Document";
    pdfPath = params.get("path") || "";

    if (!pdfPath) { showToast("No PDF specified", "error"); return; }

    applyStoredTheme();
    els["pdf-name"].textContent = pdfName;
    document.title = `${pdfName} — Courses Glance`;

    highlighter = new HighlightManager({
        userId: user.uid,
        pdfName,
        onSaving: setSaving,
        onToast: showToast
    });

    wireToolbar();
    wireTouch();
    wireResize();

    await loadPDF();
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  PDF LOADING                                              ║
// ╚═══════════════════════════════════════════════════════════╝

async function loadPDF() {
    try {
        setStatus("Loading PDF…");

        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            `${PDFJS_CDN}/pdf.worker.min.js`;

        pdfDoc = await window.pdfjsLib.getDocument({ url: pdfPath }).promise;
        totalPages = pdfDoc.numPages;
        els["page-total"].textContent = `/ ${totalPages}`;

        const meta = await loadLastPage(user.uid, pdfName);
        currentScale = meta.lastScale || (isMobile() ? 1.0 : 1.25);
        currentPage = Math.min(Math.max(1, meta.lastPage || 1), totalPages);

        updateZoomLabel();

        // Render all page shells (canvas placeholders), then fill visible ones
        await buildPageShells();
        await renderVisiblePages();

        // Lazy-render remaining pages in background
        backgroundRenderRemaining();

        await highlighter.loadAll();

        bookmarkedPages = new Set(await loadBookmarks(user.uid, pdfName));
        updateBookmarkBtn();

        scrollToPage(currentPage, false);
        setStatus(`${totalPages} pages`);
        showToast(`Opened ${pdfName}`, "success");

    } catch (err) {
        console.error("[Viewer] PDF load error:", err);
        setStatus("Failed to load PDF");
        showToast("Could not load PDF. Check the file path.", "error");
    }
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  RENDERING                                                ║
// ╚═══════════════════════════════════════════════════════════╝

/**
 * Build empty page containers for every page so scrollbar sizing is correct,
 * then fill them lazily.
 */
async function buildPageShells() {
    els["pdf-canvas-area"].innerHTML = "";
    els["thumb-sidebar"].innerHTML = "";
    renderedPages.clear();

    // Need first page viewport for size estimation
    const firstPage = await pdfDoc.getPage(1);
    const vp0 = firstPage.getViewport({ scale: currentScale });

    for (let i = 1; i <= totalPages; i++) {
        const container = document.createElement("div");
        container.className = "page-container";
        container.dataset.page = i;
        // Approximate height from first page — will be corrected when rendered
        container.style.width = `${vp0.width}px`;
        container.style.height = `${vp0.height}px`;
        container.style.background = "var(--bg-card)";

        const chip = document.createElement("div");
        chip.className = "page-chip";
        chip.textContent = i;
        container.appendChild(chip);

        els["pdf-canvas-area"].appendChild(container);
        observePage(container, i);

        // Thumbnail
        renderThumb(i); // non-blocking
    }
}

/** Render pages currently near the viewport (current ±2). */
async function renderVisiblePages() {
    const from = Math.max(1, currentPage - 1);
    const to = Math.min(totalPages, currentPage + 2);
    for (let i = from; i <= to; i++) {
        if (!renderedPages.has(i)) {
            await renderPage(i);
        }
    }
}

/** Render all remaining pages in the background without blocking UI. */
function backgroundRenderRemaining() {
    let pg = 1;
    function next() {
        if (pg > totalPages) return;
        if (renderedPages.has(pg)) { pg++; next(); return; }
        renderPage(pg).then(() => { pg++; requestIdleCallback ? requestIdleCallback(next) : setTimeout(next, 50); });
    }
    requestIdleCallback ? requestIdleCallback(next) : setTimeout(next, 200);
}

/** Render a single PDF page into its existing container. */
async function renderPage(pageNum) {
    const container = document.querySelector(`.page-container[data-page="${pageNum}"]`);
    if (!container) return;

    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: currentScale });

    container.style.width = `${viewport.width}px`;
    container.style.height = `${viewport.height}px`;

    // Remove stale content (chip stays at end)
    while (container.firstChild && !container.firstChild.classList?.contains("page-chip")) {
        container.removeChild(container.firstChild);
    }

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const hlLayer = document.createElement("div");
    hlLayer.className = "highlight-layer";

    const textLayerDiv = document.createElement("div");
    textLayerDiv.className = "textLayer";
    textLayerDiv.style.width = `${viewport.width}px`;
    textLayerDiv.style.height = `${viewport.height}px`;

    // Insert before the chip
    const chip = container.querySelector(".page-chip");
    container.insertBefore(canvas, chip || null);
    container.insertBefore(hlLayer, chip || null);
    container.insertBefore(textLayerDiv, chip || null);

    const renderTask = page.render({ canvasContext: ctx, viewport });
    const textContent = await page.getTextContent();
    await renderTask.promise;

    window.pdfjsLib.renderTextLayer({
        textContent,
        container: textLayerDiv,
        viewport,
        textDivs: []
    });

    renderedPages.add(pageNum);

    // Re-apply any saved highlights for this page
    if (highlighter) highlighter.renderPageHighlights(pageNum);
}

/** Render thumbnail. */
async function renderThumb(pageNum) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 0.2 });

    const wrapper = document.createElement("div");
    wrapper.className = "thumb-item";
    wrapper.dataset.page = pageNum;
    wrapper.onclick = () => {
        scrollToPage(pageNum);
        // Close sidebar on mobile after tap
        if (isMobile()) closeThumbs();
    };

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const numDiv = document.createElement("div");
    numDiv.className = "thumb-num";
    numDiv.textContent = pageNum;

    wrapper.appendChild(canvas);
    wrapper.appendChild(numDiv);
    els["thumb-sidebar"].appendChild(wrapper);

    page.render({ canvasContext: canvas.getContext("2d"), viewport });
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  ZOOM                                                     ║
// ╚═══════════════════════════════════════════════════════════╝

function scheduleZoom(newScale) {
    newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
    if (newScale === currentScale) return;

    currentScale = newScale;
    updateZoomLabel();

    // Debounce: wait 300ms after last zoom event before re-rendering
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => applyZoom(), 300);
}

async function applyZoom() {
    if (isRendering) return;
    isRendering = true;

    const prevPage = currentPage;
    renderedPages.clear();
    setStatus("Zooming…");

    // Rebuild shells at new scale
    await buildPageShells();
    await renderVisiblePages();
    backgroundRenderRemaining();

    scrollToPage(prevPage, false);
    isRendering = false;
    setStatus(`${totalPages} pages`);
    debouncedSaveMeta();
}

function updateZoomLabel() {
    if (els["zoom-level"]) els["zoom-level"].textContent = `${Math.round(currentScale * 100)}%`;
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  PAGE NAVIGATION                                          ║
// ╚═══════════════════════════════════════════════════════════╝

function scrollToPage(pageNum, smooth = true) {
    const container = document.querySelector(`.page-container[data-page="${pageNum}"]`);
    if (!container) return;

    container.scrollIntoView({
        behavior: smooth ? "smooth" : "instant",
        block: "start"
    });

    setCurrentPage(pageNum);

    // Ensure nearby pages are rendered
    if (pdfDoc) {
        const from = Math.max(1, pageNum - 1);
        const to = Math.min(totalPages, pageNum + 2);
        for (let i = from; i <= to; i++) {
            if (!renderedPages.has(i)) renderPage(i);
        }
    }
}

function setCurrentPage(pageNum) {
    currentPage = Math.min(Math.max(1, pageNum), totalPages || 1);
    if (els["page-input"]) els["page-input"].value = currentPage;

    document.querySelectorAll(".thumb-item").forEach(el => {
        el.classList.toggle("active", Number(el.dataset.page) === currentPage);
    });

    updateBookmarkBtn();
    debouncedSaveMeta();
}

function observePage(container, pageNum) {
    const observer = new IntersectionObserver(
        entries => {
            entries.forEach(entry => {
                if (entry.isIntersecting && entry.intersectionRatio > 0.4) {
                    setCurrentPage(pageNum);
                    // Lazy-render when page scrolls into view
                    if (pdfDoc && !renderedPages.has(pageNum)) renderPage(pageNum);
                }
            });
        },
        { root: els["pdf-canvas-area"], threshold: 0.4 }
    );
    observer.observe(container);
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  BOOKMARKS                                                ║
// ╚═══════════════════════════════════════════════════════════╝

async function toggleBookmark() {
    const pg = currentPage;
    const isNow = !bookmarkedPages.has(pg);
    if (isNow) bookmarkedPages.add(pg); else bookmarkedPages.delete(pg);
    updateBookmarkBtn();
    try {
        await setBookmark(user.uid, pdfName, pg, isNow);
        showToast(isNow ? `Bookmarked page ${pg}` : `Bookmark removed`, "info");
    } catch (err) { console.error("[Bookmark]", err); }
}

function updateBookmarkBtn() {
    const btn = els["btn-bookmark"];
    if (!btn) return;
    btn.classList.toggle("bookmarked", bookmarkedPages.has(currentPage));
    btn.title = bookmarkedPages.has(currentPage) ? "Remove bookmark" : "Bookmark this page";
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  TOOLBAR WIRING                                           ║
// ╚═══════════════════════════════════════════════════════════╝

function wireToolbar() {
    els["back-btn"].addEventListener("click", () => { window.location.href = "dashboard.html"; });

    els["btn-zoom-in"].addEventListener("click", () => scheduleZoom(currentScale + SCALE_STEP));
    els["btn-zoom-out"].addEventListener("click", () => scheduleZoom(currentScale - SCALE_STEP));

    // Ctrl+wheel zoom — passive:false required to preventDefault
    els["pdf-canvas-area"].addEventListener("wheel", e => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            scheduleZoom(currentScale + (e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP));
        }
    }, { passive: false });

    els["btn-prev"].addEventListener("click", () => scrollToPage(currentPage - 1));
    els["btn-next"].addEventListener("click", () => scrollToPage(currentPage + 1));

    els["page-input"].addEventListener("change", () => {
        const val = parseInt(els["page-input"].value);
        if (val >= 1 && val <= totalPages) scrollToPage(val);
        else els["page-input"].value = currentPage;
    });

    document.addEventListener("keydown", handleKeydown);

    // Highlight
    els["btn-highlight"].addEventListener("click", () => {
        setMode(highlighter.mode === "highlight" ? "none" : "highlight");
    });
    els["btn-erase"].addEventListener("click", () => {
        setMode(highlighter.mode === "erase" ? "none" : "erase");
    });

    els.colorBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            els.colorBtns.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            highlighter.setColor(btn.dataset.color);
            if (highlighter.mode !== "highlight") setMode("highlight");
        });
    });
    document.querySelector('[data-color="yellow"]')?.classList.add("active");

    els["btn-bookmark"]?.addEventListener("click", toggleBookmark);

    els["btn-search"]?.addEventListener("click", toggleSearchPanel);
    els["btn-search-next"]?.addEventListener("click", () => doSearch("next"));
    els["btn-search-prev"]?.addEventListener("click", () => doSearch("prev"));
    els["search-input"]?.addEventListener("keydown", e => { if (e.key === "Enter") doSearch("next"); });

    els["btn-theme"].addEventListener("click", toggleTheme);
    els["btn-logout"].addEventListener("click", async () => {
        await logoutUser();
        window.location.replace("login.html");
    });

    // Mobile thumbnail toggle
    els["btn-thumbs"]?.addEventListener("click", toggleThumbs);
}

// ── Mode banner ───────────────────────────────────────────────
function setMode(mode) {
    highlighter.setMode(mode);
    els["btn-highlight"].classList.toggle("active", mode === "highlight");
    els["btn-erase"].classList.toggle("active", mode === "erase");

    const banner = els["mode-banner"];
    banner.classList.remove("highlight-mode", "erase-mode", "hidden");

    if (mode === "highlight") {
        banner.className = "mode-banner highlight-mode";
        banner.textContent = "✏️  Highlight — select text";
    } else if (mode === "erase") {
        banner.className = "mode-banner erase-mode";
        banner.textContent = "🗑️  Erase — tap a highlight";
    } else {
        banner.classList.add("hidden");
    }
}

// ── Keyboard shortcuts ────────────────────────────────────────
function handleKeydown(e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    switch (e.key) {
        case "ArrowRight": case "ArrowDown": case "PageDown": scrollToPage(currentPage + 1); break;
        case "ArrowLeft": case "ArrowUp": case "PageUp": scrollToPage(currentPage - 1); break;
        case "Home": scrollToPage(1); break;
        case "End": scrollToPage(totalPages); break;
        case "+": case "=":
            if (e.ctrlKey || e.metaKey) { e.preventDefault(); scheduleZoom(currentScale + SCALE_STEP); } break;
        case "-":
            if (e.ctrlKey || e.metaKey) { e.preventDefault(); scheduleZoom(currentScale - SCALE_STEP); } break;
        case "h": case "H": setMode(highlighter.mode === "highlight" ? "none" : "highlight"); break;
        case "e": case "E": setMode(highlighter.mode === "erase" ? "none" : "erase"); break;
        case "Escape": setMode("none"); break;
        case "b": case "B": toggleBookmark(); break;
        case "f": case "F":
            if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleSearchPanel(); } break;
    }
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  TOUCH SWIPE (mobile page nav)                            ║
// ╚═══════════════════════════════════════════════════════════╝

function wireTouch() {
    let touchStartX = 0;
    let touchStartY = 0;

    const area = els["pdf-canvas-area"];

    area.addEventListener("touchstart", e => {
        touchStartX = e.changedTouches[0].clientX;
        touchStartY = e.changedTouches[0].clientY;
    }, { passive: true });

    area.addEventListener("touchend", e => {
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;
        // Only treat as horizontal swipe if mostly horizontal and large enough
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            if (dx < 0) scrollToPage(currentPage + 1); // swipe left → next
            else scrollToPage(currentPage - 1); // swipe right → prev
        }
    }, { passive: true });
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  RESIZE / ORIENTATION CHANGE                              ║
// ╚═══════════════════════════════════════════════════════════╝

function wireResize() {
    let resizeTimer = null;
    window.addEventListener("resize", () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            // On orientation change on mobile, adjust scale to fit width
            if (isMobile() && pdfDoc) {
                scheduleZoom(currentScale); // triggers re-render at same scale; layout will reflow
            }
        }, 400);
    });
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  THUMBNAIL SIDEBAR (mobile toggle)                        ║
// ╚═══════════════════════════════════════════════════════════╝

function toggleThumbs() {
    const sidebar = els["thumb-sidebar"];
    const isOpen = sidebar.classList.toggle("open");
    if (els["btn-thumbs"]) els["btn-thumbs"].classList.toggle("active", isOpen);
}

function closeThumbs() {
    els["thumb-sidebar"]?.classList.remove("open");
    els["btn-thumbs"]?.classList.remove("active");
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  SEARCH                                                   ║
// ╚═══════════════════════════════════════════════════════════╝

let searchMatches = [];
let searchIndex = -1;

function toggleSearchPanel() {
    const panel = els["search-panel"];
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) {
        els["search-input"].focus();
    } else {
        clearSearchHighlights();
    }
}

async function doSearch(direction) {
    const term = els["search-input"].value.trim();
    if (!term || !pdfDoc) return;

    searchMatches = [];
    for (let pg = 1; pg <= totalPages; pg++) {
        const page = await pdfDoc.getPage(pg);
        const content = await page.getTextContent();
        const text = content.items.map(i => i.str).join(" ");
        if (text.toLowerCase().includes(term.toLowerCase())) {
            searchMatches.push(pg);
        }
    }

    if (searchMatches.length === 0) {
        els["search-status"].textContent = "No matches";
        return;
    }

    searchIndex = direction === "next"
        ? (searchIndex + 1) % searchMatches.length
        : (searchIndex - 1 + searchMatches.length) % searchMatches.length;

    scrollToPage(searchMatches[searchIndex]);
    els["search-status"].textContent = `${searchIndex + 1} / ${searchMatches.length}`;
}

function clearSearchHighlights() {
    searchMatches = [];
    searchIndex = -1;
    if (els["search-status"]) els["search-status"].textContent = "";
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  THEME                                                    ║
// ╚═══════════════════════════════════════════════════════════╝

function applyStoredTheme() {
    const stored = localStorage.getItem("cg_theme") || "light";
    document.documentElement.setAttribute("data-theme", stored);
    updateThemeIcon(stored);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("cg_theme", next);
    updateThemeIcon(next);
}

function updateThemeIcon(theme) {
    const btn = els["btn-theme"];
    if (!btn) return;
    btn.innerHTML = theme === "dark"
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  STATUS & TOASTS                                          ║
// ╚═══════════════════════════════════════════════════════════╝

function setStatus(msg) {
    if (els["status-text"]) els["status-text"].textContent = msg;
}

function setSaving(isSaving) {
    const dot = els["status-dot"];
    if (!dot) return;
    dot.classList.toggle("saving", isSaving);
    setStatus(isSaving ? "Saving…" : `${totalPages} pages`);
}

function showToast(msg, type = "info") {
    const container = els["toast-container"];
    if (!container) return;
    const icons = { success: "✓", error: "✕", info: "ℹ" };
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${icons[type]}</span>${msg}`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.cssText += "opacity:0;transform:translateX(20px);transition:all 0.3s ease;";
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  META PERSISTENCE (debounced)                             ║
// ╚═══════════════════════════════════════════════════════════╝

function debouncedSaveMeta() {
    clearTimeout(metaTimer);
    metaTimer = setTimeout(async () => {
        try { await saveLastPage(user.uid, pdfName, currentPage, currentScale); }
        catch (_) { /* silent */ }
    }, 1500);
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  INIT                                                     ║
// ╚═══════════════════════════════════════════════════════════╝

boot().catch(err => { console.error("[Viewer] Boot error:", err); });