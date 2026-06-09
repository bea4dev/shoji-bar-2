import { Astal, Gdk, Gtk } from "ags/gtk4"
import GdkPixbuf from "gi://GdkPixbuf"
import {
  createComputed,
  createRoot,
  createState,
  onCleanup,
  type Accessor,
} from "gnim"
import app from "ags/gtk4/app"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import { LayerState } from "../utils/LayerState"
import { isPointInsideWidget } from "../utils/pointInside"
import {
  accessPointRequiresPassword,
  accessPointSecurity,
  bluetoothConnect,
  bluetoothDevices,
  bluetoothDisconnect,
  bluetoothEnabled,
  bluetoothPrimary,
  bluetoothScanning,
  brightness,
  brightnessAvailable,
  dismissAllNotifications,
  focusBluetoothPolling,
  focusWifiPolling,
  setBluetoothEnabled,
  triggerBluetoothScan,
  formatMprisTime,
  mediaArtist,
  mediaArtUrl,
  mediaLength,
  mediaPlaybackStatus,
  mediaTitle,
  notifDnd,
  notifList,
  ppdActive,
  ppdIconNameFor,
  ppdLabel,
  ppdProfiles,
  primaryPlayer,
  setBrightness,
  setPpdProfile,
  setSpeakerVolume,
  setWifiEnabled,
  speakerMute,
  speakerVolume,
  toggleDnd,
  toggleSpeakerMute,
  triggerWifiScan,
  wifiAccessPoints,
  wifiConnect,
  wifiDisconnect,
  wifiEnabled,
  wifiScanning,
  wifiSsid,
  wifiStrength,
} from "../utils/statusServices"

type StatusMenuState = {
  isOpen: Accessor<boolean>
  setOpen: (open: boolean) => void
}

const LAYER_STATE = new LayerState<StatusMenuState>()

type Submenu = "wifi" | "bluetooth" | "ppd" | "notifications"

// =============================================================================
// Trigger button on the bar: shows the 7 main status icons in a row
// =============================================================================
export function StatusButton({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  // While the menu is open the whole button turns accent-colored, so white icons
  // are hard to see. Swap to the -dark variant while pressed.
  // LayerState.then returns undefined when no state is registered; in that case
  // always treat it as false (= not pressed = white icon).
  const isPressed: Accessor<boolean> =
    LAYER_STATE.then(gdkmonitor, (state) =>
      state.isOpen((isOpen) => isOpen),
    ) ?? createComputed(() => false)
  const suffix = (base: string) =>
    createComputed(() => `${SRC}/assets/${base}${isPressed() ? "-dark" : ""}.svg`)

  return (
    <button
      cssName="StatusButton"
      class={isPressed((p) => (p ? "pressed" : ""))}
      onClicked={() =>
        LAYER_STATE.then(gdkmonitor, (state) => state.setOpen(!state.isOpen()))
      }
    >
      <box cssName="StatusButtonRow" spacing={4}>
        <image
          cssName="StatusButtonIcon"
          file={createComputed(() => {
            const dark = isPressed() ? "-dark" : ""
            if (!wifiEnabled()) return `${SRC}/assets/wifi-off${dark}.svg`
            const s = wifiStrength()
            if (s >= 70) return `${SRC}/assets/wifi-full${dark}.svg`
            if (s >= 40) return `${SRC}/assets/wifi-midium${dark}.svg`
            if (s >= 10) return `${SRC}/assets/wifi-low${dark}.svg`
            return `${SRC}/assets/wifi-off${dark}.svg`
          })}
          pixelSize={14}
        />
        <image
          cssName="StatusButtonIcon"
          // When BT is off, hide the icon itself to distinguish on/off.
          visible={bluetoothEnabled}
          file={suffix("bluetooth")}
          pixelSize={14}
        />
        <image
          cssName="StatusButtonIcon"
          file={createComputed(
            () =>
              `${SRC}/assets/${ppdIconNameFor(ppdActive())}${isPressed() ? "-dark" : ""}.svg`,
          )}
          pixelSize={14}
        />
        <image
          cssName="StatusButtonIcon"
          file={createComputed(
            () =>
              `${SRC}/assets/${notifDnd() ? "bell-no" : "bell"}${isPressed() ? "-dark" : ""}.svg`,
          )}
          pixelSize={14}
        />
        <image
          cssName="StatusButtonIcon"
          file={suffix("music")}
          pixelSize={14}
        />
        <image
          cssName="StatusButtonIcon"
          file={createComputed(() => {
            const muted = speakerMute() || speakerVolume() === 0
            const base = muted ? "volume-off" : "volume"
            return `${SRC}/assets/${base}${isPressed() ? "-dark" : ""}.svg`
          })}
          pixelSize={14}
        />
        <image
          cssName="StatusButtonIcon"
          file={suffix("sun")}
          pixelSize={14}
        />
      </box>
    </button>
  )
}

// =============================================================================
// The menu itself
// =============================================================================
export function StatusMenuLayer({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  const [isOpen, setIsOpen] = createState(false)
  const [mounted, setMounted] = createState(false)
  // Default to the notifications tab right after opening; reset to default on reopen too.
  const [activeSubmenu, setActiveSubmenu] =
    createState<Submenu>("notifications")

  let openIdleId: number | null = null
  let closeTimeoutId: number | null = null

  function clearTimers() {
    if (openIdleId !== null) {
      GLib.source_remove(openIdleId)
      openIdleId = null
    }
    if (closeTimeoutId !== null) {
      GLib.source_remove(closeTimeoutId)
      closeTimeoutId = null
    }
  }

  function setOpen(open: boolean) {
    clearTimers()
    if (open) {
      setActiveSubmenu("notifications")
      setMounted(true)
      openIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        openIdleId = null
        setIsOpen(true)
        return GLib.SOURCE_REMOVE
      })
    } else {
      setIsOpen(false)
      closeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        closeTimeoutId = null
        if (!isOpen()) setMounted(false)
        return GLib.SOURCE_REMOVE
      })
    }
  }

  const states: StatusMenuState = { isOpen, setOpen }
  LAYER_STATE.set(gdkmonitor, states)

  const { TOP, LEFT, RIGHT, BOTTOM } = Astal.WindowAnchor

  const inner = (
    <box
      cssName="StatusMenu"
      class={isOpen((open) => (open ? "open" : "close"))}
      orientation={Gtk.Orientation.VERTICAL}
      halign={Gtk.Align.END}
      valign={Gtk.Align.START}
      // Also fix the size at the widget level. CSS min-height alone
      // can shrink when a child's natural size is small, so enforce it on both.
      widthRequest={380}
      heightRequest={620}
    >
      <box cssName="FirstPadding" />
      {QuickIsland(activeSubmenu, setActiveSubmenu)}
      {SlidersIsland()}
      {MediaIsland()}
    </box>
  ) as Gtk.Box

  const window = (
    <window
      name="statusmenulayer"
      class="StatusMenuLayer"
      gdkmonitor={gdkmonitor}
      layer={Astal.Layer.OVERLAY}
      exclusivity={Astal.Exclusivity.NORMAL}
      keymode={Astal.Keymode.ON_DEMAND}
      anchor={TOP | LEFT | RIGHT | BOTTOM}
      application={app}
      visible={mounted}
    >
      {inner}
    </window>
  ) as Gtk.Window

  const outsideClick = Gtk.GestureClick.new()
  outsideClick.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
  outsideClick.connect("pressed", (_g, _n, x, y) => {
    if (!isPointInsideWidget(window, inner, x, y)) {
      states.setOpen(false)
    }
  })
  window.add_controller(outsideClick)

  const keyController = Gtk.EventControllerKey.new()
  keyController.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
  keyController.connect("key-pressed", (_c, keyval) => {
    if (keyval === Gdk.KEY_Escape) {
      states.setOpen(false)
      return true
    }
    return false
  })
  window.add_controller(keyController)

  return window
}

