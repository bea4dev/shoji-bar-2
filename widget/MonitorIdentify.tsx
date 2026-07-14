import { Astal, Gdk, Gtk } from "ags/gtk4"
import { createState, onCleanup } from "gnim"
import GLib from "gi://GLib"

// Shared "identifying" flag across all monitors. Each monitor's MonitorIdentifyLayer subscribes to it.
const [identifying, setIdentifying] = createState(false)
export { identifying }

let identifyTimer: number | null = null

// Show the connector name large in the center of each monitor for a duration (default 3s).
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

// Identify overlay shown centered on the monitor. No anchor = layer-shell centers the surface.
// Bind visible to identifying so the surface is only mounted while identifying.
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
      $={(self) => onCleanup(() => self.destroy())}
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
