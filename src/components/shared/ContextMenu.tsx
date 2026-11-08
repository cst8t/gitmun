import React from "react";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";

export type ContextMenuItem =
  | {
    label: string;
    onClick: () => void;
    danger?: boolean;
  }
  | {
    type: "separator";
  };

function isSeparator(item: ContextMenuItem): item is { type: "separator" } {
  return "type" in item && item.type === "separator";
}

type ContextMenuProps = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
};

// Fires native popup on mount at the given position, calls onClose when dismissed.
// x/y should be e.clientX / e.clientY from the triggering mouse event.
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  React.useEffect(() => {
    let cancelled = false;

    async function show() {
      const menuItems: (MenuItem | PredefinedMenuItem)[] = [];
      let menu: Menu | undefined;

      try {
        for (const item of items) {
          const menuItem = isSeparator(item)
            ? await PredefinedMenuItem.new({ item: "Separator" })
            : await MenuItem.new({ text: item.label, action: item.onClick });
          menuItems.push(menuItem);
          if (cancelled) return;
        }
        menu = await Menu.new({ items: menuItems });
        if (cancelled) return;

        await menu.popup(new LogicalPosition(x, y));
      } finally {
        // Keep the action channels alive until the native popup has finished.
        const releases = await Promise.allSettled([
          ...(menu ? [menu.close()] : []),
          ...menuItems.map(item => item.close()),
        ]);
        for (const release of releases) {
          if (release.status === "rejected") {
            console.error("Failed to release native context menu resource", release.reason);
          }
        }
        if (!cancelled) onClose();
      }
    }

    void show().catch(error => console.error("Failed to show native context menu", error));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