// =============================================================================
// Top: 2x2 quick toggles + submenu
// =============================================================================
function QuickIsland(
  activeSubmenu: Accessor<Submenu>,
  setActiveSubmenu: (v: Submenu) => void,
) {
  function quickButton(
    key: Submenu,
    iconFile: Accessor<string>,
    label: Accessor<string>,
    active: Accessor<boolean>,
  ): Gtk.Widget {
    return (
      <button
        cssName="QuickButton"
        class={createComputed(() => {
          const cls: string[] = []
          if (active()) cls.push("active")
          if (activeSubmenu() === key) cls.push("expanded")
          return cls.join(" ")
        })}
        onClicked={() => {
          // Clicking the same one keeps it open (by design, one is always open)
          setActiveSubmenu(key)
        }}
      >
        <box cssName="QuickButtonInner" spacing={6}>
          <image cssName="QuickButtonIcon" file={iconFile} pixelSize={18} />
          <label
            cssName="QuickButtonLabel"
            halign={Gtk.Align.START}
            hexpand
            ellipsize={3}
            maxWidthChars={14}
            label={label}
          />
          <image
            cssName="QuickButtonArrow"
            file={createComputed(() =>
              activeSubmenu() === key
                ? `${SRC}/assets/angle-down-dark.svg`
                : `${SRC}/assets/angle-right-dark.svg`,
            )}
            pixelSize={12}
          />
        </box>
      </button>
    ) as Gtk.Widget
  }

  // Icons inside QuickButton sit on a dark theme (accent-colored background) when active,
  // so white is hard to see. Use the dedicated -dark.svg.
  const wifiBtn = quickButton(
    "wifi",
    createComputed(() => {
      if (!wifiEnabled()) return `${SRC}/assets/wifi-off-dark.svg`
      const s = wifiStrength()
      if (s >= 70) return `${SRC}/assets/wifi-full-dark.svg`
      if (s >= 40) return `${SRC}/assets/wifi-midium-dark.svg`
      if (s >= 10) return `${SRC}/assets/wifi-low-dark.svg`
      return `${SRC}/assets/wifi-off-dark.svg`
    }),
    createComputed(() => {
      if (!wifiEnabled()) return "Off"
      return wifiSsid() ?? "Not connected"
    }),
    wifiEnabled,
  )

  const btBtn = quickButton(
    "bluetooth",
    createComputed(() => `${SRC}/assets/bluetooth-dark.svg`),
    bluetoothPrimary,
    bluetoothEnabled,
  )

  const ppdBtn = quickButton(
    "ppd",
    ppdActive((p) => `${SRC}/assets/${ppdIconNameFor(p)}-dark.svg`),
    ppdActive(ppdLabel),
    createComputed(() => true),
  )

  const notifBtn = quickButton(
    "notifications",
    notifDnd(
      (dnd) => `${SRC}/assets/${dnd ? "bell-no" : "bell"}-dark.svg`,
    ),
    notifDnd((dnd) => (dnd ? "Silent" : "Notifications")),
    createComputed(() => !notifDnd()),
  )

  return (
    <box cssName="QuickIsland" orientation={Gtk.Orientation.VERTICAL}>
      <box cssName="QuickGrid" orientation={Gtk.Orientation.VERTICAL} spacing={6}>
        <box spacing={6} homogeneous>
          {wifiBtn}
          {btBtn}
        </box>
        <box spacing={6} homogeneous>
          {ppdBtn}
          {notifBtn}
        </box>
      </box>
      <box cssName="QuickSeparator" />
      {Submenu(activeSubmenu)}
    </box>
  ) as Gtk.Widget
}

// Submenu area: scrollable + fixed height
function Submenu(activeSubmenu: Accessor<Submenu>): Gtk.Widget {
  return (
    <scrolledwindow
      cssName="SubmenuScroll"
      hscrollbarPolicy={Gtk.PolicyType.NEVER}
      vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
      // With overlay the scrollbar overlaps the content and interferes with hover.
      // Set it to false so the scrollbar gets its own column.
      overlayScrolling={false}
      heightRequest={200}
    >
      <box
        cssName="SubmenuBox"
        orientation={Gtk.Orientation.VERTICAL}
        $={(self) => {
          let dispose: (() => void) | null = null
          const rebuild = () => {
            if (dispose) {
              dispose()
              dispose = null
            }
            let child = self.get_first_child()
            while (child) {
              const next = child.get_next_sibling()
              self.remove(child)
              child = next
            }
            createRoot((d) => {
              dispose = d
              const sub = activeSubmenu()
              self.append(buildSubmenuContent(sub))
            })
          }
          rebuild()
          activeSubmenu.subscribe(rebuild)
        }}
      />
    </scrolledwindow>
  ) as Gtk.Widget
}

function buildSubmenuContent(sub: Submenu): Gtk.Widget {
  switch (sub) {
    case "wifi":
      return wifiSubmenu()
    case "bluetooth":
      return bluetoothSubmenu()
    case "ppd":
      return ppdSubmenu()
    case "notifications":
      return notificationsSubmenu()
  }
}

// =============================================================================
// Wi-Fi submenu
// Switch between three internal modes (list / password entry / connecting) within one container.
// =============================================================================

type WifiView =
  | { kind: "list" }
  | {
      kind: "password"
      ssid: string
      security: string
      error?: string
    }
  | { kind: "connecting"; ssid: string }
  | { kind: "error"; ssid: string; message: string }

