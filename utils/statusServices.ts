import GLib from "gi://GLib"
import Gio from "gi://Gio"
import AstalNetwork from "gi://AstalNetwork"
import AstalPowerProfiles from "gi://AstalPowerProfiles"
import AstalNotifd from "gi://AstalNotifd"
import AstalMpris from "gi://AstalMpris"
import AstalWp from "gi://AstalWp"
import AstalBattery from "gi://AstalBattery"
import { createBinding, createComputed, createState } from "gnim"
import { execAsync, subprocess, type Process } from "ags/process"

// =============================================================================
// Singleton
// =============================================================================

export const network = AstalNetwork.get_default()
export const powerProfiles = AstalPowerProfiles.get_default()
export const notifd = AstalNotifd.get_default()
export const mpris = AstalMpris.get_default()
export const audio = AstalWp.get_default()
export const battery = AstalBattery.get_default()

// =============================================================================
// Wifi
//
// AstalNetwork.Wifi doesn't immediately emit property updates for changes made on the NM
// side (especially external disconnects via nmcli), reproduced on real hardware, so
// we switched to **building the state entirely from our own polling of nmcli output**.
//
// Baseline: run `nmcli` every 3s and push the result into createState.
// Only right when the Wi-Fi submenu opens and just after an action, switch to immediate +
// high-frequency (1.5s) polling to improve responsiveness.
// =============================================================================

/** Our own AP type. Minimally compatible with AstalNetwork.AccessPoint: ssid / strength. */
export type WifiAp = {
  ssid: string
  bssid: string
  /** 0..100 */
  strength: number
  /** "WPA2/WPA3" / "WPA" / "WEP" / "Open" / "Unknown" */
  security: string
  /** Whether we are currently connected to this AP */
  inUse: boolean
}

/** State enum with essentially the same meaning as AstalNetwork.Internet. */
export const WifiInternet = {
  DISCONNECTED: 0,
  CONNECTING: 1,
  CONNECTED: 2,
} as const
export type WifiInternetValue = (typeof WifiInternet)[keyof typeof WifiInternet]

const [wifiEnabledState, setWifiEnabledState] = createState(false)
const [wifiSsidState, setWifiSsidState] = createState<string | null>(null)
const [wifiInternetState, setWifiInternetState] = createState<WifiInternetValue>(
  WifiInternet.DISCONNECTED,
)
const [wifiStrengthState, setWifiStrengthState] = createState(0)
const [wifiScanningState, setWifiScanningState] = createState(false)
const [wifiApsState, setWifiApsState] = createState<WifiAp[]>([])

export const wifiEnabled = wifiEnabledState
export const wifiSsid = wifiSsidState
export const wifiInternet = wifiInternetState
export const wifiStrength = wifiStrengthState
export const wifiScanning = wifiScanningState
export const wifiAccessPoints = wifiApsState

// ---- Parse nmcli -t output (fields separated by `:`; a literal `:` in a value is escaped as `\:`).
function splitNmcliFields(line: string): string[] {
  const fields: string[] = []
  let current = ""
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "\\" && i + 1 < line.length) {
      current += line[i + 1]
      i++
    } else if (ch === ":") {
      fields.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

function normalizeSecurity(sec: string): string {
  const s = sec.trim()
  if (s.length === 0 || s === "--") return "Open"
  if (/WPA3|RSN/i.test(s)) return "WPA2/WPA3"
  if (/WPA2/i.test(s)) return "WPA2"
  if (/WPA/i.test(s)) return "WPA"
  if (/WEP/i.test(s)) return "WEP"
  return s
}

export function accessPointRequiresPassword(ap: WifiAp): boolean {
  return ap.security !== "Open"
}

export function accessPointSecurity(ap: WifiAp): string {
  return ap.security
}

// ---- Actual polling ----
let pollingIntervalMs = 3000
let pollingTimeoutId: number | null = null
let menuFocusCount = 0
let pollInFlight = false

async function pollWifiState(): Promise<void> {
  if (pollInFlight) return
  pollInFlight = true
  try {
    // 1) Wi-Fi radio enabled?
    let enabled = false
    try {
      const out = await execAsync(["nmcli", "-t", "-f", "WIFI", "radio"])
      const text = typeof out === "string" ? out : ""
      enabled = text.trim() === "enabled"
    } catch (err) {
      console.error("[status] poll: radio failed:", err)
      enabled = false
    }
    setWifiEnabledState(enabled)

    if (!enabled) {
      setWifiSsidState(null)
      setWifiInternetState(WifiInternet.DISCONNECTED)
      setWifiStrengthState(0)
      setWifiApsState([])
      return
    }

    // 2) Determine CONNECTED/CONNECTING from device state + capture the iface
    let deviceState: string | null = null
    try {
      const out = await execAsync([
        "nmcli",
        "-t",
        "-f",
        "TYPE,STATE",
        "device",
      ])
      const text = typeof out === "string" ? out : ""
      for (const line of text.split("\n")) {
        const f = splitNmcliFields(line)
        if (f.length < 2) continue
        if (f[0] === "wifi") {
          deviceState = f[1]
          break
        }
      }
    } catch {
      // ignore
    }

    // 3) AP list
    let activeSsid: string | null = null
    let activeStrength = 0
    let aps: WifiAp[] = []
    try {
      const out = await execAsync([
        "nmcli",
        "-t",
        "-f",
        "IN-USE,BSSID,SSID,SIGNAL,SECURITY",
        "device",
        "wifi",
        "list",
        "--rescan",
        "no",
      ])
      const text = typeof out === "string" ? out : ""
      for (const line of text.split("\n")) {
        if (!line) continue
        const f = splitNmcliFields(line)
        if (f.length < 5) continue
        const inUse = f[0] === "*"
        const bssid = f[1]
        const ssid = f[2]
        const strength = Number.parseInt(f[3], 10) || 0
        const security = normalizeSecurity(f[4])
        if (!ssid) continue
        const ap: WifiAp = { ssid, bssid, strength, security, inUse }
        aps.push(ap)
        if (inUse) {
          activeSsid = ssid
          activeStrength = strength
        }
      }
      // Dedupe same SSID (prefer in-use, then by signal strength descending)
      const best = new Map<string, WifiAp>()
      for (const ap of aps) {
        const existing = best.get(ap.ssid)
        if (
          !existing ||
          (ap.inUse && !existing.inUse) ||
          (!existing.inUse && ap.strength > existing.strength)
        ) {
          best.set(ap.ssid, ap)
        }
      }
      aps = [...best.values()].sort((a, b) => {
        if (a.inUse !== b.inUse) return a.inUse ? -1 : 1
        return b.strength - a.strength
      })
    } catch (err) {
      console.error("[status] poll: ap list failed:", err)
    }

    setWifiApsState(aps)
    setWifiSsidState(activeSsid)
    setWifiStrengthState(activeStrength)
    // CONNECTING check: device state is a "connecting" variant
    if (deviceState && /connecting/i.test(deviceState)) {
      setWifiInternetState(WifiInternet.CONNECTING)
    } else if (activeSsid) {
      setWifiInternetState(WifiInternet.CONNECTED)
    } else {
      setWifiInternetState(WifiInternet.DISCONNECTED)
    }
  } finally {
    pollInFlight = false
  }
}

function setPollIntervalAndStart(intervalMs: number) {
  if (pollingTimeoutId !== null && pollingIntervalMs === intervalMs) return
  if (pollingTimeoutId !== null) {
    GLib.source_remove(pollingTimeoutId)
    pollingTimeoutId = null
  }
  pollingIntervalMs = intervalMs
  pollingTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, intervalMs, () => {
    void pollWifiState()
    return GLib.SOURCE_CONTINUE
  })
}

