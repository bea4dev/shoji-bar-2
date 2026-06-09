import { Gdk, Gtk } from "ags/gtk4"
import { For, createComputed } from "gnim"
import { ipc, view, monitorView, type WsWorkspace } from "../utils/workspaceState"

export function Workspaces({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  const connector = gdkmonitor.get_connector()

  const monitor = createComputed(() => monitorView(view(), connector))
  const workspaces = createComputed(() => monitor()?.workspaces ?? [])

  function activate(index: number) {
    const name = monitor()?.name
    if (name) {
      ipc.send("workspaces.activate", { monitor: name, index })
    }
  }

  // Scroll to the adjacent workspace (down = next, up = prev). Never go below 1.
  const scroll = Gtk.EventControllerScroll.new(
    Gtk.EventControllerScrollFlags.VERTICAL |
      Gtk.EventControllerScrollFlags.DISCRETE,
  )
  scroll.connect("scroll", (_c, _dx, dy) => {
    const current = monitor()
    if (!current || dy === 0) {
      return false
    }
    const next = dy > 0 ? current.active + 1 : Math.max(1, current.active - 1)
    if (next !== current.active) {
      activate(next)
    }
    return true
  })

  return (
    <box
      cssName="Workspaces"
      $={(self) => self.add_controller(scroll)}
      halign={Gtk.Align.START}
      valign={Gtk.Align.CENTER}
    >
      <For each={workspaces} id={(workspace: WsWorkspace) => workspace.index}>
        {(workspace: WsWorkspace) => {
          // index is the stable key; read display state from monitor() each time to stay reactive
          const index = workspace.index
          const live = createComputed(
            () =>
              monitor()?.workspaces.find((w) => w.index === index) ?? workspace,
          )
          return (
            <button
              cssName="Workspace"
              class={createComputed(() => {
                const ws = live()
                const classes: string[] = []
                if (ws.active) classes.push("active")
                if (ws.windowCount > 0) classes.push("occupied")
                if (ws.isTiled) classes.push("tiled")
                return classes.join(" ")
              })}
              onClicked={() => activate(index)}
            >
              <label cssName="WorkspaceLabel" label={String(index)} />
            </button>
          )
        }}
      </For>
    </box>
  )
}