function wifiSubmenu(): Gtk.Widget {
  const [wifiView, setWifiView] = createState<WifiView>({ kind: "list" })

  // Raise the polling frequency while shown. Call release on submenu unmount to restore.
  const releaseFocus = focusWifiPolling()
  onCleanup(releaseFocus)

  // Trigger a rescan when shown
  void triggerWifiScan()

  // ON/OFF toggle row (Gtk.Switch). Bind active to wifiEnabled, but
  // even if active changes due to an external factor (polling) and notify::active fires,
  // do nothing when desired === current, preventing recursive calls.
  const toggleRow = (
    <box cssName="WifiToggleRow" spacing={6}>
      <label
        cssName="WifiToggleLabel"
        halign={Gtk.Align.START}
        hexpand
        label={wifiEnabled((on) => (on ? "Wi-Fi" : "Wi-Fi (off)"))}
      />
      <switch
        cssName="WifiSwitch"
        valign={Gtk.Align.CENTER}
        active={wifiEnabled}
        onNotifyActive={(self) => {
          const desired = self.active
          if (desired !== wifiEnabled()) {
            void setWifiEnabled(desired)
          }
        }}
      />
    </box>
  ) as Gtk.Widget

  // Action row: rescan / disconnect.
  // Rescan: label changes + disabled while scanning.
  // Disconnect: disabled unless connected.
  const actionsRow = (
    <box cssName="WifiActionsRow" spacing={6} halign={Gtk.Align.END}>
      <button
        cssName="WifiActionButton"
        sensitive={createComputed(() => wifiEnabled() && !wifiScanning())}
        onClicked={() => void triggerWifiScan()}
      >
        <label label={wifiScanning((s) => (s ? "Scanning..." : "Rescan"))} />
      </button>
      <button
        cssName="WifiActionButton"
        sensitive={createComputed(() => wifiSsid() !== null)}
        onClicked={() => wifiDisconnect()}
      >
        <label
          label={wifiSsid((s) =>
            s ? `Disconnect "${s}"` : "Disconnect",
          )}
        />
      </button>
    </box>
  ) as Gtk.Widget

  // Switchable content area
  const content = (
    <box
      cssName="WifiContent"
      orientation={Gtk.Orientation.VERTICAL}
      spacing={4}
      $={(self) => {
        let dispose: (() => void) | null = null
        const rebuild = () => {
          if (dispose) {
            dispose()
            dispose = null
          }
          let child = self.get_first_child()
          while (child) {
            const next = child.get_next_sibling()
            self.remove(child)
            child = next
          }
          createRoot((d) => {
            dispose = d
            const v = wifiView()
            if (v.kind === "list") {
              self.append(buildWifiList(setWifiView))
            } else if (v.kind === "password") {
              self.append(buildWifiPasswordForm(v, setWifiView))
            } else if (v.kind === "connecting") {
              self.append(buildWifiConnecting(v))
            } else if (v.kind === "error") {
              self.append(buildWifiError(v, setWifiView))
            }
          })
        }
        rebuild()
        onCleanup(wifiView.subscribe(rebuild))
        onCleanup(wifiAccessPoints.subscribe(rebuild))
        onCleanup(wifiSsid.subscribe(rebuild))
      }}
    />
  ) as Gtk.Widget

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
      {toggleRow}
      {actionsRow}
      {content}
    </box>
  ) as Gtk.Widget
}

function buildWifiList(setWifiView: (v: WifiView) => void): Gtk.Widget {
  const list = (
    <box cssName="SubmenuList" orientation={Gtk.Orientation.VERTICAL} />
  ) as Gtk.Box

  if (!wifiEnabled()) {
    list.append(
      (
        <label
          cssName="SubmenuEmpty"
          halign={Gtk.Align.CENTER}
          label="Wi-Fi is off"
        />
      ) as Gtk.Widget,
    )
    return list
  }

  const aps = wifiAccessPoints()
  if (aps.length === 0) {
    list.append(
      (
        <label
          cssName="SubmenuEmpty"
          halign={Gtk.Align.CENTER}
          label="Scanning..."
        />
      ) as Gtk.Widget,
    )
    return list
  }

  const currentSsid = wifiSsid()

  for (const ap of aps) {
    // APs may be GC'd between scans, so snapshot the values the UI needs, and
    // re-fetch the AP by SSID on click. The closure doesn't hold ap directly.
    let ssid: string | null = null
    let strength = 0
    let requiresPw = false
    let security = "Unknown"
    try {
      ssid = ap.ssid ?? null
      strength = Math.round(ap.strength ?? 0)
      requiresPw = accessPointRequiresPassword(ap)
      security = accessPointSecurity(ap)
    } catch {
      continue
    }
    if (!ssid) continue
    const ssidValue = ssid
    const isCurrent = ssid === currentSsid

    list.append(
      (
        <button
          cssName="SubmenuRow"
          class={isCurrent ? "active" : ""}
          onClicked={() => {
            if (isCurrent) {
              wifiDisconnect()
              return
            }
            // Expecting known/open, first activate without a password.
            // On failure, go to password mode via needsPassword.
            if (!requiresPw) {
              setWifiView({ kind: "connecting", ssid: ssidValue })
              wifiConnect(ssidValue).then((res) => {
                if (res.ok) {
                  setWifiView({ kind: "list" })
                } else if (res.needsPassword) {
                  setWifiView({ kind: "password", ssid: ssidValue, security })
                } else {
                  setWifiView({
                    kind: "error",
                    ssid: ssidValue,
                    message: res.message ?? "Failed",
                  })
                }
              })
            } else {
              // For encrypted networks, try without a password first; if saved, it just connects
              setWifiView({ kind: "connecting", ssid: ssidValue })
              wifiConnect(ssidValue).then((res) => {
                if (res.ok) {
                  setWifiView({ kind: "list" })
                } else if (res.needsPassword) {
                  setWifiView({ kind: "password", ssid: ssidValue, security })
                } else {
                  setWifiView({
                    kind: "error",
                    ssid: ssidValue,
                    message: res.message ?? "Failed",
                  })
                }
              })
            }
          }}
        >
          <box spacing={8}>
            <label
              cssName="SubmenuRowLabel"
              halign={Gtk.Align.START}
              hexpand
              ellipsize={3}
              label={ssid}
            />
            <label
              cssName="SubmenuRowSub"
              halign={Gtk.Align.END}
              label={
                isCurrent
                  ? `${strength}% · Connected`
                  : `${strength}% · ${security}`
              }
            />
          </box>
        </button>
      ) as Gtk.Widget,
    )
  }

  return list
}