/**
 * Call while the Wi-Fi submenu is open to raise the poll interval to 1.5s.
 * Calling the returned function restores the background interval (3s).
 */
export function focusWifiPolling(): () => void {
  menuFocusCount += 1
  if (menuFocusCount === 1) {
    setPollIntervalAndStart(1500)
  }
  void pollWifiState() // immediate update
  let released = false
  return () => {
    if (released) return
    released = true
    menuFocusCount = Math.max(0, menuFocusCount - 1)
    if (menuFocusCount === 0) {
      setPollIntervalAndStart(3000)
    }
  }
}

// Initial poll + start background 3s polling
setPollIntervalAndStart(3000)
void pollWifiState()

// ---- Actions ----

export function wifiIconName(): string {
  if (!wifiEnabled()) return "wifi-off"
  const s = wifiStrength()
  if (s >= 70) return "wifi-full"
  if (s >= 40) return "wifi-midium"
  if (s >= 10) return "wifi-low"
  return "wifi-off"
}

export async function setWifiEnabled(enabled: boolean): Promise<void> {
  try {
    await execAsync(["nmcli", "radio", "wifi", enabled ? "on" : "off"])
  } catch (err) {
    console.error("[status] wifi set enabled failed:", err)
  }
  void pollWifiState()
}

export async function toggleWifi(): Promise<void> {
  return setWifiEnabled(!wifiEnabledState())
}

/** Explicitly run a rescan and set the scanning flag. */
export async function triggerWifiScan(): Promise<void> {
  if (!wifiEnabledState()) return
  setWifiScanningState(true)
  try {
    await execAsync(["nmcli", "device", "wifi", "rescan"])
  } catch (err) {
    // Ignore "Scan request failed: Scanning not allowed immediately" and similar.
    const msg = err instanceof Error ? err.message : String(err)
    if (!/not allowed|too soon/i.test(msg)) {
      console.error("[status] rescan failed:", err)
    }
  }
  // Wait a bit for results to settle, then poll and clear the scanning flag.
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
    void pollWifiState().then(() => setWifiScanningState(false))
    return GLib.SOURCE_REMOVE
  })
}

export interface WifiConnectResult {
  ok: boolean
  message?: string
  needsPassword?: boolean
}

function isPasswordError(message: string): boolean {
  return /no[\s-]?secrets?|secret|password|authentication|802-11-wireless-security|invalid-secrets/i.test(
    message,
  )
}

export async function wifiConnect(
  ssid: string,
  password?: string,
): Promise<WifiConnectResult> {
  if (!ssid) {
    return { ok: false, message: "SSID not specified" }
  }
  const args = ["nmcli", "-w", "30", "device", "wifi", "connect", ssid]
  if (password && password.length > 0) {
    args.push("password", password)
  }
  let result: WifiConnectResult
  try {
    await execAsync(args)
    result = { ok: true }
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : String(err)
    result = { ok: false, message, needsPassword: isPasswordError(message) }
  }
  // Regardless of result, re-poll 3 times at a short interval to ensure the state is reflected.
  for (const delay of [200, 800, 1800]) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      void pollWifiState()
      return GLib.SOURCE_REMOVE
    })
  }
  return result
}

/**
 * Put the Wi-Fi device itself into the DISCONNECTED state (suppress autoconnect).
 */
