import app from "ags/gtk4/app"
import style from "./style.scss"
import Bar from "./widget/Bar"
import { createBinding, For, This } from "gnim"
import {
  StartMenuLayer,
  controlStartMenu,
  type StartMenuAction,
} from "./widget/StartMenu"
import {
  ClipboardMenuLayer,
  controlClipboardMenu,
  type ClipboardAction,
} from "./widget/ClipboardMenu"
import { ClockMenuLayer } from "./widget/ClockMenu"
import { WallpaperBackground, WallpaperLayer } from "./widget/Wallpaper"
import { DockWindow } from "./widget/Dock"
import { MonitorIdentifyLayer } from "./widget/MonitorIdentify"
import { StatusMenuLayer } from "./widget/StatusMenu"
import { NotifPopupLayer } from "./widget/NotifPopup"

app.start({
  css: style,
  // Control menus from the ShojiWM config (etc.) via `ags request`.
  //   ags request start-menu toggle|open|close <connector>
  //   ags request clipboard  toggle|open|close <connector>
  //   (action defaults to toggle when omitted)
  requestHandler(argv: string[], res: (response: string) => void) {
    const [command, ...rest] = argv
    const actions = ["toggle", "open", "close"] as const
    const hasAction = (actions as readonly string[]).includes(rest[0])
    const action = (hasAction ? rest[0] : "toggle") as StartMenuAction &
      ClipboardAction
    const connector = (hasAction ? rest[1] : rest[0]) ?? null

    if (command === "start-menu") {
      controlStartMenu(connector, action)
      res("ok")
      return
    }
    if (command === "clipboard") {
      controlClipboardMenu(connector, action)
      res("ok")
      return
    }
    res(`unknown request: ${argv.join(" ")}`)
  },
  main() {
    const monitors = createBinding(app, "monitors")

    return (
      <For each={monitors}>
        {(monitor) => (
          <This this={app}>
            <WallpaperBackground gdkmonitor={monitor} />
            <StartMenuLayer gdkmonitor={monitor} />
            <ClipboardMenuLayer gdkmonitor={monitor} />
            <ClockMenuLayer gdkmonitor={monitor} />
            <WallpaperLayer gdkmonitor={monitor} />
            <StatusMenuLayer gdkmonitor={monitor} />
            <NotifPopupLayer gdkmonitor={monitor} />
            <Bar gdkmonitor={monitor} />
            <DockWindow gdkmonitor={monitor} />
            <MonitorIdentifyLayer gdkmonitor={monitor} />
          </This>
        )}
      </For>
    )
  },
})