function buildWifiPasswordForm(
  v: Extract<WifiView, { kind: "password" }>,
  setWifiView: (v: WifiView) => void,
): Gtk.Widget {
  const entry = new Gtk.PasswordEntry()
  entry.placeholderText = "Password"
  entry.showPeekIcon = true
  entry.add_css_class("WifiPasswordEntry")

  const submit = () => {
    const password = entry.get_text()
    if (!password || password.length === 0) {
      return
    }
    setWifiView({ kind: "connecting", ssid: v.ssid })
    wifiConnect(v.ssid, password).then((res) => {
      if (res.ok) {
        setWifiView({ kind: "list" })
      } else if (res.needsPassword) {
        setWifiView({
          kind: "password",
          ssid: v.ssid,
          security: v.security,
          error: "Incorrect password",
        })
      } else {
        setWifiView({
          kind: "error",
          ssid: v.ssid,
          message: res.message ?? "Failed",
        })
      }
    })
  }

  entry.connect("activate", submit)

  return (
    <box
      cssName="WifiPasswordForm"
      orientation={Gtk.Orientation.VERTICAL}
      spacing={6}
    >
      <label
        cssName="WifiFormHeading"
        halign={Gtk.Align.START}
        label={`Connect to "${v.ssid}"`}
      />
      <label
        cssName="WifiFormSub"
        halign={Gtk.Align.START}
        label={`Security: ${v.security}`}
      />
      {entry}
      {v.error ? (
        <label cssName="WifiFormError" halign={Gtk.Align.START} label={v.error} />
      ) : null}
      <box halign={Gtk.Align.END} spacing={6}>
        <button
          cssName="WifiFormCancel"
          onClicked={() => setWifiView({ kind: "list" })}
        >
          <label label="Cancel" />
        </button>
        <button cssName="WifiFormConnect" onClicked={submit}>
          <label label="Connect" />
        </button>
      </box>
    </box>
  ) as Gtk.Widget
}

function buildWifiConnecting(
  v: Extract<WifiView, { kind: "connecting" }>,
): Gtk.Widget {
  return (
    <box
      cssName="WifiConnecting"
      orientation={Gtk.Orientation.VERTICAL}
      halign={Gtk.Align.CENTER}
      valign={Gtk.Align.CENTER}
      spacing={6}
    >
      <Gtk.Spinner spinning />
      <label
        cssName="WifiConnectingLabel"
        label={`Connecting to "${v.ssid}"...`}
      />
    </box>
  ) as Gtk.Widget
}

function buildWifiError(
  v: Extract<WifiView, { kind: "error" }>,
  setWifiView: (v: WifiView) => void,
): Gtk.Widget {
  return (
    <box
      cssName="WifiErrorForm"
      orientation={Gtk.Orientation.VERTICAL}
      spacing={6}
    >
      <label
        cssName="WifiFormHeading"
        halign={Gtk.Align.START}
        label={`Failed to connect to "${v.ssid}"`}
      />
      <label
        cssName="WifiFormError"
        halign={Gtk.Align.START}
        ellipsize={3}
        maxWidthChars={48}
        label={v.message}
      />
      <box halign={Gtk.Align.END} spacing={6}>
        <button
          cssName="WifiFormCancel"
          onClicked={() => setWifiView({ kind: "list" })}
        >
          <label label="Back" />
        </button>
      </box>
    </box>
  ) as Gtk.Widget
}

type BtView =
  | { kind: "list" }
  | { kind: "connecting"; mac: string; name: string }
  | { kind: "error"; mac: string; name: string; message: string }

function bluetoothSubmenu(): Gtk.Widget {
  const [btView, setBtView] = createState<BtView>({ kind: "list" })

  // Raise the polling frequency while shown.
  const releaseFocus = focusBluetoothPolling()
  onCleanup(releaseFocus)

  // Start a scan when shown (no-op if currently off / already scanning).
  void triggerBluetoothScan()

  // ON/OFF toggle. Shares the same style via the same class name as Wifi.
  const toggleRow = (
    <box cssName="WifiToggleRow" spacing={6}>
      <label
        cssName="WifiToggleLabel"
        halign={Gtk.Align.START}
        hexpand
        label={bluetoothEnabled((on) => (on ? "Bluetooth" : "Bluetooth (off)"))}
      />
      <switch
        cssName="WifiSwitch"
        valign={Gtk.Align.CENTER}
        active={bluetoothEnabled}
        onNotifyActive={(self) => {
          const desired = self.active
          if (desired !== bluetoothEnabled()) {
            void setBluetoothEnabled(desired)
          }
        }}
      />
    </box>
  ) as Gtk.Widget

  // Action row: rescan only (BT allows multiple simultaneous connections, so no global disconnect).
  const actionsRow = (
    <box cssName="WifiActionsRow" spacing={6} halign={Gtk.Align.END}>
      <button
        cssName="WifiActionButton"
        sensitive={createComputed(
          () => bluetoothEnabled() && !bluetoothScanning(),
        )}
        onClicked={() => void triggerBluetoothScan()}
      >
        <label
          label={bluetoothScanning((s) => (s ? "Scanning..." : "Rescan"))}
        />
      </button>
    </box>
  ) as Gtk.Widget

  const content = (
    <box
      cssName="WifiContent"
      orientation={Gtk.Orientation.VERTICAL}
      spacing={4}
      $={(self) => {
        let dispose: (() => void) | null = null
        const rebuild = () => {
          if (dispose) {
            dispose()
            dispose = null
          }
          let child = self.get_first_child()
          while (child) {
            const next = child.get_next_sibling()
            self.remove(child)
            child = next
          }
          createRoot((d) => {
            dispose = d
            const v = btView()
            if (v.kind === "list") {
              self.append(buildBtList(setBtView))
            } else if (v.kind === "connecting") {
              self.append(buildBtConnecting(v))
            } else if (v.kind === "error") {
              self.append(buildBtError(v, setBtView))
            }
          })
        }
        rebuild()
        onCleanup(btView.subscribe(rebuild))
        onCleanup(bluetoothDevices.subscribe(rebuild))
        onCleanup(bluetoothEnabled.subscribe(rebuild))
      }}
    />
  ) as Gtk.Widget

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={6}>
      {toggleRow}
      {actionsRow}
      {content}
    </box>
  ) as Gtk.Widget
}

