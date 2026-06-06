import { Astal, Gdk, Gtk } from "ags/gtk4"
import { createComputed, createRoot, createState } from "gnim"
import app from "ags/gtk4/app"
import GLib from "gi://GLib"
import { view, dockProximity } from "../utils/workspaceState"
import {
  appDisplayName,
  appIconName,
  dockConfig,
  dockItemsFor,
  activateOrLaunch,
  activateWindow,
  isPinned,
  launchAppOf,
  monitorByConnector,
  pinApp,
  unpinApp,
  type DockItem,
} from "../utils/dockState"

const DOCK_OPEN_GRACE_MS = 0
const DOCK_CLOSE_GRACE_MS = 250
const DOCK_ANIMATION_MS = 320

// =============================================================================
// DockWindow: モニタごとに常駐(レイヤ自体は常に存在し、visible で mount/unmount)。
// IPC の dock.proximity broadcast に従って表示・非表示を切り替える。
// =============================================================================
export function DockWindow({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  const connector = gdkmonitor.get_connector()
  const { BOTTOM } = Astal.WindowAnchor

  const [mounted, setMounted] = createState(false)
  const [isOpen, setIsOpen] = createState(false)

  // popover が開いている間は proximity が外れても dock を閉じない。
  // popovers 配列から popup 中のものを判定する代わりに、明示的に open 数を持つ。
  let popoverOpenCount = 0
  const [popoverHeld, setPopoverHeld] = createState(false)

  function notePopoverOpened() {
    popoverOpenCount += 1
    if (popoverOpenCount === 1) setPopoverHeld(true)
  }
  function notePopoverClosed() {
    popoverOpenCount = Math.max(0, popoverOpenCount - 1)
    if (popoverOpenCount === 0) setPopoverHeld(false)
  }

  let openIdleId: number | null = null
  let closeTimeoutId: number | null = null
  let unmountTimeoutId: number | null = null

  // 現在の DockItem 群が持つ popover。Dock を閉じる際に一緒に popdown しないと、
  // フェードアウト後に popover が画面端に残骸のように残ってしまう。
  const popovers: Gtk.Popover[] = []

  function closePopovers() {
    for (const popover of popovers) {
      popover.popdown()
    }
  }

  function clearTimers() {
    if (openIdleId !== null) {
      GLib.source_remove(openIdleId)
      openIdleId = null
    }
    if (closeTimeoutId !== null) {
      GLib.source_remove(closeTimeoutId)
      closeTimeoutId = null
    }
    if (unmountTimeoutId !== null) {
      GLib.source_remove(unmountTimeoutId)
      unmountTimeoutId = null
    }
  }

  function show() {
    clearTimers()
    setMounted(true)
    openIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      openIdleId = null
      setIsOpen(true)
      return GLib.SOURCE_REMOVE
    })
  }

  function hide() {
    clearTimers()
    closePopovers()
    setIsOpen(false)
    unmountTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      DOCK_ANIMATION_MS,
      () => {
        unmountTimeoutId = null
        if (!isOpen()) {
          setMounted(false)
        }
        return GLib.SOURCE_REMOVE
      },
    )
  }

  // dock を出したい状態 = (proximity inside) OR (popover が 1 つ以上開いている)。
  // どちらか保っている間は閉じず、両方外れて grace 経過したら hide。
  // createComputed は tracking context 外だと動かないので、依存 signal を直接購読する。
  function wantOpen(): boolean {
    const inside = connector ? !!dockProximity()[connector] : false
    return inside || popoverHeld()
  }

  function react() {
    if (wantOpen()) {
      if (DOCK_OPEN_GRACE_MS === 0) {
        show()
      } else {
        clearTimers()
        openIdleId = GLib.timeout_add(
          GLib.PRIORITY_DEFAULT,
          DOCK_OPEN_GRACE_MS,
          () => {
            openIdleId = null
            show()
            return GLib.SOURCE_REMOVE
          },
        )
      }
    } else {
      clearTimers()
      closeTimeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        DOCK_CLOSE_GRACE_MS,
        () => {
          closeTimeoutId = null
          hide()
          return GLib.SOURCE_REMOVE
        },
      )
    }
  }

  dockProximity.subscribe(react)
  popoverHeld.subscribe(react)

  // モニタの dock items を reactive に導出
  const monitorAccessor = createComputed(() =>
    monitorByConnector(view(), connector),
  )

  return (
    <window
      name="dock"
      class="DockLayer"
      gdkmonitor={gdkmonitor}
      layer={Astal.Layer.TOP}
      exclusivity={Astal.Exclusivity.NORMAL}
      // BOTTOM-only: surface is sized to DockBar's natural width and centered
      // horizontally by layer-shell. Anchoring LEFT|RIGHT as well would make
      // the surface span the full screen width and absorb clicks on the empty
      // sides, blocking the windows underneath.
      anchor={BOTTOM}
      // 12px gap is layer-shell margin (outside the surface) so the dock
      // surface itself does not extend below the visible bar — otherwise the
      // bottom 12 px would absorb clicks that should reach the window below.
      marginBottom={12}
      application={app}
      visible={mounted}
    >
      <box
        cssName="DockBar"
        class={isOpen((open) => (open ? "open" : "close"))}
        orientation={Gtk.Orientation.HORIZONTAL}
        spacing={4}
        $={(self) => {
            // DockItem ボタンを reactive に詰める。
            // gnim の jsx は subscribe コールバック中だと tracking context が無いので、
            // createRoot でラップして毎回スコープを作り直す(Wallpaper と同じパターン)。
            let dispose: (() => void) | null = null

            const rebuild = () => {
              if (dispose) {
                dispose()
                dispose = null
              }
              // 旧 popover を閉じてから作り直す(残骸防止)
              closePopovers()
              popovers.length = 0
              let child = self.get_first_child()
              while (child) {
                const next = child.get_next_sibling()
                self.remove(child)
                child = next
              }
              createRoot((d) => {
                dispose = d
                const items = dockItemsFor(monitorAccessor())
                for (const item of items) {
                  self.append(
                    buildDockItem(
                      item,
                      popovers,
                      notePopoverOpened,
                      notePopoverClosed,
                    ),
                  )
                }
              })
            }
            rebuild()
            monitorAccessor.subscribe(rebuild)
            dockConfig.subscribe(rebuild)
          }}
        />
    </window>
  )
}

