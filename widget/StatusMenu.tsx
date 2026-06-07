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
  bluetooth,
  bluetoothDevices,
  bluetoothEnabled,
  bluetoothPrimary,
  brightness,
  brightnessAvailable,
  dismissAllNotifications,
  focusWifiPolling,
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
  toggleBluetooth,
  toggleBluetoothDevice,
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
// バー上のトリガーボタン: 主要 7 ステータスのアイコンを横並びで表示
// =============================================================================
export function StatusButton({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  return (
    <button
      cssName="StatusButton"
      class={LAYER_STATE.then(gdkmonitor, (state) =>
        state.isOpen((isOpen) => (isOpen ? "pressed" : "")),
      )}
      onClicked={() =>
        LAYER_STATE.then(gdkmonitor, (state) => state.setOpen(!state.isOpen()))
      }
    >
      <box cssName="StatusButtonRow" spacing={4}>
        <image
          cssName="StatusButtonIcon"
          file={createComputed(() => {
            if (!wifiEnabled()) return `${SRC}/assets/wifi-off.svg`
            const s = wifiStrength()
            if (s >= 70) return `${SRC}/assets/wifi-full.svg`
            if (s >= 40) return `${SRC}/assets/wifi-midium.svg`
            if (s >= 10) return `${SRC}/assets/wifi-low.svg`
            return `${SRC}/assets/wifi-off.svg`
          })}
          pixelSize={14}
        />
        <image
          cssName="StatusButtonIcon"
          class={bluetoothEnabled((on) => (on ? "active" : ""))}
          file={`${SRC}/assets/bluetooth.svg`}
          pixelSize={14}
        />
        <image
          cssName="StatusButtonIcon"
          file={ppdActive((p) => `${SRC}/assets/${ppdIconNameFor(p)}.svg`)}
          pixelSize={14}
        />
        <image
          cssName="StatusButtonIcon"
          file={notifDnd(
            (dnd) =>
              `${SRC}/assets/${dnd ? "bell-no" : "bell"}.svg`,
          )}
          pixelSize={14}
        />
        <image
          cssName="StatusButtonIcon"
          file={`${SRC}/assets/music.svg`}
          pixelSize={14}
        />
        <image
          cssName="StatusButtonIcon"
          file={createComputed(() =>
            speakerMute() || speakerVolume() === 0
              ? `${SRC}/assets/volume-off.svg`
              : `${SRC}/assets/volume.svg`,
          )}
          pixelSize={14}
        />
        <image
          cssName="StatusButtonIcon"
          file={`${SRC}/assets/sun.svg`}
          pixelSize={14}
        />
      </box>
    </button>
  )
}

// =============================================================================
// メニュー本体
// =============================================================================
export function StatusMenuLayer({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  const [isOpen, setIsOpen] = createState(false)
  const [mounted, setMounted] = createState(false)
  // 開いた直後は通知タブ。再オープン時もデフォルトに戻す。
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
      // widget level でも size を固定。CSS の min-height だけでは
      // 子の natural が小さい場合に縮むケースがあるため両方で押さえる。
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
// 上部: 2x2 quick toggles + サブメニュー
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
          // 同じものをクリックしたら閉じずに維持(常にどれか開く設計)
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
                ? `${SRC}/assets/angle-down.svg`
                : `${SRC}/assets/angle-right.svg`,
            )}
            pixelSize={12}
          />
        </box>
      </button>
    ) as Gtk.Widget
  }

  const wifiBtn = quickButton(
    "wifi",
    createComputed(() => {
      if (!wifiEnabled()) return `${SRC}/assets/wifi-off.svg`
      const s = wifiStrength()
      if (s >= 70) return `${SRC}/assets/wifi-full.svg`
      if (s >= 40) return `${SRC}/assets/wifi-midium.svg`
      if (s >= 10) return `${SRC}/assets/wifi-low.svg`
      return `${SRC}/assets/wifi-off.svg`
    }),
    createComputed(() => {
      if (!wifiEnabled()) return "Off"
      return wifiSsid() ?? "Not connected"
    }),
    wifiEnabled,
  )

  const btBtn = quickButton(
    "bluetooth",
    createComputed(() => `${SRC}/assets/bluetooth.svg`),
    bluetoothPrimary,
    bluetoothEnabled,
  )

  const ppdBtn = quickButton(
    "ppd",
    ppdActive((p) => `${SRC}/assets/${ppdIconNameFor(p)}.svg`),
    ppdActive(ppdLabel),
    createComputed(() => true),
  )

  const notifBtn = quickButton(
    "notifications",
    notifDnd(
      (dnd) => `${SRC}/assets/${dnd ? "bell-no" : "bell"}.svg`,
    ),
    notifDnd((dnd) => (dnd ? "Silent" : "Notifications")),
    createComputed(() => !notifDnd()),
  )

  return (
    <box cssName="QuickIsland" orientation={Gtk.Orientation.VERTICAL}>
      <box cssName="QuickGrid" orientation={Gtk.Orientation.VERTICAL} spacing={6}>
        <box spacing={6}>
          {wifiBtn}
          {btBtn}
        </box>
        <box spacing={6}>
          {ppdBtn}
          {notifBtn}
        </box>
      </box>
      <box cssName="QuickSeparator" />
      {Submenu(activeSubmenu)}
    </box>
  ) as Gtk.Widget
}

