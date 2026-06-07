import app from "ags/gtk4/app"
import style from "./style.scss"
import Bar from "./widget/Bar"
import { createBinding, For, This } from "gnim"
import {
  StartMenuLayer,
  controlStartMenu,
  type StartMenuAction,
} from "./widget/StartMenu"
import { ClockMenuLayer } from "./widget/ClockMenu"
import { WallpaperBackground, WallpaperLayer } from "./widget/Wallpaper"
import { DockWindow } from "./widget/Dock"
import { StatusMenuLayer } from "./widget/StatusMenu"
import { NotifPopupLayer } from "./widget/NotifPopup"

app.start({
  css: style,
  // ShojiWM config 等から `ags request` 経由で StartMenu を操作する。
  //   ags request start-menu toggle <connector>
  //   ags request start-menu open|close <connector>
  //   ags request start-menu <connector>          (action 省略時は toggle)
  requestHandler(argv: string[], res: (response: string) => void) {
    const [command, ...rest] = argv
    if (command === "start-menu") {
      const actions: StartMenuAction[] = ["toggle", "open", "close"]
      const hasAction = actions.includes(rest[0] as StartMenuAction)
      const action = hasAction ? (rest[0] as StartMenuAction) : "toggle"
      const connector = (hasAction ? rest[1] : rest[0]) ?? null
      controlStartMenu(connector, action)
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
            <ClockMenuLayer gdkmonitor={monitor} />
            <WallpaperLayer gdkmonitor={monitor} />
            <StatusMenuLayer gdkmonitor={monitor} />
            <NotifPopupLayer gdkmonitor={monitor} />
            <Bar gdkmonitor={monitor} />
            <DockWindow gdkmonitor={monitor} />
          </This>
        )}
      </For>
    )
  },
})
