import { Astal, Gdk, Gtk } from "ags/gtk4"
import { createState } from "gnim"
import app from "ags/gtk4/app"
import GLib from "gi://GLib"

// 全モニタ共有の「識別中」フラグ。各モニタの MonitorIdentifyLayer がこれを購読する。
const [identifying, setIdentifying] = createState(false)
export { identifying }

let identifyTimer: number | null = null

// 各モニタの中央にコネクタ名を一定時間(既定 3 秒)デカデカ表示する。
export function identifyMonitors(durationMs = 3000) {
  setIdentifying(true)
  if (identifyTimer !== null) {
    GLib.source_remove(identifyTimer)
  }
  identifyTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, durationMs, () => {
    identifyTimer = null
    setIdentifying(false)
    return GLib.SOURCE_REMOVE
  })
}

// モニタ中央に表示する識別用オーバーレイ。アンカー無し = layer-shell が中央寄せする。
// visible を identifying にバインドし、識別中だけ surface を mount する。
export function MonitorIdentifyLayer({
  gdkmonitor,
}: {
  gdkmonitor: Gdk.Monitor
}) {
  const connector = gdkmonitor.get_connector() ?? "?"

  return (
    <window
      name="monitor-identify"
      class="MonitorIdentify"
      gdkmonitor={gdkmonitor}
      layer={Astal.Layer.OVERLAY}
      exclusivity={Astal.Exclusivity.NORMAL}
      application={app}
      visible={identifying}
    >
      <box
        cssName="MonitorIdentifyBox"
        halign={Gtk.Align.CENTER}
        valign={Gtk.Align.CENTER}
      >
        <label cssName="MonitorIdentifyLabel" label={connector} />
      </box>
    </window>
  )
}
