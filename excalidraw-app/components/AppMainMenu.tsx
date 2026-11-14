import { MainMenu } from "@excalidraw/excalidraw/index";
import { LoadIcon } from "@excalidraw/excalidraw/components/icons";
import React from "react";

import type { Theme } from "@excalidraw/element/types";

export const AppMainMenu: React.FC<{
  theme: Theme | "system";
  onOpenDrawings: () => void;
}> = React.memo((props) => (
  <MainMenu>
    <MainMenu.Item
      icon={LoadIcon}
      shortcut="Ctrl+P"
      onSelect={props.onOpenDrawings}
    >
      Drawings
    </MainMenu.Item>
    <MainMenu.Item icon={LoadIcon} onSelect={() => window.location.assign("/")}>
      All boards
    </MainMenu.Item>
    <MainMenu.Separator />
    <MainMenu.DefaultItems.LoadScene />
    <MainMenu.DefaultItems.SaveToActiveFile />
    <MainMenu.DefaultItems.Export />
    <MainMenu.DefaultItems.SaveAsImage />
    <MainMenu.DefaultItems.CommandPalette />
    <MainMenu.DefaultItems.SearchMenu />
    <MainMenu.DefaultItems.Help />
    <MainMenu.DefaultItems.ClearCanvas />
    <MainMenu.Separator />
    <MainMenu.DefaultItems.Preferences />
    <MainMenu.DefaultItems.ToggleTheme allowSystemTheme theme={props.theme} />
    <MainMenu.DefaultItems.ChangeCanvasBackground />
    <MainMenu.Separator />
    <MainMenu.Item
      icon={LoadIcon}
      onSelect={() => window.location.assign("/logout")}
    >
      Log out
    </MainMenu.Item>
  </MainMenu>
));