export async function wifiDisconnect(): Promise<void> {
  let iface: string | null = null
  try {
    const out = await execAsync(["nmcli", "-t", "-f", "DEVICE,TYPE", "device"])
    const text = typeof out === "string" ? out : ""
    for (const line of text.split("\n")) {
      const f = splitNmcliFields(line)
      if (f.length < 2) continue
      if (f[1] === "wifi" && f[0].length > 0) {
        iface = f[0]
        break
      }
    }
  } catch (err) {
    console.error("[status] wifi device list failed:", err)
  }

  if (iface) {
    try {
      await execAsync(["nmcli", "device", "disconnect", iface])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!/not active|already/i.test(msg)) {
        console.error("[status] wifi disconnect failed:", err)
      }
    }
  }

  // Poll multiple times for immediate UI reflection + reliability.
  setWifiSsidState(null)
  setWifiInternetState(WifiInternet.DISCONNECTED)
  setWifiStrengthState(0)
  for (const delay of [150, 600, 1500]) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      void pollWifiState()
      return GLib.SOURCE_REMOVE
    })
  }
}

// =============================================================================
// Bluetooth
//
// Not AstalBluetooth (the bluez D-Bus binding); like Wi-Fi, we build state from
// **our own polling of bluetoothctl**. As with Wi-Fi, the reason is to avoid missing
// external changes (another client connecting / disconnecting).
//
// Baseline: every 3s run `bluetoothctl show` + `bluetoothctl devices [filter]`
// and push the result into createState. Only right when the submenu opens and just
// after an action, switch to immediate + high-frequency (1.5s) polling (focusBluetoothPolling).
// =============================================================================

export type BtDevice = {
  /** "AA:BB:CC:DD:EE:FF" format */
  mac: string
  /** Prefer alias (fall back to the address when empty) */
  name: string
  paired: boolean
  trusted: boolean
  connected: boolean
}

const [btEnabledState, setBtEnabledState] = createState(false)
const [btScanningState, setBtScanningState] = createState(false)
const [btDevicesState, setBtDevicesState] = createState<BtDevice[]>([])

export const bluetoothEnabled = btEnabledState
export const bluetoothScanning = btScanningState
export const bluetoothDevices = btDevicesState

// For the summary display: the connected device's name if any, otherwise On / Off
export const bluetoothPrimary = createComputed(() => {
  if (!btEnabledState()) return "Off"
  const connected = btDevicesState().find((d) => d.connected)
  if (connected) return connected.name
  return "On"
})

// ---- Parse bluetoothctl output ----

function parseDevicesOutput(text: string): { mac: string; name: string }[] {
  const out: { mac: string; name: string }[] = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    // "Device AA:BB:CC:DD:EE:FF Alias name with spaces"
    const m = line.match(/^Device\s+([0-9A-F:]{17})\s*(.*)$/i)
    if (!m) continue
    out.push({ mac: m[1].toUpperCase(), name: m[2] || m[1].toUpperCase() })
  }
  return out
}

function parseMacs(text: string): Set<string> {
  return new Set(parseDevicesOutput(text).map((d) => d.mac))
}

// ---- Actual polling ----
let btPollingIntervalMs = 3000
let btPollingTimeoutId: number | null = null
let btMenuFocusCount = 0
let btPollInFlight = false

async function pollBluetoothState(): Promise<void> {
  if (btPollInFlight) return
  btPollInFlight = true
  try {
    // 1) Adapter state
    let showText = ""
    try {
      const out = await execAsync(["bluetoothctl", "show"])
      showText = typeof out === "string" ? out : ""
    } catch (err) {
      // Cases like no adapter present. Treat as Off.
      setBtEnabledState(false)
      setBtScanningState(false)
      setBtDevicesState([])
      return
    }
    let powered = false
    let discovering = false
    for (const line of showText.split("\n")) {
      if (/^\s*Powered:\s*yes/i.test(line)) powered = true
      if (/^\s*Discovering:\s*yes/i.test(line)) discovering = true
    }
    setBtEnabledState(powered)
    setBtScanningState(discovering)

    if (!powered) {
      setBtDevicesState([])
      return
    }

    // 2) Determine paired / connected / trusted from the device list + filtered list
    const [allText, pairedText, connectedText, trustedText] = await Promise.all([
      execAsync(["bluetoothctl", "devices"]).catch(() => ""),
      execAsync(["bluetoothctl", "devices", "Paired"]).catch(() => ""),
      execAsync(["bluetoothctl", "devices", "Connected"]).catch(() => ""),
      execAsync(["bluetoothctl", "devices", "Trusted"]).catch(() => ""),
    ])
    const all = parseDevicesOutput(typeof allText === "string" ? allText : "")
    const pairedSet = parseMacs(typeof pairedText === "string" ? pairedText : "")
    const connectedSet = parseMacs(
      typeof connectedText === "string" ? connectedText : "",
    )
    const trustedSet = parseMacs(typeof trustedText === "string" ? trustedText : "")

    const devs: BtDevice[] = all.map((d) => ({
      mac: d.mac,
      name: d.name,
      paired: pairedSet.has(d.mac),
      trusted: trustedSet.has(d.mac),
      connected: connectedSet.has(d.mac),
    }))
    devs.sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1
      if (a.paired !== b.paired) return a.paired ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    setBtDevicesState(devs)
  } finally {
    btPollInFlight = false
  }
}

function setBtPollIntervalAndStart(intervalMs: number) {
  if (btPollingTimeoutId !== null && btPollingIntervalMs === intervalMs) return
  if (btPollingTimeoutId !== null) {
    GLib.source_remove(btPollingTimeoutId)
    btPollingTimeoutId = null
  }
  btPollingIntervalMs = intervalMs
  btPollingTimeoutId = GLib.timeout_add(
    GLib.PRIORITY_DEFAULT,
    intervalMs,
    () => {
      void pollBluetoothState()
      return GLib.SOURCE_CONTINUE
    },
  )
}

/**
 * Call while the Bluetooth submenu is shown to raise polling to 1.5s.
 * Use the returned function to restore 3s.
 */
