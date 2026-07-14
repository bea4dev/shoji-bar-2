import app from "ags/gtk4/app"
import { Astal, Gdk } from "ags/gtk4"
import { onCleanup } from "gnim"
import { StartMenuButton } from "./StartMenu"
import { ClockButton } from "./ClockMenu"
import { Workspaces } from "./Workspaces"
import { LayoutMode } from "./LayoutMode"
import { WallpaperButton } from "./Wallpaper"
import { StatusButton } from "./StatusMenu"
import { BatteryButton } from "./Battery"
import { CpuButton, MemoryButton } from "./SystemUsage"
import { SystemTray } from "./SystemTray"

export default function Bar({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  const { TOP, LEFT, RIGHT } = Astal.WindowAnchor

  return (
    <window
      visible
      name="bar"
      class="Bar"
      gdkmonitor={gdkmonitor}
      layer={Astal.Layer.TOP}
      exclusivity={Astal.Exclusivity.EXCLUSIVE}
      anchor={TOP | LEFT | RIGHT}
      application={app}
      $={(self) => onCleanup(() => self.destroy())}
    >
      <centerbox cssName="parentbox">
        <box $type="start">
          <box widthRequest={1} />
          <StartMenuButton gdkmonitor={gdkmonitor} />
          <LayoutMode gdkmonitor={gdkmonitor} />
          <Workspaces gdkmonitor={gdkmonitor} />
        </box>
        <box $type="center">
          <ClockButton gdkmonitor={gdkmonitor} />
        </box>
        <box $type="end">
          <CpuButton />
          <MemoryButton />
          <box widthRequest={10} />
          <SystemTray />
          <BatteryButton />
          <WallpaperButton gdkmonitor={gdkmonitor} />
          <StatusButton gdkmonitor={gdkmonitor} />
          <box widthRequest={1} />
        </box>
      </centerbox>
    </window>
  )
}