function buildBtList(setBtView: (v: BtView) => void): Gtk.Widget {
  const list = (
    <box cssName="SubmenuList" orientation={Gtk.Orientation.VERTICAL} />
  ) as Gtk.Box

  if (!bluetoothEnabled()) {
    list.append(
      (
        <label
          cssName="SubmenuEmpty"
          halign={Gtk.Align.CENTER}
          label="Bluetooth is off"
        />
      ) as Gtk.Widget,
    )
    return list
  }

  const devs = bluetoothDevices()
  if (devs.length === 0) {
    list.append(
      (
        <label
          cssName="SubmenuEmpty"
          halign={Gtk.Align.CENTER}
          label="Scanning..."
        />
      ) as Gtk.Widget,
    )
    return list
  }

  for (const dev of devs) {
    const isConnected = dev.connected
    const status = isConnected
      ? "Connected"
      : dev.paired
        ? "Paired"
        : "Available"

    list.append(
      (
        <button
          cssName="SubmenuRow"
          class={isConnected ? "active" : ""}
          onClicked={() => {
            if (isConnected) {
              void bluetoothDisconnect(dev.mac)
              return
            }
            setBtView({ kind: "connecting", mac: dev.mac, name: dev.name })
            bluetoothConnect(dev.mac).then((res) => {
              if (res.ok) {
                setBtView({ kind: "list" })
              } else {
                setBtView({
                  kind: "error",
                  mac: dev.mac,
                  name: dev.name,
                  message: res.message ?? "Failed",
                })
              }
            })
          }}
        >
          <box spacing={8}>
            <label
              cssName="SubmenuRowLabel"
              halign={Gtk.Align.START}
              hexpand
              ellipsize={3}
              label={dev.name}
            />
            <label
              cssName="SubmenuRowSub"
              halign={Gtk.Align.END}
              label={status}
            />
          </box>
        </button>
      ) as Gtk.Widget,
    )
  }

  return list
}

function buildBtConnecting(
  v: Extract<BtView, { kind: "connecting" }>,
): Gtk.Widget {
  return (
    <box
      cssName="WifiConnecting"
      orientation={Gtk.Orientation.VERTICAL}
      halign={Gtk.Align.CENTER}
      valign={Gtk.Align.CENTER}
      spacing={6}
    >
      <Gtk.Spinner spinning />
      <label
        cssName="WifiConnectingLabel"
        label={`Connecting to "${v.name}"...`}
      />
    </box>
  ) as Gtk.Widget
}

function buildBtError(
  v: Extract<BtView, { kind: "error" }>,
  setBtView: (v: BtView) => void,
): Gtk.Widget {
  return (
    <box
      cssName="WifiErrorForm"
      orientation={Gtk.Orientation.VERTICAL}
      spacing={6}
    >
      <label
        cssName="WifiFormHeading"
        halign={Gtk.Align.START}
        label={`Failed to connect to "${v.name}"`}
      />
      <label
        cssName="WifiFormError"
        halign={Gtk.Align.START}
        ellipsize={3}
        maxWidthChars={48}
        label={v.message}
      />
      <box halign={Gtk.Align.END} spacing={6}>
        <button
          cssName="WifiFormCancel"
          onClicked={() => setBtView({ kind: "list" })}
        >
          <label label="Back" />
        </button>
      </box>
    </box>
  ) as Gtk.Widget
}

function ppdSubmenu(): Gtk.Widget {
  const list = (
    <box cssName="SubmenuList" orientation={Gtk.Orientation.VERTICAL} spacing={2} />
  ) as Gtk.Box
  let dispose: (() => void) | null = null
  const rebuild = () => {
    if (dispose) {
      dispose()
      dispose = null
    }
    let child = list.get_first_child()
    while (child) {
      const next = child.get_next_sibling()
      list.remove(child)
      child = next
    }
    createRoot((d) => {
      dispose = d
      const active = ppdActive()
      for (const p of ppdProfiles()) {
        list.append(
          (
            <button
              cssName="SubmenuRow"
              class={p === active ? "active" : ""}
              onClicked={() => setPpdProfile(p)}
            >
              <box spacing={8}>
                <image
                  cssName="SubmenuRowIcon"
                  file={`${SRC}/assets/${ppdIconNameFor(p)}.svg`}
                  pixelSize={16}
                />
                <label
                  cssName="SubmenuRowLabel"
                  halign={Gtk.Align.START}
                  hexpand
                  label={ppdLabel(p)}
                />
              </box>
            </button>
          ) as Gtk.Widget,
        )
      }
    })
  }
  rebuild()
  onCleanup(ppdActive.subscribe(rebuild))
  onCleanup(ppdProfiles.subscribe(rebuild))

  return list
}