// =============================================================================
// 1 つの DockItem (= 1 アプリ) を描画する。
// 左クリック: activateOrLaunch(MRU 先頭 focus または launch)
// 右クリック: Popover(ウィンドウ一覧 + ピン留め + New Window)
// インジケータ: ウィンドウ数 (max 3 ドット、4 以上は最後に "+")
// focused クラスでアクセント枠を当てる
// =============================================================================
function buildDockItem(
  item: DockItem,
  popovers: Gtk.Popover[],
  onPopoverOpened: () => void,
  onPopoverClosed: () => void,
): Gtk.Widget {
  const popover = new Gtk.Popover()
  popover.set_has_arrow(true)
  popover.set_position(Gtk.PositionType.TOP)
  popovers.push(popover)

  // popdown / 外側クリック / ESC のいずれで閉じても発火する。
  popover.connect("closed", () => onPopoverClosed())

  const popoverContent = buildPopoverContent(item, () => popover.popdown())
  popover.set_child(popoverContent)

  const tooltip = appDisplayName(item.app, item.appId)
  const iconName = appIconName(item.app)
  const indicator = buildIndicator(item)

  const button = (
    <button
      cssName="DockItem"
      class={item.focused ? "focused" : ""}
      tooltipText={tooltip}
      onClicked={() => activateOrLaunch(item)}
      $={(self) => {
        popover.set_parent(self)
        // 右クリックで Popover を出す
        const rightClick = Gtk.GestureClick.new()
        rightClick.set_button(Gdk.BUTTON_SECONDARY)
        rightClick.connect("pressed", () => {
          onPopoverOpened()
          popover.popup()
        })
        self.add_controller(rightClick)
      }}
    >
      <box
        cssName="DockItemBox"
        orientation={Gtk.Orientation.VERTICAL}
        halign={Gtk.Align.CENTER}
        valign={Gtk.Align.CENTER}
      >
        <image cssName="DockItemIcon" iconName={iconName} pixelSize={32} />
        {indicator}
      </box>
    </button>
  ) as Gtk.Widget

  return button
}

function buildIndicator(item: DockItem): Gtk.Widget {
  // ウィンドウが無いピン留めは空のスペーサーで高さだけ揃える(レイアウトジャンプ防止)
  const count = item.windows.length
  const dots: Gtk.Widget[] = []
  const dotCount = Math.min(count, 3)
  for (let i = 0; i < dotCount; i++) {
    dots.push(<box cssName="DockItemDot" /> as Gtk.Widget)
  }
  if (count > 3) {
    dots.push(<box cssName="DockItemDotMore" /> as Gtk.Widget)
  }
  return (
    <box
      cssName="DockItemIndicator"
      orientation={Gtk.Orientation.HORIZONTAL}
      halign={Gtk.Align.CENTER}
      spacing={3}
    >
      {dots}
    </box>
  ) as Gtk.Widget
}

function buildPopoverContent(
  item: DockItem,
  close: () => void,
): Gtk.Widget {
  const rows: Gtk.Widget[] = []

  for (const window of item.windows) {
    rows.push(
      (
        <button
          cssName="DockPopoverRow"
          onClicked={() => {
            close()
            activateWindow(window.id)
          }}
        >
          <box
            cssName="DockPopoverRowBox"
            orientation={Gtk.Orientation.HORIZONTAL}
            spacing={8}
          >
            <box
              cssName={
                window.focused ? "DockPopoverActive" : "DockPopoverInactive"
              }
            />
            <label
              cssName="DockPopoverRowLabel"
              halign={Gtk.Align.START}
              ellipsize={3}
              maxWidthChars={40}
              label={window.title || "(no title)"}
            />
          </box>
        </button>
      ) as Gtk.Widget,
    )
  }

  if (item.windows.length > 0 && item.app) {
    rows.push(
      (
        <box cssName="DockPopoverSeparator" />
      ) as Gtk.Widget,
    )
  }

  // ピン留め切替(.desktop entry が解決できるときだけ)
  const entry = item.app?.entry
  if (entry) {
    const pinned = isPinned(entry)
    rows.push(
      (
        <button
          cssName="DockPopoverRow"
          onClicked={() => {
            close()
            if (pinned) {
              unpinApp(entry)
            } else {
              pinApp(entry)
            }
          }}
        >
          <label
            cssName="DockPopoverRowLabel"
            halign={Gtk.Align.START}
            label={pinned ? "Dock から外す" : "Dock にピン留め"}
          />
        </button>
      ) as Gtk.Widget,
    )
  }

  if (item.app) {
    rows.push(
      (
        <button
          cssName="DockPopoverRow"
          onClicked={() => {
            close()
            launchAppOf(item)
          }}
        >
          <label
            cssName="DockPopoverRowLabel"
            halign={Gtk.Align.START}
            label="新しいウィンドウ"
          />
        </button>
      ) as Gtk.Widget,
    )
  }

  return (
    <box
      cssName="DockPopover"
      orientation={Gtk.Orientation.VERTICAL}
      spacing={2}
    >
      {rows}
    </box>
  ) as Gtk.Widget
}
