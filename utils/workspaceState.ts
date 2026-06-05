import { createState } from "gnim"
import { connectShojiIpc, type ShojiIpcClient } from "./shojiIpc"

// ShojiWM の workspaces.* IPC が返すビュー(protocol と一致させる)
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

// バープロセスにつき 1 本の共有接続。ワークスペース/レイアウト両ウィジェットが
// 同じ view を購読する。
const [view, setView] = createState<WsView | null>(null)
export { view }

// dock.proximity の状態を connector ごとに保持。Dock は自モニタのフラグだけ見る。
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
    // 接続(および再接続)のたびに初期状態を取得する
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
  // connector 不明時は現在のモニタ、それも無ければ先頭
  return (
    v.monitors.find((monitor) => monitor.name === v.currentMonitor) ??
    v.monitors[0] ??
    null
  )
}

// モニタの現在(アクティブ)ワークスペースを返す
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
