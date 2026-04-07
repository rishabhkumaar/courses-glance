/**
 * js/highlight.js
 * HighlightManager — handles all text-highlighting logic:
 *   • Captures text selections in PDF.js text layers
 *   • Draws coloured overlay rects on the highlight layer
 *   • Persists highlights to / loads from Firestore
 *   • Manages erase mode (click-to-delete)
 */

import {
    saveHighlight,
    loadHighlights,
    deleteHighlight
} from "./firebase.js";

/* ─── Colour palette ────────────────────────────────────────── */
export const HIGHLIGHT_COLORS = {
    yellow: "rgba(255,220,0,0.50)",
    green: "rgba(72,210,140,0.50)",
    blue: "rgba(90,170,255,0.50)",
    pink: "rgba(255,120,170,0.50)",
    orange: "rgba(255,160,60,0.50)"
};

const DEFAULT_COLOR = "yellow";

/* ─── HighlightManager class ─────────────────────────────────── */
export class HighlightManager {
    /**
     * @param {object} opts
     * @param {string}   opts.userId    Firebase auth uid
     * @param {string}   opts.pdfName   e.g. "CHE110"
     * @param {Function} opts.onSaving  called with (true/false) during save
     * @param {Function} opts.onToast   called with (msg, type) for notifications
     */
    constructor({ userId, pdfName, onSaving, onToast }) {
        this.userId = userId;
        this.pdfName = pdfName;
        this.onSaving = onSaving || (() => { });
        this.onToast = onToast || (() => { });

        // mode: "none" | "highlight" | "erase"
        this.mode = "none";
        this.activeColor = DEFAULT_COLOR;

        // Map of pageNum → [ highlightData, ... ]
        // highlightData: { id, page, rects, color, selectedText, domRects }
        this.highlightMap = {};

        // Track mouse state for selection
        this._boundMouseup = this._onMouseUp.bind(this);
        document.addEventListener("mouseup", this._boundMouseup);
    }

    /* ── Public API ─────────────────────────────────────────────── */

    /** Switch active colour. */
    setColor(colorName) {
        this.activeColor = colorName;
    }

    /** Switch interaction mode. */
    setMode(mode) {
        this.mode = mode;
        this._updateLayerInteraction();
    }

    /** Destroy listener (call when viewer is torn down). */
    destroy() {
        document.removeEventListener("mouseup", this._boundMouseup);
    }

    /**
     * Load all highlights from Firestore and render them.
     * Must be called after all pages are rendered.
     */
    async loadAll() {
        try {
            const all = await loadHighlights(this.userId, this.pdfName);
            all.forEach(h => {
                if (!this.highlightMap[h.page]) this.highlightMap[h.page] = [];
                this.highlightMap[h.page].push(h);
            });
            // Render highlights for all already-rendered pages
            Object.keys(this.highlightMap).forEach(pg => {
                this.renderPageHighlights(Number(pg));
            });
        } catch (err) {
            console.error("[Highlights] Failed to load:", err);
            this.onToast("Could not load highlights", "error");
        }
    }

    /**
     * Render highlights for a specific page.
     * Call this after (re-)rendering a page canvas.
     *
     * @param {number} pageNum  1-based
     */
    renderPageHighlights(pageNum) {
        const layer = this._getHighlightLayer(pageNum);
        if (!layer) return;

        // Clear existing DOM highlights for this page
        layer.querySelectorAll(".highlight-rect").forEach(el => el.remove());

        const list = this.highlightMap[pageNum] || [];
        list.forEach(h => this._drawHighlight(h, layer));
    }

    /**
     * Clear all highlights from the DOM (does not delete from Firestore).
     */
    clearDom() {
        document.querySelectorAll(".highlight-rect").forEach(el => el.remove());
    }

    /* ── Private: DOM helpers ───────────────────────────────────── */

    /** Find the .highlight-layer div for a given page number. */
    _getHighlightLayer(pageNum) {
        return document.querySelector(
            `.page-container[data-page="${pageNum}"] .highlight-layer`
        );
    }

    /** Find the .page-container div for a given page number. */
    _getPageContainer(pageNum) {
        return document.querySelector(`.page-container[data-page="${pageNum}"]`);
    }

    /**
     * Draw a single highlight onto a layer element.
     * Each rect is {x, y, w, h} as fractions of the page container.
     */
    _drawHighlight(highlight, layer) {
        const container = layer.closest(".page-container");
        const W = container.offsetWidth;
        const H = container.offsetHeight;

        highlight.rects.forEach((r, idx) => {
            const div = document.createElement("div");
            div.className = "highlight-rect";
            div.dataset.id = highlight.id;
            div.dataset.index = idx;

            // Convert fractional coords → pixels
            div.style.left = `${r.x * W}px`;
            div.style.top = `${r.y * H}px`;
            div.style.width = `${r.w * W}px`;
            div.style.height = `${r.h * H}px`;
            div.style.background = HIGHLIGHT_COLORS[highlight.color] || highlight.color;
            div.title = highlight.selectedText || "";

            // Erase on click (pointer-events handled by CSS class)
            div.addEventListener("click", () => this._eraseHighlight(highlight.id));

            layer.appendChild(div);
        });
    }