export function focusBluetoothPolling(): () => void {
  btMenuFocusCount += 1
  if (btMenuFocusCount === 1) {
    setBtPollIntervalAndStart(1500)
  }
  void pollBluetoothState() // immediate update
  let released = false
  return () => {
    if (released) return
    released = true
    btMenuFocusCount = Math.max(0, btMenuFocusCount - 1)
    if (btMenuFocusCount === 0) {
      setBtPollIntervalAndStart(3000)
    }
  }
}

// Initial poll + background 3s polling
setBtPollIntervalAndStart(3000)
void pollBluetoothState()

// ---- Pairing agent ----
//
// BlueZ requires **registering an agent** to confirm SSP (Secure Simple Pairing) passkeys.
// Without an agent, bluetoothd emits
//   `No agent available for request type 2`
//   `device_confirm_passkey: Operation not permitted`
// and pairing times out; even if it connects, it gets dropped after a few seconds with
// `org.bluez.Reason.Local Connection terminated by local host`.
//
// In one-shot bluetoothctl style the agent is only registered for that process's lifetime,
// so we launch a **long-running bluetoothctl** here to keep the agent alive.
// stdin stays open as a pipe, so bluetoothctl never hits EOF and keeps running.
//
// NoInputNoOutput = the capability for devices with neither keyboard nor display.
// Auto-accepts all SSP requests (= no user interaction). In this desktop environment,
// the user's intent is already expressed when they press the "Connect" button in the menu,
// so auto-accept is fine.
let btAgentProc: Process | null = null
function startBluetoothAgent() {
  if (btAgentProc) return
  try {
    btAgentProc = subprocess(
      ["bluetoothctl", "--agent", "NoInputNoOutput"],
      // Normally output nothing. Swap in console.log when diagnosing.
      () => {},
      () => {},
    )
    btAgentProc.connect("exit", (_self, code, signaled) => {
      console.error(
        `[status] bluetooth agent exited (code=${code} signaled=${signaled}); restarting in 2s`,
      )
      btAgentProc = null
      // If it dies for any reason, restart after 2s (a simple limit to prevent runaway repeated failures).
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
        startBluetoothAgent()
        return GLib.SOURCE_REMOVE
      })
    })
  } catch (err) {
    console.error("[status] failed to start bluetooth agent:", errMessage(err))
  }
}
startBluetoothAgent()

// ---- Actions ----

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.toString()
  if (typeof err === "string") return err
  return String(err)
}

async function tryUnblockBluetooth(): Promise<void> {
  // BT can be soft/hard-blocked by rfkill. A hard block (e.g. a physical switch)
  // needs user action so we can't help, but a soft block can be cleared with `rfkill unblock`.
  // In an off-blocked state, bluetoothctl power on returns org.bluez.Error.Failed,
  // so clear it first here.
  try {
    await execAsync(["rfkill", "unblock", "bluetooth"])
  } catch (err) {
    // Failure isn't fatal (it should succeed if already unblocked; real failures
    // are things like insufficient permissions). Just log for diagnostics.
    console.error("[status] rfkill unblock bluetooth failed:", errMessage(err))
  }
}

function waitMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      resolve()
      return GLib.SOURCE_REMOVE
    }),
  )
}

/** Run bluetoothctl show once and return the Powered / PowerState excerpt. */
async function readBluetoothPower(): Promise<{
  powered: boolean
  transitional: boolean
}> {
  try {
    const out = await execAsync(["bluetoothctl", "show"])
    const text = typeof out === "string" ? out : ""
    const powered = /^\s*Powered:\s*yes/im.test(text)
    // on-disabling / off-enabling are transitional states. Used to detect stuck.
    const transitional =
      /^\s*PowerState:\s*(on-disabling|off-enabling)/im.test(text)
    return { powered, transitional }
  } catch {
    return { powered: false, transitional: false }
  }
}

/** Fully reset the adapter via an rfkill cycle (recover from stuck states like on-disabling). */
async function rfkillResetBluetooth(): Promise<void> {
  await execAsync(["rfkill", "block", "bluetooth"]).catch((err) => {
    console.error("[status] rfkill block bluetooth failed:", errMessage(err))
  })
  await waitMs(600)
  await execAsync(["rfkill", "unblock", "bluetooth"]).catch((err) => {
    console.error("[status] rfkill unblock bluetooth failed:", errMessage(err))
  })
  await waitMs(800)
}

export async function setBluetoothEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    await tryUnblockBluetooth()

    // Right after an rfkill unblock, org.bluez.Error.Busy can be returned for a very short
    // window, so retry lightly.
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await execAsync(["bluetoothctl", "power", "on"])
        lastErr = null
        break
      } catch (err) {
        lastErr = err
        const msg = errMessage(err)
        if (!/Busy/i.test(msg)) break
        await waitMs(400)
      }
    }

    // If Busy / NotReady doesn't clear, the adapter is likely stuck in on-disabling etc.,
    // so reset via an rfkill cycle, then turn it back ON.
    if (lastErr !== null) {
      const msg = errMessage(lastErr)
      console.error("[status] bluetoothctl power on failed:", msg)
      if (/Busy|NotReady/i.test(msg)) {
        console.error("[status] attempting rfkill cycle to recover stuck adapter")
        await rfkillResetBluetooth()
        try {
          await execAsync(["bluetoothctl", "power", "on"])
        } catch (err2) {
          console.error(
            "[status] bluetoothctl power on retry failed:",
            errMessage(err2),
          )
        }
      }
    }
  } else {
    // First, the normal power off.
    try {
      await execAsync(["bluetoothctl", "power", "off"])
    } catch (err) {
      // Busy etc. Continue and try the fallback below.
      const msg = errMessage(err)
      if (!/Busy/i.test(msg)) {
        console.error("[status] bluetoothctl power off failed:", msg)
      }
    }

    // Wait 1.5s and check the real state; if it hasn't reached off yet,
    // force it off at the kernel level via rfkill block (rescue from on-disabling stuck).
    await waitMs(1500)
    const state = await readBluetoothPower()
    if (state.powered || state.transitional) {
      console.error(
        "[status] bluetooth power off did not complete; forcing rfkill block",
      )
      try {
        await execAsync(["rfkill", "block", "bluetooth"])
      } catch (err) {
        console.error("[status] rfkill block bluetooth failed:", errMessage(err))
      }
    }
  }

  // Schedule multiple polls to confirm the state was reflected.
  for (const delay of [150, 600, 1500, 3000]) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      void pollBluetoothState()
      return GLib.SOURCE_REMOVE
    })
  }
}

