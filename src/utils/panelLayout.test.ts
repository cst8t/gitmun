import { describe, expect, it } from "vitest";
import {
    DEFAULT_LEFT_PANEL_WIDTH,
    DEFAULT_RIGHT_PANEL_WIDTH,
    LEGACY_DEFAULT_RIGHT_PANEL_WIDTH,
    MIN_LEFT_PANEL_WIDTH,
    clampPanelLayout,
    panelRatiosFromLayout,
    resizePanelLayout,
    resolvePanelLayout,
} from "./panelLayout";

describe("panel layout", () => {
    it("uses a diff-heavy default on wide windows", () => {
        const { layout } = resolvePanelLayout(2000, { left: null, right: null }, {
            left: DEFAULT_LEFT_PANEL_WIDTH,
            right: DEFAULT_RIGHT_PANEL_WIDTH,
        });

        expect(layout).toEqual({ left: 260, right: 1080 });
    });

    it("grows the diff panel when a constrained default window expands", () => {
        const small = resolvePanelLayout(1182, { left: null, right: null }, {
            left: DEFAULT_LEFT_PANEL_WIDTH,
            right: DEFAULT_RIGHT_PANEL_WIDTH,
        });

        const wide = resizePanelLayout(2000, small.ratios, small.layout);

        expect(small.layout.left).toBe(MIN_LEFT_PANEL_WIDTH);
        expect(small.layout.right).toBe(490);
        expect(wide.layout.right).toBe(1080);
        expect(wide.layout.right).toBeGreaterThan(small.layout.right);
    });

    it("preserves manual splitter ratios across resize", () => {
        const ratios = panelRatiosFromLayout(1500, { left: 300, right: 600 });
        const { layout } = resizePanelLayout(2100, ratios, { left: 300, right: 600 });

        expect(layout).toEqual({ left: 420, right: 840 });
    });

    it("does not let temporary shrink clamping replace manual ratios", () => {
        const ratios = panelRatiosFromLayout(2000, { left: 300, right: 1000 });
        const narrow = resizePanelLayout(900, ratios, { left: 300, right: 1000 });
        const wide = resizePanelLayout(2000, narrow.ratios, narrow.layout);

        expect(narrow.layout.left).toBe(MIN_LEFT_PANEL_WIDTH);
        expect(wide.layout).toEqual({ left: 300, right: 1000 });
    });

    it("keeps manual left panel drags above the sidebar usable minimum", () => {
        const layout = clampPanelLayout(1400, 80, 480);

        expect(layout.left).toBe(MIN_LEFT_PANEL_WIDTH);
    });

    it("corrects a persisted left panel that is too narrow", () => {
        const { layout } = resolvePanelLayout(1400, { left: 0.08, right: 0.34 }, {
            left: 112,
            right: 476,
        });

        expect(layout.left).toBe(MIN_LEFT_PANEL_WIDTH);
    });

    it("keeps the centre panel usable when the window shrinks", () => {
        const ratios = panelRatiosFromLayout(2000, { left: 260, right: 1080 });
        const { layout } = resizePanelLayout(900, ratios, { left: 260, right: 1080 });

        expect(layout.left + layout.right).toBeLessThanOrEqual(468);
        expect(layout.left).toBe(MIN_LEFT_PANEL_WIDTH);
        expect(layout.right).toBeGreaterThanOrEqual(120);
    });

    it("treats the legacy right panel default as default layout", () => {
        const { layout } = resolvePanelLayout(2000, { left: null, right: null }, {
            left: DEFAULT_LEFT_PANEL_WIDTH,
            right: LEGACY_DEFAULT_RIGHT_PANEL_WIDTH,
        });

        expect(layout).toEqual({ left: 260, right: 1080 });
    });
});
