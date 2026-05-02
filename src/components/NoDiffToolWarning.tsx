import React from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("diffPanel");
  const [dontShowAgain, setDontShowAgain] = React.useState(false);
  const tools = recommendedTools(platform);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onDismiss]);

  const toolList = tools.map((tool, i) => (
    <React.Fragment key={tool}>
      {i > 0 && (i === tools.length - 1 ? t("warning.or") : t("warning.separator"))}
      <strong>{tool}</strong>
    </React.Fragment>
  ));

  return (
    <>
      <div className="no-diff-tool-backdrop" onClick={() => onDismiss(false)} />
      <div className="no-diff-tool-dialog" role="dialog" aria-modal="true">
        <div className="no-diff-tool-dialog__title">{t("warning.title")}</div>
        <div className="no-diff-tool-dialog__body">
          {t("warning.bodyPrefix")}{toolList}{t("warning.bodySuffix")}
        </div>
        <label className="no-diff-tool-dialog__suppress">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={e => setDontShowAgain(e.target.checked)}
          />
          {t("warning.dontShowAgain")}
        </label>
        <div className="no-diff-tool-dialog__actions">
          <button
            className="no-diff-tool-dialog__btn no-diff-tool-dialog__btn--secondary"
            onClick={() => { onDismiss(dontShowAgain); onOpenSettings(); }}
          >
            {t("warning.openSettings")}
          </button>
          <button
            className="no-diff-tool-dialog__btn no-diff-tool-dialog__btn--primary"
            onClick={() => onDismiss(dontShowAgain)}
          >
            {t("warning.gotIt")}
          </button>
        </div>
      </div>
    </>
  );
}
