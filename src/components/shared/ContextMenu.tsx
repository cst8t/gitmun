import React from "react";
import { Menu, MenuItem } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";

export type ContextMenuItem = {
  label: string;
  onClick: () => void;
  danger?: boolean;
};

type ContextMenuProps = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
};

// Fires native popup on mount at the given position, calls onClose when dismissed.
// x/y should be e.screenX / e.screenY from the triggering mouse event.
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  React.useEffect(() => {
    async function show() {
      const menuItems = await Promise.all(
        items.map((item) =>
          MenuItem.new({
            text: item.label,
            action: item.onClick,
          })
        )
      );
      const menu = await Menu.new({ items: menuItems });
      await menu.popup(new LogicalPosition(x, y));
    }

    show().finally(onClose);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