export async function toggleBluetooth(): Promise<void> {
  return setBluetoothEnabled(!btEnabledState())
}

/**
 * Run a scan for 15 seconds (bluetoothctl's --timeout feature).
 * Fire-and-forget: bluetoothctl stays alive until --timeout elapses, so
 * don't await; observe Discovering: yes/no via polling.
 *
 * For UI responsiveness, don't simply skip a re-click while already scanning;
 * check the adapter's real Discovering state to see whether it's actually running.
 * (because the optimistic flag can get stuck stale.)
 */
export async function triggerBluetoothScan(): Promise<void> {
  if (!btEnabledState()) return
  // Check the real state before setting the optimistic flag: if already Discovering:yes,
  // avoid a duplicate start while aligning the flag to the true value. If the flag is set
  // despite Discovering:no, that's stuck, so clear the flag here so it can be
  // re-triggered.
  const state = await readBluetoothPower()
  if (!state.powered) return

  setBtScanningState(true)
  void execAsync(["bluetoothctl", "--timeout", "15", "scan", "on"]).catch(
    (err) => {
      const msg = errMessage(err)
      // "Already discovering" can be ignored
      if (!/Already|discovering/i.test(msg)) {
        console.error("[status] bluetoothctl scan on failed:", msg)
      }
    },
  )
  for (const delay of [300, 1200, 3000, 8000, 15500]) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      void pollBluetoothState()
      return GLib.SOURCE_REMOVE
    })
  }
}

export interface BluetoothConnectResult {
  ok: boolean
  message?: string
}

/** Get the true value of the Connected: field from bluetoothctl info <mac>. */
async function isDeviceConnected(mac: string): Promise<boolean> {
  try {
    const out = await execAsync(["bluetoothctl", "info", mac])
    const text = typeof out === "string" ? out : ""
    return /^\s*Connected:\s*yes/im.test(text)
  } catch {
    return false
  }
}

function scheduleBluetoothRepoll() {
  for (const delay of [200, 800, 1800]) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      void pollBluetoothState()
      return GLib.SOURCE_REMOVE
    })
  }
}

/**
 * Connect to a device. If not paired, pair -> trust first, then connect.
 *
 * Note: for Classic BT (BR/EDR), the `bluetoothctl pair` step already
 * completes the connection automatically. Calling `bluetoothctl connect` then
 * fails with e.g. `org.bluez.Error.Failed br-connection-unknown`,
 * but the real state is Connected: yes, so whenever a step reports failure,
 * always check info and judge by the **actual connection state**.
 *
 * When a PIN is required, bluez's system agent (gnome-shell etc.) takes over.
 */
export async function bluetoothConnect(
  mac: string,
): Promise<BluetoothConnectResult> {
  const dev = btDevicesState().find((d) => d.mac === mac)
  if (!dev) return { ok: false, message: "Unknown device" }

  if (!dev.paired) {
    let pairErr: unknown = null
    try {
      await execAsync(["bluetoothctl", "pair", mac])
    } catch (err) {
      pairErr = err
    }
    // Regardless of pair success/failure, if the real state is Connected: yes, treat it as success.
    if (await isDeviceConnected(mac)) {
      try {
        await execAsync(["bluetoothctl", "trust", mac])
      } catch {
        // trust failure isn't fatal
      }
      scheduleBluetoothRepoll()
      return { ok: true }
    }
    if (pairErr !== null) {
      scheduleBluetoothRepoll()
      return { ok: false, message: errMessage(pairErr) }
    }
    // pair succeeded but not connected (an explicit connect is still needed)
    try {
      await execAsync(["bluetoothctl", "trust", mac])
    } catch {
      // trust failure isn't fatal
    }
  }

  try {
    await execAsync(["bluetoothctl", "connect", mac])
    scheduleBluetoothRepoll()
    return { ok: true }
  } catch (err) {
    // Even if connect returns failure, treat Connected: yes in the real state as success
    // (the Classic BT double-connect br-connection-unknown case).
    if (await isDeviceConnected(mac)) {
      scheduleBluetoothRepoll()
      return { ok: true }
    }
    scheduleBluetoothRepoll()
    return { ok: false, message: errMessage(err) }
  }
}

export async function bluetoothDisconnect(mac: string): Promise<void> {
  try {
    await execAsync(["bluetoothctl", "disconnect", mac])
  } catch (err) {
    const msg = errMessage(err)
    if (!/not connected|not available/i.test(msg)) {
      console.error("[status] bluetooth disconnect failed:", msg)
    }
  }
  for (const delay of [150, 600, 1500]) {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      void pollBluetoothState()
      return GLib.SOURCE_REMOVE
    })
  }
}

// =============================================================================
// Power Profiles Daemon
// =============================================================================

