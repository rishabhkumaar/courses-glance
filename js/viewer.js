/**
 * js/viewer.js
 * Entry-point for viewer.html.
 * Handles:
 *   • Auth guard
 *   • PDF.js loading + rendering
 *   • Page navigation, zoom, smooth scroll
 *   • Thumbnail sidebar
 *   • Toolbar wiring
 *   • Highlights (via HighlightManager)
 *   • Bookmarks
 *   • Resume last page
 *   • Toast notifications
 *   • Dark-mode toggle
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

// ── PDF.js CDN worker ─────────────────────────────────────────
const PDFJS_VERSION = "3.11.174";
const PDFJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;

// pdfjsLib is loaded via <script> tag in viewer.html (window global)

// ── App state ─────────────────────────────────────────────────
let pdfDoc = null;
let currentPage = 1;
let totalPages = 0;
let currentScale = 1.25;
let isRendering = false;
let renderQueue = [];    // pages waiting to re-render after zoom
let pdfName = "";
let pdfPath = "";
let user = null;
let highlighter = null;
let bookmarkedPages = new Set();
let savingTimer = null;

const MIN_SCALE = 0.5;
const MAX_SCALE = 3.0;
const SCALE_STEP = 0.25;

// ── DOM refs ──────────────────────────────────────────────────
const els = {};

function cacheEls() {
    const ids = [
        "pdf-name", "back-btn", "btn-zoom-in", "btn-zoom-out", "zoom-level",
        "btn-prev", "btn-next", "page-input", "page-total",
        "btn-highlight", "btn-erase", "btn-bookmark", "btn-search",
        "btn-theme", "btn-logout",
        "pdf-canvas-area", "thumb-sidebar",
        "status-text", "status-dot",
        "toast-container", "mode-banner", "search-panel", "search-input",
        "btn-search-next", "btn-search-prev", "search-status"
    ];
    ids.forEach(id => {
        els[id] = document.getElementById(id);
    });
    // colour buttons
    els.colorBtns = document.querySelectorAll(".color-btn");
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  BOOT                                                     ║
// ╚═══════════════════════════════════════════════════════════╝

async function boot() {
    // 1. Auth guard
    user = await requireAuth();

    cacheEls();

    // 2. Read URL params
    const params = new URLSearchParams(window.location.search);
    pdfName = params.get("name") || "Document";
    pdfPath = params.get("path") || "";

    if (!pdfPath) { showToast("No PDF specified", "error"); return; }

    // 3. UI setup
    applyStoredTheme();
    els["pdf-name"].textContent = pdfName;
    document.title = `${pdfName} — Courses Glance`;

    // 4. Init highlight manager
    highlighter = new HighlightManager({
        userId: user.uid,
        pdfName,
        onSaving: setSaving,
        onToast: showToast
    });

    // 5. Wire toolbar events
    wireToolbar();

    // 6. Load PDF
    await loadPDF();
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  PDF LOADING                                              ║
// ╚═══════════════════════════════════════════════════════════╝

async function loadPDF() {
    try {
        setStatus("Loading PDF…");

        // Configure PDF.js worker
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            `${PDFJS_CDN}/pdf.worker.min.js`;

        pdfDoc = await window.pdfjsLib.getDocument({ url: pdfPath }).promise;
        totalPages = pdfDoc.numPages;

        els["page-total"].textContent = `/ ${totalPages}`;

        // Load resume position + scale from Firebase
        const meta = await loadLastPage(user.uid, pdfName);
        currentScale = meta.lastScale || 1.25;
        currentPage = meta.lastPage || 1;
        currentPage = Math.min(Math.max(1, currentPage), totalPages);

        updateZoomLabel();

        // Render all pages
        await renderAllPages();

        // Load and render saved highlights
        await highlighter.loadAll();

        // Load bookmarks
        bookmarkedPages = new Set(await loadBookmarks(user.uid, pdfName));
        updateBookmarkBtn();

        // Scroll to last page
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

async function renderAllPages() {
    els["pdf-canvas-area"].innerHTML = "";
    els["thumb-sidebar"].innerHTML = "";

    for (let i = 1; i <= totalPages; i++) {
        await renderPage(i);
        renderThumb(i);  // async thumb render (non-blocking)
    }
}

/**
 * Render a single page into the canvas area.
 * Creates/replaces the page-container div.
 */
