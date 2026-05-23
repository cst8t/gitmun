import { describe, expect, it } from "vitest";
import {
    DEFAULT_LEFT_PANE_WIDTH,
    DEFAULT_RIGHT_PANE_WIDTH,
    LEGACY_DEFAULT_RIGHT_PANE_WIDTH,
    paneRatiosFromLayout,
    resizePaneLayout,
    resolvePaneLayout,
} from "./paneLayout";

describe("pane layout", () => {
    it("uses a diff-heavy default on wide windows", () => {
        const { layout } = resolvePaneLayout(2000, { left: null, right: null }, {
            left: DEFAULT_LEFT_PANE_WIDTH,
            right: DEFAULT_RIGHT_PANE_WIDTH,
        });

        expect(layout).toEqual({ left: 260, right: 1080 });
    });

    it("grows the diff panel when a constrained default window expands", () => {
        const small = resolvePaneLayout(1182, { left: null, right: null }, {
            left: DEFAULT_LEFT_PANE_WIDTH,
            right: DEFAULT_RIGHT_PANE_WIDTH,
        });

        const wide = resizePaneLayout(2000, small.ratios, small.layout);

        expect(small.layout.right).toBe(530);
        expect(wide.layout.right).toBe(1080);
        expect(wide.layout.right).toBeGreaterThan(small.layout.right);
    });

    it("preserves manual splitter ratios across resize", () => {
        const ratios = paneRatiosFromLayout(1500, { left: 300, right: 600 });
        const { layout } = resizePaneLayout(2100, ratios, { left: 300, right: 600 });

        expect(layout).toEqual({ left: 420, right: 840 });
    });

    it("does not let temporary shrink clamping replace manual ratios", () => {
        const ratios = paneRatiosFromLayout(2000, { left: 300, right: 1000 });
        const narrow = resizePaneLayout(900, ratios, { left: 300, right: 1000 });
        const wide = resizePaneLayout(2000, narrow.ratios, narrow.layout);

        expect(wide.layout).toEqual({ left: 300, right: 1000 });
    });

    it("keeps the centre panel usable when the window shrinks", () => {
        const ratios = paneRatiosFromLayout(2000, { left: 260, right: 1080 });
        const { layout } = resizePaneLayout(900, ratios, { left: 260, right: 1080 });

        expect(layout.left + layout.right).toBeLessThanOrEqual(468);
        expect(layout.right).toBeGreaterThanOrEqual(120);
    });

    it("treats the legacy right pane default as default layout", () => {
        const { layout } = resolvePaneLayout(2000, { left: null, right: null }, {
            left: DEFAULT_LEFT_PANE_WIDTH,
            right: LEGACY_DEFAULT_RIGHT_PANE_WIDTH,
        });

        expect(layout).toEqual({ left: 260, right: 1080 });
    });
});