export const ppdActive = createBinding(powerProfiles, "activeProfile")

export const ppdProfiles = createComputed(() => {
  return powerProfiles.get_profiles().map((p) => p.profile)
})

export function setPpdProfile(profile: string) {
  powerProfiles.set_active_profile(profile)
}

export function ppdIconNameFor(profile: string | null | undefined): string {
  switch (profile) {
    case "power-saver":
      return "leaf"
    case "performance":
      return "lightning"
    case "balanced":
      return "balanced"
    default:
      return "balanced"
  }
}

export function ppdLabel(profile: string | null | undefined): string {
  switch (profile) {
    case "power-saver":
      return "Power Saver"
    case "performance":
      return "Performance"
    case "balanced":
      return "Balanced"
    default:
      return profile && profile.length > 0 ? profile : "Unknown"
  }
}

// =============================================================================
// Notifications
// =============================================================================

export const notifDnd = createBinding(notifd, "dontDisturb")

const [notifListState, setNotifListState] = createState<AstalNotifd.Notification[]>([])
export const notifList = notifListState

function refreshNotifList() {
  const list = notifd.get_notifications().slice()
  list.sort((a, b) => b.time - a.time)
  setNotifListState(list)
}

notifd.connect("notify::notifications", refreshNotifList)
notifd.connect("notified", refreshNotifList)
notifd.connect("resolved", refreshNotifList)
refreshNotifList()

export function toggleDnd() {
  notifd.dontDisturb = !notifd.dontDisturb
}

export function dismissNotification(n: AstalNotifd.Notification) {
  n.dismiss()
}

export function dismissAllNotifications() {
  for (const n of notifd.get_notifications()) {
    n.dismiss()
  }
}

// =============================================================================
// Audio (volume)
//
// createBinding(audio, "defaultSpeaker") only picks up replacement of default_speaker,
// so changes to speaker.volume / speaker.mute aren't reflected on their own.
// If PulseAudio isn't ready right after startup, the speaker may exist but its
// volume can be read as 0, so we directly listen to the speaker's
// notify::volume / notify::mute and push into reactive state.
// =============================================================================

const [speakerVolumeState, setSpeakerVolumeState] = createState(0)
const [speakerMuteState, setSpeakerMuteState] = createState(false)

export const speakerVolume = speakerVolumeState
export const speakerMute = speakerMuteState

let currentSpeaker: import("gi://AstalWp").default.Endpoint | null = null
let currentSpeakerHandlerIds: number[] = []

function unbindSpeaker() {
  if (currentSpeaker) {
    for (const id of currentSpeakerHandlerIds) {
      try {
        currentSpeaker.disconnect(id)
      } catch {
        // ignore
      }
    }
  }
  currentSpeaker = null
  currentSpeakerHandlerIds = []
}

function bindSpeaker(s: import("gi://AstalWp").default.Endpoint | null) {
  unbindSpeaker()
  if (!s) {
    setSpeakerVolumeState(0)
    setSpeakerMuteState(false)
    return
  }
  currentSpeaker = s
  setSpeakerVolumeState(s.volume)
  setSpeakerMuteState(s.mute)
  currentSpeakerHandlerIds.push(
    s.connect("notify::volume", () => setSpeakerVolumeState(s.volume)),
  )
  currentSpeakerHandlerIds.push(
    s.connect("notify::mute", () => setSpeakerMuteState(s.mute)),
  )
}

audio.connect("notify::default-speaker", () => bindSpeaker(audio.default_speaker))
bindSpeaker(audio.default_speaker)

export function setSpeakerVolume(v: number) {
  const s = audio.default_speaker
  if (!s) return
  s.set_volume(Math.max(0, Math.min(1, v)))
}

export function toggleSpeakerMute() {
  const s = audio.default_speaker
  if (!s) return
  s.set_mute(!s.mute)
}

export function volumeIconName(): string {
  if (speakerMuteState()) return "volume-off"
  return speakerVolumeState() > 0 ? "volume" : "volume-off"
}

// =============================================================================
// Brightness (via brightnessctl — Astal has no backend lib for it)
// =============================================================================

const BACKLIGHT_PATH = "/sys/class/backlight"

function findBacklightDevice(): string | null {
  try {
    const dir = Gio.File.new_for_path(BACKLIGHT_PATH)
    const enumerator = dir.enumerate_children(
      "standard::name",
      Gio.FileQueryInfoFlags.NONE,
      null,
    )
    const info = enumerator.next_file(null)
    enumerator.close(null)
    return info ? info.get_name() : null
  } catch {
    return null
  }
}

const backlightDevice = findBacklightDevice()

function readBacklightValue(name: "brightness" | "max_brightness"): number {
  if (!backlightDevice) return 0
  try {
    const file = Gio.File.new_for_path(`${BACKLIGHT_PATH}/${backlightDevice}/${name}`)
    const [, contents] = file.load_contents(null)
    return Number.parseInt(new TextDecoder().decode(contents).trim(), 10) || 0
  } catch {
    return 0
  }
}

const maxBrightness = readBacklightValue("max_brightness") || 100

const [brightnessState, setBrightnessState] = createState(
  readBacklightValue("brightness") / maxBrightness,
)
export const brightness = brightnessState

// Write values directly via brightnessctl. Read back via 500ms polling.
let lastWrittenAt = 0
function pollBrightness() {
  // Right after a write, skip while the OS catches up (avoids flicker)
  if (Date.now() - lastWrittenAt < 1000) return
  const value = readBacklightValue("brightness") / maxBrightness
  if (Math.abs(value - brightnessState()) > 0.005) {
    setBrightnessState(value)
  }
}
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
  pollBrightness()
  return GLib.SOURCE_CONTINUE
})

