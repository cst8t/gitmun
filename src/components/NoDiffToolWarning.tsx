import React from "react";
import type { PlatformType } from "../hooks/usePlatform";
import "./NoDiffToolWarning.css";

type Props = {
  platform: PlatformType;
  onDismiss: (dontShowAgain: boolean) => void;
  onOpenSettings: () => void;
};

function recommendedTools(platform: PlatformType): string[] {
  switch (platform) {
    case "gnome":
    case "kde":    return ["Meld", "VS Code", "Kompare"];
    case "windows": return ["Meld", "VS Code", "WinMerge"];
    default:        return ["Meld", "VS Code"]; // macOS
  }
}

export function NoDiffToolWarning({ platform, onDismiss, onOpenSettings }: Props) {
  const [dontShowAgain, setDontShowAgain] = React.useState(false);
  const tools = recommendedTools(platform);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onDismiss]);

  const toolList = tools.map((t, i) => (
    <React.Fragment key={t}>
      {i > 0 && (i === tools.length - 1 ? ", or " : ", ")}
      <strong>{t}</strong>
    </React.Fragment>
  ));

  return (
    <>
      <div className="no-diff-tool-backdrop" onClick={() => onDismiss(false)} />
      <div className="no-diff-tool-dialog" role="dialog" aria-modal="true">
        <div className="no-diff-tool-dialog__title">No diff tool configured</div>
        <div className="no-diff-tool-dialog__body">
          Gitmun doesn't yet include a built-in merge editor. For the best experience -
          particularly when resolving merge conflicts - we recommend configuring an external
          diff tool such as {toolList}. Without one, conflicted files will need to be edited manually.
        </div>
        <label className="no-diff-tool-dialog__suppress">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={e => setDontShowAgain(e.target.checked)}
          />
          Don't show this again
        </label>
        <div className="no-diff-tool-dialog__actions">
          <button
            className="no-diff-tool-dialog__btn no-diff-tool-dialog__btn--secondary"
            onClick={() => { onDismiss(dontShowAgain); onOpenSettings(); }}
          >
            Open Settings
          </button>
          <button
            className="no-diff-tool-dialog__btn no-diff-tool-dialog__btn--primary"
            onClick={() => onDismiss(dontShowAgain)}
          >
            Got it
          </button>
        </div>
      </div>
    </>
  );
}
