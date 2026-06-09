import { createState } from "gnim"
import { connectShojiIpc, type ShojiIpcClient } from "./shojiIpc"

// View returned by ShojiWM's workspaces.* IPC (kept in sync with the protocol).
export type WsWindow = {
  id: string
  appId?: string
  title: string
  focused: boolean
  /** epoch ms — most recent focus time. 0 = never focused. */
  lastFocusedAt: number
}
export type WsWorkspace = {
  index: number
  windowCount: number
  isTiled: boolean
  active: boolean
  windows: WsWindow[]
}
export type WsMonitor = { name: string; active: number; workspaces: WsWorkspace[] }
export type WsView = { currentMonitor: string; monitors: WsMonitor[] }

// One shared connection per bar process. Both the workspace and layout widgets
// subscribe to the same view.
const [view, setView] = createState<WsView | null>(null)
export { view }

// Hold dock.proximity state per connector. The Dock only reads its own monitor's flag.
const [dockProximity, setDockProximity] = createState<Record<string, boolean>>({})
export { dockProximity }

export const ipc: ShojiIpcClient = connectShojiIpc(
  (message) => {
    if ("event" in message) {
      if (message.event === "workspaces.changed") {
        setView(message.payload as WsView)
      } else if (message.event === "dock.proximity") {
        const payload = message.payload as { monitor: string; inside: boolean }
        const current = dockProximity()
        if (current[payload.monitor] === payload.inside) {
          return
        }
        setDockProximity({ ...current, [payload.monitor]: payload.inside })
      }
    } else if ("result" in message && message.result) {
      setView(message.result as WsView)
    }
  },
  {
    // Fetch the initial state on each connect (and reconnect)
    onConnect: (client) => client.request("workspaces.get"),
  },
)

export function monitorView(
  v: WsView | null,
  connector: string | null,
): WsMonitor | null {
  if (!v) {
    return null
  }
  if (connector) {
    const matched = v.monitors.find((monitor) => monitor.name === connector)
    if (matched) {
      return matched
    }
  }
  // If the connector is unknown, fall back to the current monitor, otherwise the first
  return (
    v.monitors.find((monitor) => monitor.name === v.currentMonitor) ??
    v.monitors[0] ??
    null
  )
}

// Return the monitor's current (active) workspace
export function activeWorkspace(monitor: WsMonitor | null): WsWorkspace | null {
  if (!monitor) {
    return null
  }
  return (
    monitor.workspaces.find((workspace) => workspace.active) ??
    monitor.workspaces.find((workspace) => workspace.index === monitor.active) ??
    null
  )
}
