import app from "ags/gtk4/app"
import { Astal, Gdk } from "ags/gtk4"
import { StartMenuButton } from "./StartMenu"
import { ClockButton } from "./ClockMenu"
import { Workspaces } from "./Workspaces"
import { LayoutMode } from "./LayoutMode"
import { WallpaperButton } from "./Wallpaper"

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
          <WallpaperButton gdkmonitor={gdkmonitor} />
          <box widthRequest={1} />
        </box>
      </centerbox>
    </window>
  )
}
