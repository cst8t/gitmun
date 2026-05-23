export const DEFAULT_LEFT_PANE_WIDTH = 300;
export const DEFAULT_RIGHT_PANE_WIDTH = 480;
export const LEGACY_DEFAULT_RIGHT_PANE_WIDTH = 420;
export const DEFAULT_LEFT_PANE_RATIO = 0.13;
export const DEFAULT_RIGHT_PANE_RATIO = 0.54;
export const MIN_LEFT_PANE_WIDTH = 220;
export const MIN_RIGHT_PANE_WIDTH = 360;
export const MIN_CENTRE_PANE_WIDTH = 420;
export const LEFT_PANE_RATIO_KEY = "gitmun.leftPaneRatio";
export const RIGHT_PANE_RATIO_KEY = "gitmun.rightPaneRatio";
export const SPLITTER_WIDTH = 6;
export const LEFT_PANE_TOGGLE_WIDTH = 22;
export const SPLITTER_SPACE = 12;

export type PaneLayout = {
    left: number;
    right: number;
};

export type PaneRatios = {
    left: number | null;
    right: number | null;
};

export function isValidPaneWidth(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

export function parsePaneRatio(value: string | null): number | null {
    if (!value) return null;
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return null;
    if (parsed <= 0 || parsed >= 1) return null;
    return parsed;
}

export function areDefaultPaneWidths(left: number, right: number): boolean {
    return left === DEFAULT_LEFT_PANE_WIDTH
        && (right === DEFAULT_RIGHT_PANE_WIDTH || right === LEGACY_DEFAULT_RIGHT_PANE_WIDTH);
}

export function clampPaneLayout(totalWidth: number, desiredLeft: number, desiredRight: number): PaneLayout {
    if (!Number.isFinite(totalWidth) || totalWidth <= 0) {
        return {left: DEFAULT_LEFT_PANE_WIDTH, right: DEFAULT_RIGHT_PANE_WIDTH};
    }

    const defaultLeft = Math.round(totalWidth * DEFAULT_LEFT_PANE_RATIO);
    const defaultRight = Math.round(totalWidth * DEFAULT_RIGHT_PANE_RATIO);
    let left = isValidPaneWidth(desiredLeft) ? desiredLeft : defaultLeft;
    let right = isValidPaneWidth(desiredRight) ? desiredRight : defaultRight;

    const targetSides = Math.max(0, totalWidth - MIN_CENTRE_PANE_WIDTH - SPLITTER_SPACE);
    if (targetSides <= 0) {
        const half = Math.max(0, Math.floor((totalWidth - SPLITTER_SPACE) / 2));
        return {left: half, right: Math.max(0, totalWidth - SPLITTER_SPACE - half)};
    }

    const preferredMinLeft = Math.min(MIN_LEFT_PANE_WIDTH, targetSides);
    const preferredMinRight = Math.min(MIN_RIGHT_PANE_WIDTH, targetSides);

    left = Math.max(left, preferredMinLeft);
    right = Math.max(right, preferredMinRight);

    const sidesTotal = left + right;
    if (sidesTotal > targetSides) {
        let deficit = sidesTotal - targetSides;
        const rightShrink = Math.min(deficit, Math.max(0, right - preferredMinRight));
        right -= rightShrink;
        deficit -= rightShrink;

        const leftShrink = Math.min(deficit, Math.max(0, left - preferredMinLeft));
        left -= leftShrink;
        deficit -= leftShrink;

        if (deficit > 0) {
            const currentTotal = left + right;
            if (currentTotal > 0) {
                const scale = Math.max(0, (currentTotal - deficit) / currentTotal);
                left = Math.max(0, Math.floor(left * scale));
                right = Math.max(0, targetSides - left);
            }
        }
    }

    const rightMinVisible = Math.min(120, targetSides);
    const leftMax = Math.max(0, targetSides - rightMinVisible);
    left = Math.min(Math.max(0, left), leftMax);
    right = Math.min(Math.max(0, right), Math.max(0, targetSides - left));
    left = Math.min(Math.max(0, left), Math.max(0, targetSides - right));

    return {left: Math.round(left), right: Math.round(right)};
}

export function paneRatiosFromLayout(totalWidth: number, layout: PaneLayout): PaneRatios {
    if (!Number.isFinite(totalWidth) || totalWidth <= 0) {
        return {left: null, right: null};
    }

    const leftRatio = layout.left / totalWidth;
    const rightRatio = layout.right / totalWidth;
    return {
        left: leftRatio > 0 && leftRatio < 1 ? leftRatio : null,
        right: rightRatio > 0 && rightRatio < 1 ? rightRatio : null,
    };
}

export function resolvePaneLayout(
    totalWidth: number,
    ratios: PaneRatios,
    settingsLayout: PaneLayout,
): { layout: PaneLayout; ratios: PaneRatios } {
    const desiredLeft = isValidPaneWidth(settingsLayout.left)
        ? settingsLayout.left
        : DEFAULT_LEFT_PANE_WIDTH;
    const desiredRight = isValidPaneWidth(settingsLayout.right)
        ? settingsLayout.right
        : DEFAULT_RIGHT_PANE_WIDTH;
    const useDefaultRatios = ratios.left == null
        && ratios.right == null
        && areDefaultPaneWidths(desiredLeft, desiredRight);

    const left = totalWidth > 0 && ratios.left != null
        ? totalWidth * ratios.left
        : totalWidth > 0 && useDefaultRatios
            ? totalWidth * DEFAULT_LEFT_PANE_RATIO
            : desiredLeft;
    const right = totalWidth > 0 && ratios.right != null
        ? totalWidth * ratios.right
        : totalWidth > 0 && useDefaultRatios
            ? totalWidth * DEFAULT_RIGHT_PANE_RATIO
            : desiredRight;

    const layout = totalWidth > 0
        ? clampPaneLayout(totalWidth, left, right)
        : {left: desiredLeft, right: desiredRight};
    const nextRatios = totalWidth > 0
        ? {
            left: ratios.left ?? (useDefaultRatios ? DEFAULT_LEFT_PANE_RATIO : paneRatiosFromLayout(totalWidth, layout).left),
            right: ratios.right ?? (useDefaultRatios ? DEFAULT_RIGHT_PANE_RATIO : paneRatiosFromLayout(totalWidth, layout).right),
        }
        : ratios;

    return {layout, ratios: nextRatios};
}

export function resizePaneLayout(
    totalWidth: number,
    ratios: PaneRatios,
    fallbackLayout: PaneLayout,
): { layout: PaneLayout; ratios: PaneRatios } {
    const left = totalWidth > 0 && ratios.left != null
        ? totalWidth * ratios.left
        : fallbackLayout.left;
    const right = totalWidth > 0 && ratios.right != null
        ? totalWidth * ratios.right
        : fallbackLayout.right;
    const layout = clampPaneLayout(totalWidth, left, right);
    const fallbackRatios = paneRatiosFromLayout(totalWidth, layout);
    const nextRatios = {
        left: ratios.left ?? fallbackRatios.left,
        right: ratios.right ?? fallbackRatios.right,
    };
    return {layout, ratios: nextRatios};
}