function notificationsSubmenu(): Gtk.Widget {
  const header = (
    <box cssName="SubmenuHeader" spacing={6}>
      <label
        cssName="SubmenuHeaderLabel"
        halign={Gtk.Align.START}
        hexpand
        label={createComputed(() => `Notifications (${notifList().length})`)}
      />
      <button
        cssName="SubmenuHeaderAction"
        onClicked={toggleDnd}
      >
        <label label={notifDnd((dnd) => (dnd ? "Unmute" : "Silent"))} />
      </button>
      <button
        cssName="SubmenuHeaderAction"
        onClicked={dismissAllNotifications}
      >
        <label label="Clear" />
      </button>
    </box>
  ) as Gtk.Widget

  const list = (
    <box cssName="SubmenuList" orientation={Gtk.Orientation.VERTICAL} spacing={2} />
  ) as Gtk.Box

  // Wrap in Gtk.Revealer for height collapse, and let CSS handle translateX + opacity.
  // Running both in parallel lets the Revealer's SLIDE_DOWN dominate and
  // hide the CSS transition, so **serialize the order**:
  //   enter: expand Revealer -> after it completes, remove the entering class (CSS slide-in)
  //   leave: add the leaving class (CSS slide-out) -> after it completes, collapse the Revealer
  //          -> remove from the DOM after it completes
  //
  // To be robust against state changes mid-animation, issue a token per id, and each async step
  // checks "is my token still the latest?" right before proceeding. When a new
  // action (e.g. dismiss during enter) updates the token, the old callback
  // simply no-ops.
  const NOTIF_ANIM_MS = 240
  const revealerById = new Map<number, Gtk.Revealer>()
  const animTokenById = new Map<number, number>()
  // Dispose of the reactive scope dedicated to each revealer (= notif row JSX).
  // onClicked etc. call onCleanup internally during JSX construction, so we establish a
  // tracking context with createRoot (reconcile is called via the subscribe
  // callback, so there's no active scope outside here).
  const disposeById = new Map<number, () => void>()
  let tokenCounter = 0
  let emptyLabel: Gtk.Widget | null = null

  function bumpToken(id: number): number {
    tokenCounter += 1
    animTokenById.set(id, tokenCounter)
    return tokenCounter
  }
  function tokenValid(id: number, token: number): boolean {
    return animTokenById.get(id) === token
  }

  function createEmptyLabel(): Gtk.Widget {
    return (
      <label
        cssName="SubmenuEmpty"
        halign={Gtk.Align.CENTER}
        label="No notifications"
      />
    ) as Gtk.Widget
  }

  function createRevealerForNotif(
    n: import("gi://AstalNotifd").default.Notification,
  ): Gtk.Revealer {
    const row = notificationRow(n)
    row.add_css_class("entering")
    const revealer = new Gtk.Revealer({
      // SLIDE_DOWN: the Revealer's own allocation animates from 0 -> natural height, so
      // surrounding rows shift up/down naturally. With CROSSFADE only opacity changes, no height,
      // so the slide on add/remove didn't happen.
      transitionType: Gtk.RevealerTransitionType.SLIDE_DOWN,
      transitionDuration: NOTIF_ANIM_MS,
      revealChild: false,
    })
    revealer.set_child(row)
    return revealer
  }

  function startEnter(id: number, revealer: Gtk.Revealer) {
    const token = bumpToken(id)
    const child = revealer.get_child()
    if (child) {
      // In case it was in the leaving state, revert it. entering is already set by createRevealerForNotif.
      child.remove_css_class("leaving")
      child.add_css_class("entering")
    }
    // Phase 1: expand the Revealer (height 0 -> natural).
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (!tokenValid(id, token)) return GLib.SOURCE_REMOVE
      revealer.set_reveal_child(true)
      // Phase 2: start the CSS slide-in after the Revealer finishes expanding.
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, NOTIF_ANIM_MS + 20, () => {
        if (!tokenValid(id, token)) return GLib.SOURCE_REMOVE
        const c = revealer.get_child()
        if (c) c.remove_css_class("entering")
        return GLib.SOURCE_REMOVE
      })
      return GLib.SOURCE_REMOVE
    })
  }

  function startLeave(id: number, revealer: Gtk.Revealer) {
    const token = bumpToken(id)
    const child = revealer.get_child()
    if (child) {
      // If mid-entering, cancel the entrance and switch to leaving. The CSS transition
      // runs between translateX(0) <-> translateX(48).
      child.remove_css_class("entering")
      child.add_css_class("leaving")
    }
    // Phase 1: wait for the CSS slide-out to finish.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, NOTIF_ANIM_MS + 20, () => {
      if (!tokenValid(id, token)) return GLib.SOURCE_REMOVE
      // Phase 2: collapse the Revealer (natural -> 0). Surrounding rows slide up.
      revealer.set_reveal_child(false)
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, NOTIF_ANIM_MS + 20, () => {
        if (!tokenValid(id, token)) return GLib.SOURCE_REMOVE
        // Phase 3: remove from the DOM + dispose the reactive scope.
        try {
          list.remove(revealer)
        } catch {
          // already removed
        }
        const dispose = disposeById.get(id)
        if (dispose) {
          dispose()
          disposeById.delete(id)
        }
        animTokenById.delete(id)
        return GLib.SOURCE_REMOVE
      })
      return GLib.SOURCE_REMOVE
    })
  }

  function reconcile() {
    const items = notifList()
    const itemIds = new Set(items.map((n) => n.id))

    // 1. Apply the leave animation to removed notifications
    for (const [id, revealer] of [...revealerById]) {
      if (!itemIds.has(id)) {
        startLeave(id, revealer)
        revealerById.delete(id)
      }
    }

    // 2. Toggle the empty-state display
    if (items.length === 0) {
      if (!emptyLabel) {
        emptyLabel = createEmptyLabel()
        list.append(emptyLabel)
      }
    } else if (emptyLabel) {
      try {
        list.remove(emptyLabel)
      } catch {
        // ignore
      }
      emptyLabel = null
    }

    // 3. Insert new notifications in items order (existing ones keep their position)
    let prev: Gtk.Revealer | null = null
    for (const n of items) {
      const existing = revealerById.get(n.id)
      if (existing) {
        prev = existing
        continue
      }
      // A reactive scope per row. onCleanup inside the JSX binds here.
      // The scope is disposed in startLeave's Phase 3 (DOM removal).
      let revealer!: Gtk.Revealer
      createRoot((dispose) => {
        revealer = createRevealerForNotif(n)
        disposeById.set(n.id, dispose)
      })
      if (prev) {
        list.insert_child_after(revealer, prev)
      } else {
        list.prepend(revealer)
      }
      revealerById.set(n.id, revealer)
      prev = revealer
      startEnter(n.id, revealer)
    }
  }

  reconcile()
  onCleanup(notifList.subscribe(reconcile))
  // When the submenu itself is dropped, also free scopes still lingering mid-leave-animation.
  onCleanup(() => {
    for (const d of disposeById.values()) {
      try { d() } catch { /* ignore */ }
    }
    disposeById.clear()
  })

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={4}>
      {header}
      {list}
    </box>
  ) as Gtk.Widget
}

const NOTIF_ICON_SIZE = 40

/**
 * Scale the given file path to 40x40 and load it into a Gtk.Image.
 * Return true on success. Return false on failure (missing file / non-image / invalid path).
 */
function tryLoadFileAsImage(img: Gtk.Image, path: string): boolean {
  try {
    if (!path) return false
    // Pre-check existence just in case (a GError dump on failure is noisy on the ags side)
    const file = Gio.File.new_for_path(path)
    if (!file.query_exists(null)) return false
    const scale = img.get_scale_factor() || 1
    const target = NOTIF_ICON_SIZE * scale * 2
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
      path,
      target,
      target,
      true,
    )
    if (!pixbuf) return false
    img.set_from_paintable(Gdk.Texture.new_for_pixbuf(pixbuf))
    return true
  } catch {
    return false
  }
}

/**
 * Confirm the given icon name exists in the current theme before setting it.
 * Return false when not found so the caller proceeds to the fallback.
 */
function tryLoadIconName(img: Gtk.Image, iconName: string): boolean {
  try {
    if (!iconName) return false
    const display = Gdk.Display.get_default()
    if (!display) return false
    const theme = Gtk.IconTheme.get_for_display(display)
    if (!theme.has_icon(iconName)) return false
    img.set_from_icon_name(iconName)
    return true
  } catch {
    return false
  }
}

