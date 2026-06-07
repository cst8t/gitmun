export const DEFAULT_LEFT_PANEL_WIDTH = 300;
export const DEFAULT_RIGHT_PANEL_WIDTH = 480;
export const LEGACY_DEFAULT_RIGHT_PANEL_WIDTH = 420;
export const DEFAULT_LEFT_PANEL_RATIO = 0.13;
export const DEFAULT_RIGHT_PANEL_RATIO = 0.54;
export const MIN_LEFT_PANEL_WIDTH = 260;
export const MIN_RIGHT_PANEL_WIDTH = 360;
export const MIN_CENTRE_PANEL_WIDTH = 420;
export const MIN_VISIBLE_RIGHT_PANEL_WIDTH = 120;
export const LEFT_PANEL_RATIO_KEY = "gitmun.leftPaneRatio";
export const RIGHT_PANEL_RATIO_KEY = "gitmun.rightPaneRatio";
export const SPLITTER_WIDTH = 6;
export const LEFT_PANEL_TOGGLE_WIDTH = 22;
export const SPLITTER_SPACE = 12;

export type PanelLayout = {
    left: number;
    right: number;
};

export type PanelRatios = {
    left: number | null;
    right: number | null;
};

export function isValidPanelWidth(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

export function parsePanelRatio(value: string | null): number | null {
    if (!value) return null;
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return null;
    if (parsed <= 0 || parsed >= 1) return null;
    return parsed;
}

export function areDefaultPanelWidths(left: number, right: number): boolean {
    return left === DEFAULT_LEFT_PANEL_WIDTH
        && (right === DEFAULT_RIGHT_PANEL_WIDTH || right === LEGACY_DEFAULT_RIGHT_PANEL_WIDTH);
}

export function clampPanelLayout(totalWidth: number, desiredLeft: number, desiredRight: number): PanelLayout {
    if (!Number.isFinite(totalWidth) || totalWidth <= 0) {
        return {left: DEFAULT_LEFT_PANEL_WIDTH, right: DEFAULT_RIGHT_PANEL_WIDTH};
    }

    const defaultLeft = Math.round(totalWidth * DEFAULT_LEFT_PANEL_RATIO);
    const defaultRight = Math.round(totalWidth * DEFAULT_RIGHT_PANEL_RATIO);
    let left = isValidPanelWidth(desiredLeft) ? desiredLeft : defaultLeft;
    let right = isValidPanelWidth(desiredRight) ? desiredRight : defaultRight;

    const targetSides = Math.max(0, totalWidth - MIN_CENTRE_PANEL_WIDTH - SPLITTER_SPACE);
    if (targetSides <= 0) {
        const half = Math.max(0, Math.floor((totalWidth - SPLITTER_SPACE) / 2));
        return {left: half, right: Math.max(0, totalWidth - SPLITTER_SPACE - half)};
    }

    const minVisibleRight = Math.min(MIN_VISIBLE_RIGHT_PANEL_WIDTH, targetSides);
    const minLeft = targetSides >= MIN_LEFT_PANEL_WIDTH + minVisibleRight
        ? MIN_LEFT_PANEL_WIDTH
        : Math.max(0, targetSides - minVisibleRight);
    const minRight = Math.min(minVisibleRight, Math.max(0, targetSides - minLeft));
    const preferredMinRight = Math.min(MIN_RIGHT_PANEL_WIDTH, Math.max(0, targetSides - minLeft));

    left = Math.max(left, minLeft);
    right = Math.max(right, preferredMinRight);

    const sidesTotal = left + right;
    if (sidesTotal > targetSides) {
        let deficit = sidesTotal - targetSides;
        const rightShrink = Math.min(deficit, Math.max(0, right - minRight));
        right -= rightShrink;
        deficit -= rightShrink;

        const leftShrink = Math.min(deficit, Math.max(0, left - minLeft));
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

    left = Math.min(Math.max(0, left), targetSides);
    right = Math.min(Math.max(0, right), Math.max(0, targetSides - left));

    return {left: Math.round(left), right: Math.round(right)};
}

export function panelRatiosFromLayout(totalWidth: number, layout: PanelLayout): PanelRatios {
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

export function resolvePanelLayout(
    totalWidth: number,
    ratios: PanelRatios,
    settingsLayout: PanelLayout,
): { layout: PanelLayout; ratios: PanelRatios } {
    const desiredLeft = isValidPanelWidth(settingsLayout.left)
        ? settingsLayout.left
        : DEFAULT_LEFT_PANEL_WIDTH;
    const desiredRight = isValidPanelWidth(settingsLayout.right)
        ? settingsLayout.right
        : DEFAULT_RIGHT_PANEL_WIDTH;
    const useDefaultRatios = ratios.left == null
        && ratios.right == null
        && areDefaultPanelWidths(desiredLeft, desiredRight);

    const left = totalWidth > 0 && ratios.left != null
        ? totalWidth * ratios.left
        : totalWidth > 0 && useDefaultRatios
            ? totalWidth * DEFAULT_LEFT_PANEL_RATIO
            : desiredLeft;
    const right = totalWidth > 0 && ratios.right != null
        ? totalWidth * ratios.right
        : totalWidth > 0 && useDefaultRatios
            ? totalWidth * DEFAULT_RIGHT_PANEL_RATIO
            : desiredRight;

    const layout = totalWidth > 0
        ? clampPanelLayout(totalWidth, left, right)
        : {left: desiredLeft, right: desiredRight};
    const nextRatios = totalWidth > 0
        ? {
            left: ratios.left ?? (useDefaultRatios ? DEFAULT_LEFT_PANEL_RATIO : panelRatiosFromLayout(totalWidth, layout).left),
            right: ratios.right ?? (useDefaultRatios ? DEFAULT_RIGHT_PANEL_RATIO : panelRatiosFromLayout(totalWidth, layout).right),
        }
        : ratios;

    return {layout, ratios: nextRatios};
}

export function resizePanelLayout(
    totalWidth: number,
    ratios: PanelRatios,
    fallbackLayout: PanelLayout,
): { layout: PanelLayout; ratios: PanelRatios } {
    const left = totalWidth > 0 && ratios.left != null
        ? totalWidth * ratios.left
        : fallbackLayout.left;
    const right = totalWidth > 0 && ratios.right != null
        ? totalWidth * ratios.right
        : fallbackLayout.right;
    const layout = clampPanelLayout(totalWidth, left, right);
    const fallbackRatios = panelRatiosFromLayout(totalWidth, layout);
    const nextRatios = {
        left: ratios.left ?? fallbackRatios.left,
        right: ratios.right ?? fallbackRatios.right,
    };
    return {layout, ratios: nextRatios};
}
