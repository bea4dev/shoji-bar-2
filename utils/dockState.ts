import Gio from "gi://Gio"
import GLib from "gi://GLib"
import AstalApps from "gi://AstalApps"
import { createState } from "gnim"
import { ipc, view, type WsMonitor, type WsWindow } from "./workspaceState"

// =============================================================================
// Pinned apps (persisted + reactive)
// Stored at: ~/.config/shoji-bar-2/dock.json  shape: { pinned: string[] }
//   Array elements are AstalApps.Application.entry (= the .desktop basename).
//   app_id may not match the desktop ID, so use the stable desktop ID.
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
// app_id is either the GTK app_id or the Xwayland WM_CLASS, not necessarily matching the
// .desktop id, so match in the order entry / executable / name.
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
// Group windows with the same app_id into one item. MRU order is by WsWindow.lastFocusedAt
// (descending). Pinned-but-not-running apps are mixed into the same list.
// =============================================================================

export type DockItem = {
  /** Group key (app_id or pinned entry). */
  key: string
  app: AstalApps.Application | null
  appId: string | undefined
  windows: WsWindow[] // MRU descending
  /** Whether it is pinned */
  pinned: boolean
  /** Whether any window is focused */
  focused: boolean
}

/** Flatten windows across all of the monitor's workspaces. */
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

/** Build the dock item array (pinned first, then unpinned running apps). */
export function dockItemsFor(monitor: WsMonitor | null): DockItem[] {
  const allWindows = windowsOnMonitor(monitor)

  // group by appId (fall back to a single-window group keyed by window.id)
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

  // Emit pinned items first (preserving order)
  for (const entry of pinnedEntries) {
    const pinnedApp = apps.get_list().find((a) => a.entry === entry) ?? null
    // Link the running group that shares the same desktop id as the pinned entry
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

  // Then the unpinned running groups
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
// Actions
// =============================================================================

/** Left click: focus the MRU-front window if running, otherwise launch. */
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

/** Request focus + workspace switch for a given window id. */
export function activateWindow(windowId: string) {
  ipc.send("windows.activate", { windowId })
}

/** New window: a separate API so pinned entries can launch too. */
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