function buildNotifIcon(
  n: import("gi://AstalNotifd").default.Notification,
): Gtk.Widget {
  const img = (
    <image cssName="NotifIcon" pixelSize={NOTIF_ICON_SIZE} />
  ) as Gtk.Image

  const image = (() => {
    try {
      return n.image ?? null
    } catch {
      return null
    }
  })()
  const appIcon = (() => {
    try {
      return n.appIcon || null
    } catch {
      return null
    }
  })()

  // Fallback chain:
  //   1. n.image as file path
  //   2. n.image as icon name (only when it exists in the theme)
  //   3. n.appIcon as file path
  //   4. n.appIcon as icon name (only when it exists in the theme)
  // If all fail, a transparent spacer. Don't show GTK's generic broken icon.

  const candidates: string[] = []
  if (image) candidates.push(image)
  if (appIcon && appIcon !== image) candidates.push(appIcon)

  for (const c of candidates) {
    // Don't load http(s) URLs (we don't fetch synchronously)
    if (/^https?:\/\//i.test(c)) continue

    // file:// or an absolute path: read as a file
    if (c.startsWith("file://") || c.startsWith("/")) {
      const path = c.startsWith("file://") ? c.replace(/^file:\/\//, "") : c
      if (tryLoadFileAsImage(img, path)) return img
      continue
    }

    // Otherwise (e.g. "kitty", "firefox") resolve as a theme icon name
    if (tryLoadIconName(img, c)) return img
  }

  return (
    <box
      cssName="NotifIcon NotifIconEmpty"
      widthRequest={NOTIF_ICON_SIZE}
      heightRequest={NOTIF_ICON_SIZE}
    />
  ) as Gtk.Widget
}

export function notificationRow(
  n: import("gi://AstalNotifd").default.Notification,
): Gtk.Widget {
  const ageLabel = (() => {
    const seconds = Math.max(0, Math.floor(Date.now() / 1000 - n.time))
    if (seconds < 60) return "now"
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
    return `${Math.floor(seconds / 86400)}d`
  })()

  // Notification actions. "default" is assigned to body click, so it is not shown as a button.
  const visibleActions = (() => {
    try {
      return n.actions.filter((a) => a.id !== "default")
    } catch {
      return []
    }
  })()
  const hasDefaultAction = (() => {
    try {
      return n.actions.some((a) => a.id === "default")
    } catch {
      return false
    }
  })()

  function invokeAction(id: string) {
    try {
      n.invoke(id)
    } catch (err) {
      console.error("[notif] invoke failed:", err)
    }
    // freedesktop spec: dismiss after an action by default (resident hint not supported).
    try {
      n.dismiss()
    } catch {
      // ignore
    }
  }

  // A gesture that fires the default action on a whole-row click; clicks on the close /
  // action buttons are excluded, so collect references to the child buttons here.
  const innerButtons: Gtk.Widget[] = []
  const actionsRow =
    visibleActions.length > 0 ? (
      <box cssName="NotifActions" spacing={6} halign={Gtk.Align.END}>
        {visibleActions.map((a) => (
          <button
            cssName="NotifActionButton"
            onClicked={() => invokeAction(a.id)}
            $={(self) => innerButtons.push(self)}
          >
            <label label={a.label || a.id} />
          </button>
        ))}
      </box>
    ) : null

  const row = (
    <box
      cssName="NotifRow"
      class={hasDefaultAction ? "clickable" : ""}
      orientation={Gtk.Orientation.VERTICAL}
      spacing={6}
    >
      <box cssName="NotifRowTop" spacing={8}>
        {buildNotifIcon(n)}
        <box
          cssName="NotifRowText"
          orientation={Gtk.Orientation.VERTICAL}
          hexpand
        >
          <box spacing={6}>
            <label
              cssName="NotifAppName"
              halign={Gtk.Align.START}
              hexpand
              ellipsize={3}
              label={n.app_name || "Notification"}
            />
            <label
              cssName="NotifAge"
              halign={Gtk.Align.END}
              label={ageLabel}
            />
          </box>
          {n.summary ? (
            <label
              cssName="NotifSummary"
              halign={Gtk.Align.START}
              ellipsize={3}
              maxWidthChars={36}
              label={n.summary}
            />
          ) : null}
          {n.body ? (
            <label
              cssName="NotifBody"
              halign={Gtk.Align.START}
              wrap
              maxWidthChars={42}
              label={n.body}
            />
          ) : null}
        </box>
        <button
          cssName="NotifCloseButton"
          valign={Gtk.Align.START}
          onClicked={() => {
            try {
              n.dismiss()
            } catch {
              // ignore
            }
          }}
          $={(self) => innerButtons.push(self)}
        >
          <label label="×" />
        </button>
      </box>
      {actionsRow}
    </box>
  ) as Gtk.Box

  // Fire the default action on a body click (= whole-row click).
  // "pressed" fires before the child button can claim it, so use pick to
  // get the real click target, and do nothing if it's under the close / action button.
  if (hasDefaultAction) {
    const gesture = Gtk.GestureClick.new()
    gesture.set_button(Gdk.BUTTON_PRIMARY)
    gesture.connect("pressed", (_g, _nPress, x, y) => {
      const picked = row.pick(x, y, Gtk.PickFlags.DEFAULT)
      if (picked) {
        for (const btn of innerButtons) {
          if (picked === btn || (picked as Gtk.Widget).is_ancestor(btn)) {
            return
          }
        }
      }
      invokeAction("default")
    })
    row.add_controller(gesture)
  }

  return row
}

// =============================================================================
// Middle: Volume + Brightness
// =============================================================================
function SlidersIsland(): Gtk.Widget {
  return (
    <box cssName="SlidersIsland" orientation={Gtk.Orientation.VERTICAL} spacing={0}>
      {sliderRow(
        createComputed(() =>
          speakerMute() || speakerVolume() === 0
            ? `${SRC}/assets/volume-off.svg`
            : `${SRC}/assets/volume.svg`,
        ),
        speakerVolume,
        (v) => setSpeakerVolume(v),
        () => toggleSpeakerMute(),
      )}
      {brightnessAvailable()
        ? sliderRow(
            createComputed(() => `${SRC}/assets/sun.svg`),
            brightness,
            (v) => setBrightness(v),
            () => {},
          )
        : null}
    </box>
  ) as Gtk.Widget
}

function sliderRow(
  iconFile: Accessor<string>,
  value: Accessor<number>,
  onChange: (v: number) => void,
  onIconClick: () => void,
): Gtk.Widget {
  const slider = new Gtk.Scale({
    orientation: Gtk.Orientation.HORIZONTAL,
    hexpand: true,
    drawValue: false,
  })
  slider.set_range(0, 1)
  slider.set_increments(0.05, 0.1)
  slider.set_value(value())
  slider.add_css_class("StatusSlider")

  let lock = false
  value.subscribe(() => {
    if (lock) return
    lock = true
    slider.set_value(value())
    lock = false
  })
  slider.connect("value-changed", () => {
    if (lock) return
    lock = true
    onChange(slider.get_value())
    lock = false
  })

  // Format a 0..1 value as a 3-digit right-aligned "  0" / " 50" / "100". Combined with a
  // monospace font, the label width stays stable as the value changes so the slider position
  // doesn't move.
  const valueLabel = value((v) => {
    const n = Math.round(Math.max(0, Math.min(1, v)) * 100)
    return n.toString().padStart(3, " ")
  })

  return (
    <box cssName="SliderRow" spacing={6}>
      <button cssName="SliderIcon" onClicked={onIconClick}>
        <image file={iconFile} pixelSize={14} />
      </button>
      <label cssName="SliderValue" label={valueLabel} />
      {slider}
    </box>
  ) as Gtk.Widget
}

// =============================================================================
// Bottom: media player
// =============================================================================
function MediaIsland(): Gtk.Widget {
  // Each display element reads from notify-based reactive state.
  // (mediaTitle / mediaArtist / mediaArtUrl / mediaPlaybackStatus / mediaLength)
  const titleLabel = createComputed(() => {
    const t = mediaTitle()
    return t || (primaryPlayer() ? "(no title)" : "No media")
  })
  const artistLabel = createComputed(() => {
    const a = mediaArtist()
    return a || (primaryPlayer() ? "" : "Open a player")
  })
  const artFile = createComputed<Gio.File | null>(() => {
    const url = mediaArtUrl()
    if (!url) return null
    if (url.startsWith("file://")) return Gio.File.new_for_uri(url)
    if (url.startsWith("/")) return Gio.File.new_for_path(url)
    return null
  })

  // Many players don't emit notify for position, so poll with a 1Hz tick.
  const [tick, setTick] = createState(0)
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
    setTick(tick() + 1)
    return GLib.SOURCE_CONTINUE
  })

  const positionLabel = createComputed(() => {
    tick()
    const p = primaryPlayer()
    return p ? formatMprisTime(p.position) : "0:00"
  })
  const lengthLabel = createComputed(() =>
    formatMprisTime(mediaLength()),
  )
  const progress = createComputed(() => {
    tick()
    const p = primaryPlayer()
    const len = mediaLength()
    if (!p || len <= 0) return 0
    return Math.max(0, Math.min(1, p.position / len))
  })

  // art image。
  // Note: with Gtk.Picture the paintable's intrinsic size directly drives the widget's natural
  // size, so a large image inflates MediaIsland and pushes the whole menu up.
  // Gtk.Image, with pixel_size set, fixes natural=pixel_size regardless of the paintable size,
  // so draw with that instead.
  const ART_SIZE_PX = 72
  const artImage = (
    <image cssName="MediaArt" pixelSize={ART_SIZE_PX} />
  ) as Gtk.Image

  // Fallback image when art is missing / fails to load. Leaving it blank leaves a black
  // frame that looks broken, so place the asset's music icon.
  function applyFallback() {
    artImage.set_from_file(`${SRC}/assets/music.svg`)
  }

  function applyArt(file: Gio.File | null) {
    if (!file) {
      applyFallback()
      return
    }
    const path = file.get_path()
    if (!path) {
      applyFallback()
      return
    }
    try {
      // Even with a fixed pixel_size, reading the large original as-is is wasteful, so
      // shrink it to about 144x144 (HiDPI 2x) at load time too.
      const scale = artImage.get_scale_factor() || 1
      const target = ART_SIZE_PX * scale * 2
      const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
        path,
        target,
        target,
        true,
      )
      if (pixbuf) {
        artImage.set_from_paintable(Gdk.Texture.new_for_pixbuf(pixbuf))
      } else {
        applyFallback()
      }
    } catch (err) {
      console.error("[status] media art load failed:", err)
      applyFallback()
    }
  }
  applyArt(artFile())
  artFile.subscribe(() => applyArt(artFile()))

  // A seekable Gtk.Scale. change-value fires only on user interaction (drag / scroll /
  // key input). It doesn't fire when set_value is called programmatically,
  // so position-polling updates and input events are cleanly separated.
  const seekScale = new Gtk.Scale({
    orientation: Gtk.Orientation.HORIZONTAL,
    hexpand: true,
    drawValue: false,
  })
  seekScale.set_range(0, 1)
  seekScale.set_increments(0.01, 0.05)
  seekScale.add_css_class("MediaProgress")
  seekScale.set_value(progress())

  // Interacting flag. While the user is dragging, skip set_value from polling
  // to avoid overwriting. Clear it 1.5s after the last interaction.
  let userSeeking = false
  let userSeekingTimeoutId: number | null = null
  function markUserSeeking() {
    userSeeking = true
    if (userSeekingTimeoutId !== null)
      GLib.source_remove(userSeekingTimeoutId)
    userSeekingTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      1500,
      () => {
        userSeeking = false
        userSeekingTimeoutId = null
        return GLib.SOURCE_REMOVE
      },
    )
  }

  seekScale.connect("change-value", (_self, _scroll, value) => {
    markUserSeeking()
    const p = primaryPlayer()
    const len = mediaLength()
    if (!p || len <= 0) return false
    const target = Math.max(0, Math.min(len, value * len))
    p.set_position(target)
    return false
  })

  progress.subscribe(() => {
    if (userSeeking) return
    seekScale.set_value(progress())
  })

  function playerControl(action: "prev" | "playPause" | "next") {
    const p = primaryPlayer()
    if (!p) return
    if (action === "prev") p.previous()
    else if (action === "next") p.next()
    else p.play_pause()
  }

  const playPauseIcon = mediaPlaybackStatus((s) =>
    s === 0 /* PLAYING */
      ? `${SRC}/assets/pause.svg`
      : `${SRC}/assets/play.svg`,
  )

  return (
    <box cssName="MediaIsland" orientation={Gtk.Orientation.VERTICAL} spacing={6}>
      <box cssName="MediaTop" spacing={10}>
        {artImage}
        <box
          cssName="MediaInfo"
          orientation={Gtk.Orientation.VERTICAL}
          hexpand
          valign={Gtk.Align.CENTER}
        >
          <label
            cssName="MediaTitle"
            halign={Gtk.Align.START}
            ellipsize={3}
            maxWidthChars={28}
            label={titleLabel}
          />
          <label
            cssName="MediaArtist"
            halign={Gtk.Align.START}
            ellipsize={3}
            maxWidthChars={32}
            label={artistLabel}
          />
        </box>
      </box>

      <box cssName="MediaProgressRow" spacing={6}>
        <label cssName="MediaTime" label={positionLabel} />
        {seekScale}
        <label cssName="MediaTime" label={lengthLabel} />
      </box>

      <box cssName="MediaControls" halign={Gtk.Align.CENTER} spacing={10}>
        <button
          cssName="MediaButton"
          onClicked={() => playerControl("prev")}
        >
          <image file={`${SRC}/assets/backward-step.svg`} pixelSize={18} />
        </button>
        <button
          cssName="MediaButton"
          class="MediaPlayPause"
          onClicked={() => playerControl("playPause")}
        >
          <image file={playPauseIcon} pixelSize={18} />
        </button>
        <button
          cssName="MediaButton"
          onClicked={() => playerControl("next")}
        >
          <image file={`${SRC}/assets/forward-step.svg`} pixelSize={18} />
        </button>
      </box>
    </box>
  ) as Gtk.Widget
}