// サブメニュー領域: スクロール可能 + 固定高
function Submenu(activeSubmenu: Accessor<Submenu>): Gtk.Widget {
  return (
    <scrolledwindow
      cssName="SubmenuScroll"
      hscrollbarPolicy={Gtk.PolicyType.NEVER}
      vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
      // overlay にすると scrollbar が内容に被って hover 干渉する。
      // false にして scrollbar に専用の列を割り当てる。
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

function rowToggle(
  label: string,
  active: boolean,
  onClick: () => void,
): Gtk.Widget {
  return (
    <button
      cssName="SubmenuRow"
      class={active ? "active" : ""}
      onClicked={onClick}
    >
      <box spacing={8}>
        <label
          cssName="SubmenuRowLabel"
          halign={Gtk.Align.START}
          hexpand
          ellipsize={3}
          label={label}
        />
      </box>
    </button>
  ) as Gtk.Widget
}

// =============================================================================
// Wi-Fi submenu
// 3 つの内部モード(リスト / パスワード入力 / 接続中)を 1 つのコンテナ内で切替。
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

  // 表示中は polling 頻度を上げる。submenu unmount 時に release を呼んで戻す。
  const releaseFocus = focusWifiPolling()
  onCleanup(releaseFocus)

  // 表示時に rescan を促す
  void triggerWifiScan()

  // ON/OFF トグル行 (Gtk.Switch)。active を wifiEnabled に bind しつつ、
  // 外部要因(polling) で active が変わって notify::active が fire しても
  // 望み(desired)===現在(current) なら何もしないことで再帰呼び出しを防ぐ。
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

  // 操作行: rescan / disconnect。
  // Rescan は scanning 中はラベル切替 + disabled。
  // Disconnect は接続中以外は disabled。
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

  // 切替コンテンツ部
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
    // AP は scan の合間に GC される可能性があるので、UI に必要な値は snapshot し、
    // クリック時は SSID で AP を取り直す。クロージャは ap を直接保持しない。
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
            // 既知/オープンを期待してまず password 無しで activate。
            // 失敗時に needsPassword で password モードへ。
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
              // 暗号化ありはまず password 無しを試して、保存済みならそのまま繋がる
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

function bluetoothSubmenu(): Gtk.Widget {
  const toggle = rowToggle(
    bluetoothEnabled() ? "Bluetooth: On" : "Bluetooth: Off",
    bluetoothEnabled(),
    toggleBluetooth,
  )
  if (bluetoothEnabled() && bluetooth.adapter) {
    try {
      bluetooth.adapter.start_discovery()
    } catch {
      // ignore
    }
  }
  const list = (
    <box cssName="SubmenuList" orientation={Gtk.Orientation.VERTICAL} />
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
      const devs = bluetoothDevices()
      for (const dev of devs) {
        list.append(
          (
            <button
              cssName="SubmenuRow"
              class={dev.connected ? "active" : ""}
              onClicked={() => toggleBluetoothDevice(dev)}
            >
              <box spacing={8}>
                <label
                  cssName="SubmenuRowLabel"
                  halign={Gtk.Align.START}
                  hexpand
                  ellipsize={3}
                  label={dev.name ?? dev.alias ?? dev.address ?? "(unknown)"}
                />
                <label
                  cssName="SubmenuRowSub"
                  halign={Gtk.Align.END}
                  label={dev.connected ? "Connected" : dev.paired ? "Paired" : ""}
                />
              </box>
            </button>
          ) as Gtk.Widget,
        )
      }
    })
  }
  rebuild()
  onCleanup(bluetoothDevices.subscribe(rebuild))

  return (
    <box orientation={Gtk.Orientation.VERTICAL} spacing={2}>
      {toggle}
      {list}
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

  // Gtk.Revealer でラップして高さ折りたたみ、CSS で translateX + opacity を
  // 担当させる。両者を並列に走らせると Revealer の SLIDE_DOWN が支配的に
  // なって CSS transition が見えなくなるので、**順序を逐次化**する:
  //   enter: Revealer 展開 → 完了後に entering クラス除去 (CSS slide-in)
  //   leave: leaving クラス追加 (CSS slide-out) → 完了後に Revealer 折りたたみ
  //          → 完了後に DOM 削除
  //
  // 動作中の状態変化に強くするため id ごとに token を発行し、各非同期 step
  // は実行直前に「自分の token がまだ最新か」を確認してから進める。新しい
  // 動作 (例: enter 中に dismiss) で token が更新されると古い callback は
  // 単に no-op する。
  const NOTIF_ANIM_MS = 240
  const revealerById = new Map<number, Gtk.Revealer>()
  const animTokenById = new Map<number, number>()
  // 各 revealer (= notif row JSX) 専用の reactive scope の dispose。
  // JSX 構築中に onClicked などが内部で onCleanup を呼ぶため、createRoot で
  // tracking context を張る必要がある (reconcile は subscribe callback 経由
  // で呼ばれるので、ここの外側には active な scope が無い)。
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
      // SLIDE_DOWN: Revealer 自身の allocation が 0 → 自然高さに animate するので
      // 周りの行が自然に上下にずれる。CROSSFADE では opacity だけで高さ変化が
      // 起きず、新規追加/削除に合わせた slide が起きなかった。
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
      // 万一 leaving 状態だったら戻す。entering は createRevealerForNotif で既に付与済。
      child.remove_css_class("leaving")
      child.add_css_class("entering")
    }
    // Phase 1: Revealer 展開 (高さ 0 → natural)。
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (!tokenValid(id, token)) return GLib.SOURCE_REMOVE
      revealer.set_reveal_child(true)
      // Phase 2: Revealer の展開が終わってから CSS slide-in を始動。
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
      // entering 中なら入場をキャンセルして leaving に切替え。CSS の transition
      // が translateX(0) ←→ translateX(48) の間で走る。
      child.remove_css_class("entering")
      child.add_css_class("leaving")
    }
    // Phase 1: CSS slide-out 完了を待つ。
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, NOTIF_ANIM_MS + 20, () => {
      if (!tokenValid(id, token)) return GLib.SOURCE_REMOVE
      // Phase 2: Revealer 折りたたみ (natural → 0)。周りの行が上にスライドする。
      revealer.set_reveal_child(false)
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, NOTIF_ANIM_MS + 20, () => {
        if (!tokenValid(id, token)) return GLib.SOURCE_REMOVE
        // Phase 3: DOM から削除 + reactive scope を dispose。
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

    // 1. 消えた通知に leave アニメを当てる
    for (const [id, revealer] of [...revealerById]) {
      if (!itemIds.has(id)) {
        startLeave(id, revealer)
        revealerById.delete(id)
      }
    }

    // 2. 空状態の表示切替
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

    // 3. 新規通知を items 順に挿入 (既存はそのまま位置を保つ)
    let prev: Gtk.Revealer | null = null
    for (const n of items) {
      const existing = revealerById.get(n.id)
      if (existing) {
        prev = existing
        continue
      }
      // 各 row 専用の reactive scope。JSX 内部の onCleanup はここに紐づく。
      // scope は startLeave の Phase 3 (DOM 削除) で dispose する。
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
  // submenu 自体が捨てられたら、まだ leave アニメ中で残っている scope も解放。
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
 * 与えられたファイルパスを 40x40 にスケールして Gtk.Image に読み込ませる。
 * 成功したら true を返す。失敗(ファイル非存在 / 非画像 / 不正パス) なら false。
 */
function tryLoadFileAsImage(img: Gtk.Image, path: string): boolean {
  try {
    if (!path) return false
    // 念のため事前に存在チェック (失敗時に GError ダンプが ags 側で煩い)
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
 * 与えられたアイコン名が現在の theme で見つかるかを確認してから set する。
 * 見つからない場合は false で返してフォールバックに進ませる。
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

  // フォールバック チェイン:
  //   1. n.image as file path
  //   2. n.image as icon name (theme 内に存在するときだけ)
  //   3. n.appIcon as file path
  //   4. n.appIcon as icon name (theme 内に存在するときだけ)
  // 全部失敗したら透明 spacer。GTK の generic broken icon は出さない。

  const candidates: string[] = []
  if (image) candidates.push(image)
  if (appIcon && appIcon !== image) candidates.push(appIcon)

  for (const c of candidates) {
    // http(s) URL は読み込まない(同期 fetch しないため)
    if (/^https?:\/\//i.test(c)) continue

    // file:// または絶対パス: file として読む
    if (c.startsWith("file://") || c.startsWith("/")) {
      const path = c.startsWith("file://") ? c.replace(/^file:\/\//, "") : c
      if (tryLoadFileAsImage(img, path)) return img
      continue
    }

    // それ以外 (e.g. "kitty", "firefox") は theme の icon name として解決
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

function notificationRow(
  n: import("gi://AstalNotifd").default.Notification,
): Gtk.Widget {
  const ageLabel = (() => {
    const seconds = Math.max(0, Math.floor(Date.now() / 1000 - n.time))
    if (seconds < 60) return "now"
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
    return `${Math.floor(seconds / 86400)}d`
  })()

  // 通知アクション。"default" は body click に割り当てるためボタンには出さない。
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
    // freedesktop spec: アクション後は基本 dismiss する(resident hint 未対応)。
    try {
      n.dismiss()
    } catch {
      // ignore
    }
  }

  const actionsRow =
    visibleActions.length > 0 ? (
      <box cssName="NotifActions" spacing={6} halign={Gtk.Align.END}>
        {visibleActions.map((a) => (
          <button
            cssName="NotifActionButton"
            onClicked={() => invokeAction(a.id)}
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
        >
          <label label="×" />
        </button>
      </box>
      {actionsRow}
    </box>
  ) as Gtk.Box

  // body クリック (= 行全体クリック) で default action を発火。
  // GestureClick は子の button (close / action) で消費されないクリックだけ拾う。
  if (hasDefaultAction) {
    const gesture = Gtk.GestureClick.new()
    gesture.set_button(Gdk.BUTTON_PRIMARY)
    gesture.connect("pressed", () => invokeAction("default"))
    row.add_controller(gesture)
  }

  return row
}

// =============================================================================
// 中段: Volume + Brightness
// =============================================================================
function SlidersIsland(): Gtk.Widget {
  return (
    <box cssName="SlidersIsland" orientation={Gtk.Orientation.VERTICAL} spacing={6}>
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

  return (
    <box cssName="SliderRow" spacing={8}>
      <button cssName="SliderIcon" onClicked={onIconClick}>
        <image file={iconFile} pixelSize={16} />
      </button>
      {slider}
    </box>
  ) as Gtk.Widget
}

// =============================================================================
// 下段: メディアプレーヤー
// =============================================================================
function MediaIsland(): Gtk.Widget {
  // 各表示要素は notify ベースの reactive state から読む。
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

  // position は notify が来ない player が多いので 1Hz tick で polling。
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
  // 注意: Gtk.Picture は paintable の intrinsic size が widget の natural size
  // に直接効くため、大きい画像で MediaIsland が膨らみメニュー全体が押し上げ
  // られる。Gtk.Image は pixel_size をセットすると paintable のサイズに関わらず
  // natural=pixel_size に固定されるので、こちらで描画する。
  const ART_SIZE_PX = 72
  const artImage = (
    <image cssName="MediaArt" pixelSize={ART_SIZE_PX} />
  ) as Gtk.Image

  function applyArt(file: Gio.File | null) {
    if (!file) {
      artImage.clear()
      return
    }
    const path = file.get_path()
    if (!path) {
      artImage.clear()
      return
    }
    try {
      // pixel_size 固定でも、大きい元画像をそのまま読むのは無駄なので
      // ロード段階でも 144x144 (HiDPI 2x) 程度に縮めておく。
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
        artImage.clear()
      }
    } catch (err) {
      console.error("[status] media art load failed:", err)
      artImage.clear()
    }
  }
  applyArt(artFile())
  artFile.subscribe(() => applyArt(artFile()))

  // シーク可能な Gtk.Scale。change-value はユーザー操作 (drag / scroll /
  // キー入力) のときだけ発火する。プログラム的に set_value したときは
  // 発火しないので、再生位置のポーリング更新と入力イベントが安全に分離できる。
  const seekScale = new Gtk.Scale({
    orientation: Gtk.Orientation.HORIZONTAL,
    hexpand: true,
    drawValue: false,
  })
  seekScale.set_range(0, 1)
  seekScale.set_increments(0.01, 0.05)
  seekScale.add_css_class("MediaProgress")
  seekScale.set_value(progress())

  // 操作中フラグ。ユーザーが drag している間は poll での set_value を
  // skip して上書きを防ぐ。最後の操作から 1.5 秒経ったら解除。
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

