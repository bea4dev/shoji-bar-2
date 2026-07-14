import app from "ags/gtk4/app"
import type { Gdk, Gtk } from "ags/gtk4"
import style from "./style.scss"
import Bar from "./widget/Bar"
import { createBinding, For } from "gnim"
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
import { SnapPreviewLayer } from "./widget/SnapPreview"
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

    // Each For must return one window because Gnim does not support nested Fragments. Only the
    // always-visible windows register with Gtk.Application; GTK 4.22 can crash when unregistering
    // an initially hidden Wayland window that never acquired a GdkSurface.
    const mount = (createWindow: (monitor: Gdk.Monitor) => Gtk.Window) => (
      <For each={monitors}>{createWindow}</For>
    )

    mount((monitor) => <WallpaperBackground gdkmonitor={monitor} />)
    mount((monitor) => <StartMenuLayer gdkmonitor={monitor} />)
    mount((monitor) => <ClipboardMenuLayer gdkmonitor={monitor} />)
    mount((monitor) => <ClockMenuLayer gdkmonitor={monitor} />)
    mount((monitor) => <WallpaperLayer gdkmonitor={monitor} />)
    mount((monitor) => <StatusMenuLayer gdkmonitor={monitor} />)
    mount((monitor) => <NotifPopupLayer gdkmonitor={monitor} />)
    mount((monitor) => <Bar gdkmonitor={monitor} />)
    mount((monitor) => <DockWindow gdkmonitor={monitor} />)
    mount((monitor) => <MonitorIdentifyLayer gdkmonitor={monitor} />)
    mount((monitor) => <SnapPreviewLayer gdkmonitor={monitor} />)
  },
})