async function renderPage(pageNum) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: currentScale });

    // ── Wrapper ──────────────────────────────────────
    const container = document.createElement("div");
    container.className = "page-container";
    container.dataset.page = pageNum;
    container.style.width = `${viewport.width}px`;
    container.style.height = `${viewport.height}px`;

    // ── Canvas ────────────────────────────────────────
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    // ── Highlight layer ───────────────────────────────
    const hlLayer = document.createElement("div");
    hlLayer.className = "highlight-layer";

    // ── Text layer (PDF.js) ───────────────────────────
    const textLayerDiv = document.createElement("div");
    textLayerDiv.className = "textLayer";
    textLayerDiv.style.width = `${viewport.width}px`;
    textLayerDiv.style.height = `${viewport.height}px`;

    // ── Page number chip ──────────────────────────────
    const chip = document.createElement("div");
    chip.className = "page-chip";
    chip.textContent = pageNum;

    // ── Assemble ──────────────────────────────────────
    container.appendChild(canvas);
    container.appendChild(hlLayer);
    container.appendChild(textLayerDiv);
    container.appendChild(chip);

    els["pdf-canvas-area"].appendChild(container);

    // ── Render PDF page to canvas ─────────────────────
    const renderCtx = { canvasContext: ctx, viewport };
    const renderTask = page.render(renderCtx);

    // ── Render text layer in parallel ─────────────────
    const textContent = await page.getTextContent();
    await renderTask.promise;

    window.pdfjsLib.renderTextLayer({
        textContent,
        container: textLayerDiv,
        viewport,
        textDivs: []
    });

    // Scroll observer to update current-page indicator
    observePage(container, pageNum);
}

/** Render a small thumbnail for the sidebar. */
async function renderThumb(pageNum) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 0.2 });

    const wrapper = document.createElement("div");
    wrapper.className = "thumb-item";
    wrapper.dataset.page = pageNum;
    wrapper.onclick = () => scrollToPage(pageNum);

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

async function applyZoom(newScale) {
    if (isRendering) return;

    newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
    if (newScale === currentScale) return;

    const prevPage = currentPage;
    currentScale = newScale;
    isRendering = true;

    updateZoomLabel();
    setStatus("Zooming…");

    await renderAllPages();

    // Re-draw highlights at new scale
    if (highlighter) {
        Object.keys(highlighter.highlightMap).forEach(pg => {
            highlighter.renderPageHighlights(Number(pg));
        });
    }

    scrollToPage(prevPage, false);
    isRendering = false;
    setStatus(`${totalPages} pages`);

    // Persist scale
    debouncedSaveMeta();
}

function updateZoomLabel() {
    els["zoom-level"].textContent = `${Math.round(currentScale * 100)}%`;
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  PAGE NAVIGATION                                          ║
// ╚═══════════════════════════════════════════════════════════╝

function scrollToPage(pageNum, smooth = true) {
    const container = document.querySelector(
        `.page-container[data-page="${pageNum}"]`
    );
    if (!container) return;

    container.scrollIntoView({
        behavior: smooth ? "smooth" : "instant",
        block: "start"
    });

    setCurrentPage(pageNum);
}

function setCurrentPage(pageNum) {
    currentPage = Math.min(Math.max(1, pageNum), totalPages);
    els["page-input"].value = currentPage;

    // Update thumbnail active state
    document.querySelectorAll(".thumb-item").forEach(el => {
        el.classList.toggle("active", Number(el.dataset.page) === currentPage);
    });

    updateBookmarkBtn();
    debouncedSaveMeta();
}

// ── Intersection Observer to auto-update current page ────────
function observePage(container, pageNum) {
    const observer = new IntersectionObserver(
        (entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && entry.intersectionRatio > 0.4) {
                    setCurrentPage(pageNum);
                }
            });
        },
        {
            root: els["pdf-canvas-area"],
            threshold: 0.4
        }
    );
    observer.observe(container);
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  BOOKMARKS                                                ║
// ╚═══════════════════════════════════════════════════════════╝

async function toggleBookmark() {
    const pg = currentPage;
    const isNow = !bookmarkedPages.has(pg);

    if (isNow) bookmarkedPages.add(pg);
    else bookmarkedPages.delete(pg);

    updateBookmarkBtn();

    try {
        await setBookmark(user.uid, pdfName, pg, isNow);
        showToast(isNow ? `Bookmarked page ${pg}` : `Bookmark removed`, "info");
    } catch (err) {
        console.error("[Bookmark] Save failed:", err);
    }
}

