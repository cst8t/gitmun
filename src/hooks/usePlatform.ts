import { useState, useEffect } from "react";
import { platform } from "@tauri-apps/plugin-os";
import { detectDesktopEnvironment } from "../api/commands";

export type PlatformType = "macos" | "gnome" | "kde" | "windows";

export function usePlatform(): PlatformType {
  const [plat, setPlat] = useState<PlatformType>("gnome");

  useEffect(() => {
    async function detect() {
      try {
        const os = platform();
        if (os === "macos") {
          setPlat("macos");
        } else if (os === "windows") {
          setPlat("windows");
        } else {
          // Linux - detect DE
          const de = await detectDesktopEnvironment();
          if (de.includes("kde") || de.includes("plasma")) {
            setPlat("kde");
          } else {
            setPlat("gnome"); // default for GNOME, XFCE, Sway, etc.
          }
        }
      } catch {
        setPlat("gnome");
      }
    }
    detect();
  }, []);

  return plat;
}
