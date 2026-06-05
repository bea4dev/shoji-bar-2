import { Gdk, Gtk } from "ags/gtk4"
import { createComputed } from "gnim"
import { view, monitorView, activeWorkspace, ipc } from "../utils/workspaceState"

// 現在のワークスペースがタイル型かフローティング型かを表示するラベル。
// "Tiled" / "Float"(monospace)とアイコン(assets/tiled.svg, assets/float.svg)。
// クリックでそのモニタの現在ワークスペースのタイル/フロート切替を要求する。
export function LayoutMode({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  const connector = gdkmonitor.get_connector()

  const tiled = createComputed(() => {
    const monitor = monitorView(view(), connector)
    return activeWorkspace(monitor)?.isTiled ?? false
  })

  return (
    <button
      cssName="LayoutMode"
      halign={Gtk.Align.START}
      valign={Gtk.Align.CENTER}
      onClicked={() =>
        ipc.send(
          "workspaces.toggleTiling",
          connector ? { monitor: connector } : undefined,
        )
      }
    >
      <box>
        <image
          cssName="LayoutModeIcon"
          file={tiled((t) => `${SRC}/assets/${t ? "tiled" : "float"}.svg`)}
          pixelSize={16}
        />
        <label
          cssName="LayoutModeLabel"
          label={tiled((t) => (t ? "Tiled" : "Float"))}
        />
      </box>
    </button>
  )
}
