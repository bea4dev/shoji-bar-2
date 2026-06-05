import app from "ags/gtk4/app"
import style from "./style.scss"
import Bar from "./widget/Bar"
import { createBinding, For, This } from "gnim"
import { StartMenuLayer } from "./widget/StartMenu"
import { ClockMenuLayer } from "./widget/ClockMenu"
import { WallpaperBackground, WallpaperLayer } from "./widget/Wallpaper"

app.start({
  css: style,
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
            <Bar gdkmonitor={monitor} />
          </This>
        )}
      </For>
    )
  },
})