function updateBookmarkBtn() {
    const btn = els["btn-bookmark"];
    if (!btn) return;
    btn.classList.toggle("bookmarked", bookmarkedPages.has(currentPage));
    btn.title = bookmarkedPages.has(currentPage)
        ? "Remove bookmark"
        : "Bookmark this page";
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  TOOLBAR WIRING                                           ║
// ╚═══════════════════════════════════════════════════════════╝

function wireToolbar() {
    // Back
    els["back-btn"].addEventListener("click", () => {
        window.location.href = "dashboard.html";
    });

    // Zoom
    els["btn-zoom-in"].addEventListener("click", () => applyZoom(currentScale + SCALE_STEP));
    els["btn-zoom-out"].addEventListener("click", () => applyZoom(currentScale - SCALE_STEP));

    // Mouse-wheel zoom (Ctrl/Cmd + wheel)
    els["pdf-canvas-area"].addEventListener("wheel", (e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            applyZoom(currentScale + (e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP));
        }
    }, { passive: false });

    // Page navigation
    els["btn-prev"].addEventListener("click", () => scrollToPage(currentPage - 1));
    els["btn-next"].addEventListener("click", () => scrollToPage(currentPage + 1));

    els["page-input"].addEventListener("change", () => {
        const val = parseInt(els["page-input"].value);
        if (val >= 1 && val <= totalPages) scrollToPage(val);
        else els["page-input"].value = currentPage;
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", handleKeydown);

    // Highlight mode
    els["btn-highlight"].addEventListener("click", () => {
        const newMode = highlighter.mode === "highlight" ? "none" : "highlight";
        setMode(newMode);
    });

    // Erase mode
    els["btn-erase"].addEventListener("click", () => {
        const newMode = highlighter.mode === "erase" ? "none" : "erase";
        setMode(newMode);
    });

    // Colour buttons
    els.colorBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            els.colorBtns.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            highlighter.setColor(btn.dataset.color);
            // Auto-switch to highlight mode when picking a colour
            if (highlighter.mode !== "highlight") setMode("highlight");
        });
    });

    // Default active colour
    document.querySelector('[data-color="yellow"]')?.classList.add("active");

    // Bookmark
    els["btn-bookmark"]?.addEventListener("click", toggleBookmark);

    // Search panel toggle
    els["btn-search"]?.addEventListener("click", toggleSearchPanel);
    els["btn-search-next"]?.addEventListener("click", () => doSearch("next"));
    els["btn-search-prev"]?.addEventListener("click", () => doSearch("prev"));
    els["search-input"]?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doSearch("next");
    });

    // Theme
    els["btn-theme"].addEventListener("click", toggleTheme);

    // Logout
    els["btn-logout"].addEventListener("click", async () => {
        await logoutUser();
        window.location.replace("login.html");
    });
}

// ── Mode switching ────────────────────────────────────────────
function setMode(mode) {
    highlighter.setMode(mode);

    // Update button active states
    els["btn-highlight"].classList.toggle("active", mode === "highlight");
    els["btn-erase"].classList.toggle("active", mode === "erase");

    // Banner
    const banner = els["mode-banner"];
    banner.classList.remove("highlight-mode", "erase-mode");

    if (mode === "highlight") {
        banner.className = "mode-banner highlight-mode";
        banner.textContent = "✏️  Highlight Mode — select text to highlight";
        banner.classList.remove("hidden");
    } else if (mode === "erase") {
        banner.className = "mode-banner erase-mode";
        banner.textContent = "🗑️  Erase Mode — click a highlight to remove it";
        banner.classList.remove("hidden");
    } else {
        banner.classList.add("hidden");
    }
}

// ── Keyboard shortcuts ────────────────────────────────────────
function handleKeydown(e) {
    // Don't intercept when typing in an input
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

    switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
            scrollToPage(currentPage + 1); break;

        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
            scrollToPage(currentPage - 1); break;

        case "Home":
            scrollToPage(1); break;

        case "End":
            scrollToPage(totalPages); break;

        case "+":
        case "=":
            if (e.ctrlKey || e.metaKey) { e.preventDefault(); applyZoom(currentScale + SCALE_STEP); } break;

        case "-":
            if (e.ctrlKey || e.metaKey) { e.preventDefault(); applyZoom(currentScale - SCALE_STEP); } break;

        case "h": case "H":
            setMode(highlighter.mode === "highlight" ? "none" : "highlight"); break;

        case "e": case "E":
            setMode(highlighter.mode === "erase" ? "none" : "erase"); break;

        case "Escape":
            setMode("none"); break;

        case "b": case "B":
            toggleBookmark(); break;

        case "f": case "F":
            if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleSearchPanel(); } break;
    }
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

    // Collect matches across all pages
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

    if (direction === "next") {
        searchIndex = (searchIndex + 1) % searchMatches.length;
    } else {
        searchIndex = (searchIndex - 1 + searchMatches.length) % searchMatches.length;
    }

    const targetPage = searchMatches[searchIndex];
    scrollToPage(targetPage);
    els["search-status"].textContent =
        `${searchIndex + 1} / ${searchMatches.length} pages`;
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
    if (isSaving) {
        dot.classList.add("saving");
        setStatus("Saving…");
    } else {
        dot.classList.remove("saving");
        setStatus(`${totalPages} pages`);
    }
}

/** @param {string} msg @param {"success"|"error"|"info"} type */
function showToast(msg, type = "info") {
    const container = els["toast-container"];
    if (!container) return;

    const icons = {
        success: "✓",
        error: "✕",
        info: "ℹ"
    };

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${icons[type]}</span>${msg}`;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transform = "translateX(20px)";
        toast.style.transition = "all 0.3s ease";
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  META PERSISTENCE (debounced)                             ║
// ╚═══════════════════════════════════════════════════════════╝

let metaTimer = null;

function debouncedSaveMeta() {
    clearTimeout(metaTimer);
    metaTimer = setTimeout(async () => {
        try {
            await saveLastPage(user.uid, pdfName, currentPage, currentScale);
        } catch (_) { /* silent */ }
    }, 1500);
}

// ╔═══════════════════════════════════════════════════════════╗
// ║  INIT                                                     ║
// ╚═══════════════════════════════════════════════════════════╝

boot().catch(err => {
    console.error("[Viewer] Boot error:", err);
});