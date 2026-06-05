import Gio from "gi://Gio"
import GLib from "gi://GLib"
import AstalApps from "gi://AstalApps"
import { createState } from "gnim"
import { ipc, view, type WsMonitor, type WsWindow } from "./workspaceState"

// =============================================================================
// Pinned apps (永続化 + reactive)
// 永続化先: ~/.config/shoji-bar-2/dock.json  形式: { pinned: string[] }
//   配列の要素は AstalApps.Application.entry (= .desktop の basename) を入れる。
//   app_id ベースだと desktop ID と一致しない場合があるため、安定な desktop ID を採用。
// =============================================================================

type DockConfig = {
  pinned: string[]
}

function dockConfigPath(): string {
  return `${GLib.get_user_config_dir()}/shoji-bar-2/dock.json`
}

function loadDockConfig(): DockConfig {
  try {
    const file = Gio.File.new_for_path(dockConfigPath())
    if (!file.query_exists(null)) {
      return { pinned: [] }
    }
    const [, contents] = file.load_contents(null)
    const text = new TextDecoder().decode(contents)
    const parsed = JSON.parse(text) as Partial<DockConfig>
    return {
      pinned: Array.isArray(parsed.pinned)
        ? parsed.pinned.filter((e) => typeof e === "string")
        : [],
    }
  } catch (err) {
    console.error("[dock] failed to load config:", err)
    return { pinned: [] }
  }
}

function saveDockConfig(config: DockConfig) {
  try {
    const dir = Gio.File.new_for_path(
      `${GLib.get_user_config_dir()}/shoji-bar-2`,
    )
    if (!dir.query_exists(null)) {
      dir.make_directory_with_parents(null)
    }
    const file = Gio.File.new_for_path(dockConfigPath())
    const text = JSON.stringify(config, null, 2) + "\n"
    file.replace_contents(
      new TextEncoder().encode(text),
      null,
      false,
      Gio.FileCreateFlags.NONE,
      null,
    )
  } catch (err) {
    console.error("[dock] failed to save config:", err)
  }
}

const [dockConfig, setDockConfigRaw] = createState(loadDockConfig())
export { dockConfig }

function setDockConfig(config: DockConfig) {
  setDockConfigRaw(config)
  saveDockConfig(config)
}

export function isPinned(entry: string): boolean {
  return dockConfig().pinned.includes(entry)
}

export function pinApp(entry: string) {
  const current = dockConfig()
  if (current.pinned.includes(entry)) return
  setDockConfig({ ...current, pinned: [...current.pinned, entry] })
}

export function unpinApp(entry: string) {
  const current = dockConfig()
  if (!current.pinned.includes(entry)) return
  setDockConfig({
    ...current,
    pinned: current.pinned.filter((e) => e !== entry),
  })
}

// =============================================================================
// App resolution (app_id -> AstalApps.Application).
// app_id は GTK app_id / Xwayland WM_CLASS のどちらかで、必ずしも .desktop の
// id と一致しないため、entry / executable / name の順で照合する。
// =============================================================================

const apps = new AstalApps.Apps()

function normalize(s: string | null | undefined): string {
  return (s ?? "").toLowerCase()
}

const appCache = new Map<string, AstalApps.Application | null>()

export function resolveApp(appId: string | undefined): AstalApps.Application | null {
  if (!appId) return null
  const cached = appCache.get(appId)
  if (cached !== undefined) return cached

  const target = normalize(appId)
  const list = apps.get_list()

  // 1. exact entry / basename
  let found =
    list.find((a) => normalize(a.entry) === target) ??
    list.find((a) => normalize(a.entry).startsWith(`${target}.`)) ??
    null

  // 2. executable
  if (!found) {
    found = list.find((a) => normalize(a.executable) === target) ?? null
  }

  // 3. fuzzy by name
  if (!found) {
    const results = apps.fuzzy_query(appId)
    found = results[0] ?? null
  }

  appCache.set(appId, found)
  return found
}

export function appIconName(app: AstalApps.Application | null): string {
  return app?.iconName ?? app?.icon_name ?? "application-x-executable"
}

export function appDisplayName(
  app: AstalApps.Application | null,
  appId: string | undefined,
): string {
  return app?.name ?? appId ?? "(unknown)"
}