export function setBrightness(v: number) {
  const clamped = Math.max(0, Math.min(1, v))
  setBrightnessState(clamped)
  lastWrittenAt = Date.now()
  const percent = Math.round(clamped * 100)
  execAsync(["brightnessctl", "set", `${percent}%`]).catch((err) => {
    console.error("[status] brightnessctl failed:", err)
  })
}

export function brightnessAvailable(): boolean {
  return backlightDevice !== null
}

// =============================================================================
// Mpris (media player)
//
// A Player's title / artist / art_url / playback_status are emitted as GObject
// notify::<prop>. Just watching playersState via createComputed only picks up
// list replacement, so for the current primary player we individually
// listen to notify::* and push into reactive state.
// =============================================================================

const [playersState, setPlayersState] = createState<AstalMpris.Player[]>([])
export const mprisPlayers = playersState

const [primaryPlayerState, setPrimaryPlayerState] =
  createState<AstalMpris.Player | null>(null)
/** Hold the raw Player for operations (play_pause / next / previous). */
export const primaryPlayer = primaryPlayerState

const [mediaTitleState, setMediaTitleState] = createState<string>("")
const [mediaArtistState, setMediaArtistState] = createState<string>("")
const [mediaArtUrlState, setMediaArtUrlState] = createState<string>("")
const [mediaPlaybackStatusState, setMediaPlaybackStatusState] =
  createState<AstalMpris.PlaybackStatus>(AstalMpris.PlaybackStatus.STOPPED)
const [mediaLengthState, setMediaLengthState] = createState<number>(0)
const [mediaCanGoNextState, setMediaCanGoNextState] = createState<boolean>(false)
const [mediaCanGoPreviousState, setMediaCanGoPreviousState] =
  createState<boolean>(false)

export const mediaTitle = mediaTitleState
export const mediaArtist = mediaArtistState
export const mediaArtUrl = mediaArtUrlState
export const mediaPlaybackStatus = mediaPlaybackStatusState
export const mediaLength = mediaLengthState
export const mediaCanGoNext = mediaCanGoNextState
export const mediaCanGoPrevious = mediaCanGoPreviousState

function syncPlayer(p: AstalMpris.Player) {
  setMediaTitleState(p.title ?? "")
  setMediaArtistState(p.artist ?? "")
  setMediaArtUrlState(p.artUrl ?? "")
  setMediaPlaybackStatusState(p.playbackStatus)
  setMediaLengthState(p.length)
  setMediaCanGoNextState(p.canGoNext)
  setMediaCanGoPreviousState(p.canGoPrevious)
}

function clearMediaState() {
  setMediaTitleState("")
  setMediaArtistState("")
  setMediaArtUrlState("")
  setMediaPlaybackStatusState(AstalMpris.PlaybackStatus.STOPPED)
  setMediaLengthState(0)
  setMediaCanGoNextState(false)
  setMediaCanGoPreviousState(false)
}

let currentPlayer: AstalMpris.Player | null = null
let currentPlayerHandlerIds: number[] = []

function unbindCurrentPlayer() {
  if (currentPlayer) {
    for (const id of currentPlayerHandlerIds) {
      try {
        currentPlayer.disconnect(id)
      } catch {
        // ignore
      }
    }
  }
  currentPlayer = null
  currentPlayerHandlerIds = []
}

function bindPlayer(p: AstalMpris.Player | null) {
  if (p === currentPlayer) return
  unbindCurrentPlayer()
  setPrimaryPlayerState(p)
  if (!p) {
    clearMediaState()
    return
  }
  currentPlayer = p
  syncPlayer(p)
  const props = [
    "notify::title",
    "notify::artist",
    "notify::art-url",
    "notify::playback-status",
    "notify::length",
    "notify::can-go-next",
    "notify::can-go-previous",
  ] as const
  for (const sig of props) {
    currentPlayerHandlerIds.push(p.connect(sig, () => syncPlayer(p)))
  }
}

function pickPrimaryPlayer(): AstalMpris.Player | null {
  const list = playersState()
  if (list.length === 0) return null
  const playing = list.find(
    (q) => q.playbackStatus === AstalMpris.PlaybackStatus.PLAYING,
  )
  return playing ?? list[0]
}

function refreshPlayers() {
  setPlayersState(mpris.get_players().slice())
  bindPlayer(pickPrimaryPlayer())
}

mpris.connect("notify::players", refreshPlayers)
mpris.connect("player-added", refreshPlayers)
mpris.connect("player-closed", refreshPlayers)
refreshPlayers()

// When playback status changes, re-pick primary too (for when multiple players exist).
// playback-status is a per-player notify, so periodically re-evaluating is
// enough. Re-check pickPrimary once per second.
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
  const next = pickPrimaryPlayer()
  if (next !== currentPlayer) bindPlayer(next)
  return GLib.SOURCE_CONTINUE
})

export function formatMprisTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00"
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0)
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
  return `${m}:${s.toString().padStart(2, "0")}`
}

// =============================================================================
// Battery (AstalBattery — over upower D-Bus. Property updates arrive reliably
// as notify, so self-polling like Wi-Fi isn't needed)
// =============================================================================

export const batteryPresent = createBinding(battery, "isPresent")
export const batteryPercentage = createBinding(battery, "percentage")
export const batteryCharging = createBinding(battery, "charging")
export const batteryState = createBinding(battery, "state")
export const batteryTimeToEmpty = createBinding(battery, "timeToEmpty")
export const batteryTimeToFull = createBinding(battery, "timeToFull")
export const batteryEnergyRate = createBinding(battery, "energyRate")
export const batteryChargeCycles = createBinding(battery, "chargeCycles")
export const batteryTemperature = createBinding(battery, "temperature")