    /* ── Private: Mode interaction ──────────────────────────────── */

    _updateLayerInteraction() {
        document.querySelectorAll(".page-container").forEach(pc => {
            if (this.mode === "erase") {
                pc.classList.add("erase-mode");
            } else {
                pc.classList.remove("erase-mode");
            }
        });
    }

    /* ── Private: Mouse-up handler ──────────────────────────────── */

    _onMouseUp(e) {
        if (this.mode !== "highlight") return;

        // Small delay to ensure selection is finalised
        setTimeout(() => this._processSelection(e), 20);
    }

    _processSelection(e) {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

        const range = sel.getRangeAt(0);
        const selectedText = sel.toString().trim();
        if (!selectedText) return;

        // Find which page container the selection starts in
        const startContainer = range.startContainer;
        const pageContainer = startContainer.nodeType === Node.TEXT_NODE
            ? startContainer.parentElement.closest(".page-container")
            : startContainer.closest(".page-container");

        if (!pageContainer) return;

        const pageNum = Number(pageContainer.dataset.page);
        const pcRect = pageContainer.getBoundingClientRect();
        const W = pageContainer.offsetWidth;
        const H = pageContainer.offsetHeight;

        // Collect all client rects from the selection
        const clientRects = Array.from(range.getClientRects());
        if (clientRects.length === 0) return;

        // Convert to page-relative fractional coords
        const rects = clientRects
            .filter(r => r.width > 0 && r.height > 0)
            .map(r => ({
                x: Math.max(0, (r.left - pcRect.left) / W),
                y: Math.max(0, (r.top - pcRect.top) / H),
                w: Math.min(r.width / W, 1),
                h: Math.min(r.height / H, 1)
            }))
            .filter(r => r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0);

        if (rects.length === 0) return;

        // Clear browser selection
        sel.removeAllRanges();

        this._addHighlight({
            page: pageNum,
            rects,
            color: this.activeColor,
            selectedText
        });
    }

    /* ── Private: Add highlight ─────────────────────────────────── */

    async _addHighlight({ page, rects, color, selectedText }) {
        // Optimistic: add to local map with a temp id
        const tempId = `temp_${Date.now()}`;
        const highlight = { id: tempId, page, rects, color, selectedText };

        if (!this.highlightMap[page]) this.highlightMap[page] = [];
        this.highlightMap[page].push(highlight);

        // Render immediately
        const layer = this._getHighlightLayer(page);
        if (layer) this._drawHighlight(highlight, layer);

        // Persist to Firestore
        this.onSaving(true);
        try {
            const realId = await saveHighlight({
                userId: this.userId,
                pdfName: this.pdfName,
                page,
                rects,
                color,
                selectedText
            });

            // Update id in local map
            highlight.id = realId;

            // Update data-id on DOM elements
            document.querySelectorAll(`.highlight-rect[data-id="${tempId}"]`)
                .forEach(el => {
                    el.dataset.id = realId;
                    el.onclick = () => this._eraseHighlight(realId);
                });

            this.onToast("Highlight saved ✓", "success");
        } catch (err) {
            console.error("[Highlights] Save failed:", err);
            this.onToast("Failed to save highlight", "error");
            // Roll back
            this._eraseLocalHighlight(tempId, page);
        } finally {
            this.onSaving(false);
        }
    }

    /* ── Private: Erase highlight ───────────────────────────────── */

    async _eraseHighlight(id) {
        if (this.mode !== "erase") return;

        // Find page
        let foundPage = null;
        Object.entries(this.highlightMap).forEach(([pg, list]) => {
            if (list.some(h => h.id === id)) foundPage = Number(pg);
        });

        // Remove from DOM
        document.querySelectorAll(`.highlight-rect[data-id="${id}"]`)
            .forEach(el => el.remove());

        // Remove from local map
        if (foundPage !== null) {
            this.highlightMap[foundPage] = this.highlightMap[foundPage]
                .filter(h => h.id !== id);
        }

        // Skip Firestore delete for temp ids (save failed)
        if (id.startsWith("temp_")) return;

        this.onSaving(true);
        try {
            await deleteHighlight(id);
            this.onToast("Highlight removed", "info");
        } catch (err) {
            console.error("[Highlights] Delete failed:", err);
            this.onToast("Failed to delete highlight", "error");
        } finally {
            this.onSaving(false);
        }
    }

    _eraseLocalHighlight(id, page) {
        if (this.highlightMap[page]) {
            this.highlightMap[page] = this.highlightMap[page].filter(h => h.id !== id);
        }
        document.querySelectorAll(`.highlight-rect[data-id="${id}"]`)
            .forEach(el => el.remove());
    }
}