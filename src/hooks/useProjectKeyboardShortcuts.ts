import {useEffect} from "react";
import type {RefObject} from "react";
import type {PlatformType} from "./usePlatform";

type UseProjectKeyboardShortcutsOptions = {
  platform: PlatformType;
  selectedFile: string | null;
  isUnstaged: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onShowLog: () => void;
  onStageFile: (path: string) => void;
  onUnstageFile: (path: string) => void;
  onStageAll: () => void;
  onPush: () => void;
  onFetch: () => void;
  onPull: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
};

export function useProjectKeyboardShortcuts({
  platform,
  selectedFile,
  isUnstaged,
  searchInputRef,
  onShowLog,
  onStageFile,
  onUnstageFile,
  onStageAll,
  onPush,
  onFetch,
  onPull,
  onOpenSettings,
  onRefresh,
}: UseProjectKeyboardShortcutsOptions): void {
  useEffect(() => {
    const isMac = platform === "macos";
    const handler = (event: KeyboardEvent) => {
      const mod = isMac ? event.metaKey : event.ctrlKey;
      const target = event.target as HTMLElement;
      const inInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";

      if (mod && event.key === "Enter") { event.preventDefault(); return; }
      if (mod && event.shiftKey && event.key.toLowerCase() === "a") { event.preventDefault(); onStageAll(); return; }
      if (mod && event.shiftKey && event.key.toLowerCase() === "p") { event.preventDefault(); onPush(); return; }
      if (mod && event.key === ",") { event.preventDefault(); onOpenSettings(); return; }
      if (mod && !event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        onShowLog();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); onFetch(); return; }
      if (mod && event.shiftKey && event.key.toLowerCase() === "l") { event.preventDefault(); onPull(); return; }
      if (inInput) return;
      if (event.key === "s" && selectedFile && isUnstaged) { event.preventDefault(); onStageFile(selectedFile); return; }
      if (event.key === "u" && selectedFile && !isUnstaged) { event.preventDefault(); onUnstageFile(selectedFile); return; }
      if (event.key === "r") { event.preventDefault(); onRefresh(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    platform,
    selectedFile,
    isUnstaged,
    searchInputRef,
    onShowLog,
    onStageFile,
    onUnstageFile,
    onStageAll,
    onPush,
    onFetch,
    onPull,
    onOpenSettings,
    onRefresh,
  ]);
}
