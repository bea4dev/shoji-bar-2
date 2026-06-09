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
// DockWindow: one per monitor (the layer always exists; mount/unmount via visible).
// Show/hide according to the IPC dock.proximity broadcast.
// =============================================================================
export function DockWindow({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  const connector = gdkmonitor.get_connector()
  const { BOTTOM } = Astal.WindowAnchor

  const [mounted, setMounted] = createState(false)
  const [isOpen, setIsOpen] = createState(false)

  // While a popover is open, don't close the dock even if proximity is lost.
  // Instead of inspecting the popovers array, keep an explicit open count.
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

  // Popovers held by the current DockItems. If not popped down when the dock closes,
  // the popover lingers like a remnant at the screen edge after fade-out.
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

  // Want-dock-shown = (proximity inside) OR (one or more popovers open).
  // Stay open while either holds; hide once both clear and the grace period passes.
  // createComputed doesn't work outside a tracking context, so subscribe to the deps directly.
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

  // Derive the monitor's dock items reactively
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
            // Fill in the DockItem buttons reactively.
            // gnim's jsx has no tracking context inside a subscribe callback, so
            // wrap in createRoot and rebuild the scope each time (same pattern as Wallpaper).
            let dispose: (() => void) | null = null

            const rebuild = () => {
              if (dispose) {
                dispose()
                dispose = null
              }
              // Pop down old popovers before rebuilding (prevents remnants)
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
// Render one DockItem (= one app).
// Left click: activateOrLaunch (focus the MRU-front window, or launch)
// Right click: popover (window list + pin + New Window)
// Indicator: window count (max 3 dots; 4+ shows a trailing "+")
// Apply an accent border via the focused class
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

  // Fires whether closed via popdown / outside click / ESC.
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
        // Right click opens the popover
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
  // For pinned apps with no windows, use an empty spacer to keep the height (prevents layout jump)
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

  // Toggle pinning (only when the .desktop entry resolves)
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
            label={pinned ? "Unpin from Dock" : "Pin to Dock"}
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
            label="New window"
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