/** Return the display SVG filename based on charge (0..1) + state.
 * While on AC (CHARGING / PENDING_CHARGE / FULLY_CHARGED), always
 * show battery-charging. The `batteryCharging` derived property is
 * false for PENDING_CHARGE, so look at state directly. */
export function batteryIconName(): string {
  const s = batteryState()
  if (
    s === AstalBattery.State.CHARGING ||
    s === AstalBattery.State.PENDING_CHARGE ||
    s === AstalBattery.State.FULLY_CHARGED
  ) {
    return "battery-charging"
  }
  const p = batteryPercentage()
  if (p >= 0.75) return "battery-full"
  if (p >= 0.4) return "battery-midium"
  if (p >= 0.15) return "battery-low"
  return "battery-very-low"
}

/** Convert upower's State enum to a human-readable string. */
export function batteryStateLabel(): string {
  switch (batteryState()) {
    case AstalBattery.State.CHARGING:
      return "Charging"
    case AstalBattery.State.DISCHARGING:
      return "Discharging"
    case AstalBattery.State.EMPTY:
      return "Empty"
    case AstalBattery.State.FULLY_CHARGED:
      return "Fully charged"
    case AstalBattery.State.PENDING_CHARGE:
      return "Pending charge"
    case AstalBattery.State.PENDING_DISCHARGE:
      return "Pending discharge"
    default:
      return "Unknown"
  }
}

/** Format as "1h 23m" (0 -> "—"). */
export function formatBatteryDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "—"
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

// =============================================================================
// CPU / memory usage. Polled from /proc every 2s (no Astal service exists for
// these). CPU usage is the busy/total jiffy delta between two samples; memory
// usage is (MemTotal - MemAvailable) / MemTotal.
// =============================================================================

const SYSTEM_POLL_MS = 2000

const [cpuUsageState, setCpuUsageState] = createState(0) // 0..1
const [memUsageState, setMemUsageState] = createState(0) // 0..1
export const cpuUsage = cpuUsageState
export const memUsage = memUsageState

// Detail values surfaced in the popovers.
const [cpuCoreCountState, setCpuCoreCountState] = createState(0)
const [loadAverageState, setLoadAverageState] = createState<
  [number, number, number]
>([0, 0, 0])
const [memTotalKbState, setMemTotalKbState] = createState(0)
const [memAvailableKbState, setMemAvailableKbState] = createState(0)
const [swapTotalKbState, setSwapTotalKbState] = createState(0)
const [swapFreeKbState, setSwapFreeKbState] = createState(0)
export const cpuCoreCount = cpuCoreCountState
export const loadAverage = loadAverageState
export const memTotalKb = memTotalKbState
export const memAvailableKb = memAvailableKbState
export const swapTotalKb = swapTotalKbState
export const swapFreeKb = swapFreeKbState

let lastCpuTotal = 0
let lastCpuIdle = 0

function readProcFile(path: string): string | null {
  try {
    const [ok, bytes] = GLib.file_get_contents(path)
    if (!ok || !bytes) return null
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

function pollCpuUsage(): void {
  const stat = readProcFile("/proc/stat")
  if (!stat) return
  // First line: "cpu  user nice system idle iowait irq softirq steal ..."
  const firstLine = stat.split("\n", 1)[0]
  const fields = firstLine.trim().split(/\s+/).slice(1).map(Number)
  if (fields.length < 5) return
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0) // idle + iowait
  const total = fields.reduce((sum, v) => sum + (isFinite(v) ? v : 0), 0)
  const deltaTotal = total - lastCpuTotal
  const deltaIdle = idle - lastCpuIdle
  lastCpuTotal = total
  lastCpuIdle = idle
  if (deltaTotal > 0) {
    setCpuUsageState(
      Math.max(0, Math.min(1, (deltaTotal - deltaIdle) / deltaTotal)),
    )
  }
}

function pollLoadAndCores(): void {
  if (cpuCoreCountState() === 0) {
    setCpuCoreCountState(GLib.get_num_processors())
  }
  const loadavg = readProcFile("/proc/loadavg")
  if (loadavg) {
    const p = loadavg.trim().split(/\s+/)
    setLoadAverageState([Number(p[0]) || 0, Number(p[1]) || 0, Number(p[2]) || 0])
  }
}

function pollMemory(): void {
  const meminfo = readProcFile("/proc/meminfo")
  if (!meminfo) return
  const values = new Map<string, number>()
  for (const line of meminfo.split("\n")) {
    const match = line.match(/^(\w+):\s+(\d+)/)
    if (match) values.set(match[1], Number(match[2]))
  }
  const total = values.get("MemTotal") ?? 0
  const available = values.get("MemAvailable") ?? 0
  setMemTotalKbState(total)
  setMemAvailableKbState(available)
  setSwapTotalKbState(values.get("SwapTotal") ?? 0)
  setSwapFreeKbState(values.get("SwapFree") ?? 0)
  if (total > 0) {
    setMemUsageState(Math.max(0, Math.min(1, (total - available) / total)))
  }
}

function pollSystemUsage(): void {
  pollCpuUsage()
  pollLoadAndCores()
  pollMemory()
}

pollSystemUsage()
GLib.timeout_add(GLib.PRIORITY_DEFAULT, SYSTEM_POLL_MS, () => {
  pollSystemUsage()
  return GLib.SOURCE_CONTINUE
})

/** Format a /proc kB value as GiB, e.g. 16261912 -> "15.5 GiB". */
export function formatKbAsGiB(kb: number): string {
  if (!isFinite(kb) || kb <= 0) return "—"
  return `${(kb / 1024 / 1024).toFixed(1)} GiB`
}