// =============================================================================
// Window grouping per monitor.
// 同じ app_id のウィンドウを 1 アイテムに束ねる。MRU 順は WsWindow.lastFocusedAt
// で決める(降順)。ピン留めだけで開かれていないアプリも同じリストに混ぜる。
// =============================================================================

export type DockItem = {
  /** グループキー(app_id か pinned entry)。 */
  key: string
  app: AstalApps.Application | null
  appId: string | undefined
  windows: WsWindow[] // MRU 降順
  /** ピン留め済みか */
  pinned: boolean
  /** いずれかのウィンドウが focus 中 */
  focused: boolean
}

/** モニタの全ワークスペースのウィンドウをフラット化。 */
export function windowsOnMonitor(monitor: WsMonitor | null): WsWindow[] {
  if (!monitor) return []
  const out: WsWindow[] = []
  for (const workspace of monitor.workspaces) {
    for (const window of workspace.windows) {
      out.push(window)
    }
  }
  return out
}

/** Dock アイテム配列を構築(ピン留め優先、その後ピン無しの起動中アプリ)。 */
export function dockItemsFor(monitor: WsMonitor | null): DockItem[] {
  const allWindows = windowsOnMonitor(monitor)

  // group by appId(無ければ window.id 単独グループ扱い)
  const byKey = new Map<string, WsWindow[]>()
  for (const window of allWindows) {
    const key = window.appId ?? `__win__${window.id}`
    const arr = byKey.get(key) ?? []
    arr.push(window)
    byKey.set(key, arr)
  }
  for (const arr of byKey.values()) {
    arr.sort((a, b) => b.lastFocusedAt - a.lastFocusedAt)
  }

  const pinnedEntries = dockConfig().pinned
  const seenKeys = new Set<string>()
  const out: DockItem[] = []

  // ピン留めを最初に出す(順序維持)
  for (const entry of pinnedEntries) {
    const pinnedApp = apps.get_list().find((a) => a.entry === entry) ?? null
    // ピン留めと同じ desktop id を持つ起動中グループを紐付ける
    const matchingKey = [...byKey.keys()].find(
      (k) => {
        const w = byKey.get(k)?.[0]
        if (!w) return false
        const resolved = resolveApp(w.appId)
        return resolved?.entry === entry
      },
    )
    const windows = matchingKey ? (byKey.get(matchingKey) ?? []) : []
    if (matchingKey) seenKeys.add(matchingKey)

    out.push({
      key: `pinned:${entry}`,
      app: pinnedApp,
      appId: windows[0]?.appId,
      windows,
      pinned: true,
      focused: windows.some((w) => w.focused),
    })
  }

  // ピン留めされていない起動中グループを後ろに
  for (const [key, windows] of byKey) {
    if (seenKeys.has(key)) continue
    const app = resolveApp(windows[0]?.appId)
    out.push({
      key: `running:${key}`,
      app,
      appId: windows[0]?.appId,
      windows,
      pinned: false,
      focused: windows.some((w) => w.focused),
    })
  }

  return out
}

// =============================================================================
// アクション
// =============================================================================

/** 左クリック: 起動中なら MRU 先頭を focus、空なら launch。 */
export function activateOrLaunch(item: DockItem) {
  if (item.windows.length === 0) {
    if (item.app) {
      item.app.launch()
    }
    return
  }
  const target = item.windows[0]
  ipc.send("windows.activate", { windowId: target.id })
}

/** ウィンドウ id 指定で focus + ワークスペース移動を要求する。 */
export function activateWindow(windowId: string) {
  ipc.send("windows.activate", { windowId })
}

/** New window: pinned 列挙でも開けるよう個別 API を分けている。 */
export function launchAppOf(item: DockItem) {
  if (item.app) item.app.launch()
}

export function monitorByConnector(
  v: ReturnType<typeof view>,
  connector: string | null,
): WsMonitor | null {
  if (!v) return null
  if (connector) {
    const matched = v.monitors.find((m) => m.name === connector)
    if (matched) return matched
  }
  return v.monitors.find((m) => m.name === v.currentMonitor) ?? v.monitors[0] ?? null
}
