import { Astal, Gdk, Gtk } from "ags/gtk4"
import {
  Accessor,
  For,
  createState,
  createComputed,
  createEffect,
  onCleanup,
} from "gnim"
import { LayerState } from "../utils/LayerState"
import { OS_ICON_BLACK, OS_ICON_WHITE } from "../utils/osIcon"
import { isPointInsideWidget } from "../utils/pointInside"
import app from "ags/gtk4/app"
import { execAsync } from "ags/process"
import GLib from "gi://GLib"
import Pango from "gi://Pango"
import AstalApps from "gi://AstalApps"

type StartMenuState = {
  isOpen: Accessor<boolean>
  setOpen: (open: boolean) => void
}

const LAYER_STATE = new LayerState<StartMenuState>()

const apps = new AstalApps.Apps()

export type StartMenuAction = "toggle" | "open" | "close"

// Control the StartMenu from outside (e.g. the ShojiWM config via ags request).
// Identify the target monitor by connector (connector name = ShojiWM monitor name).
// Fall back to the first monitor if not found.
export function controlStartMenu(
  connector: string | null,
  action: StartMenuAction = "toggle",
) {
  const monitors = app.get_monitors()
  const target =
    (connector
      ? monitors.find((monitor) => monitor.get_connector() === connector)
      : undefined) ?? monitors[0]
  if (!target) {
    return
  }
  LAYER_STATE.then(target, (state) => {
    const open = action === "toggle" ? !state.isOpen() : action === "open"
    state.setOpen(open)
  })
}

export function StartMenuButton({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  return (
    <button
      cssName="StartMenuButton"
      class={LAYER_STATE.then(gdkmonitor, (state) =>
        state.isOpen((isOpen) => (isOpen ? "pressed" : "")),
      )}
      onClicked={() =>
        LAYER_STATE.then(gdkmonitor, (state) => state.setOpen(!state.isOpen()))
      }
    >
      <image
        cssName="StartMenuIcon"
        file={LAYER_STATE.then(gdkmonitor, (state) =>
          state.isOpen((open) => (open ? OS_ICON_BLACK : OS_ICON_WHITE)),
        )}
        pixelSize={16}
      />
    </button>
  )
}

export function StartMenuLayer({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  const [isOpen, setIsOpen] = createState(false)
  const [mounted, setMounted] = createState(false)

  // Search string and selected index
  const [search, setSearch] = createState("")
  const [selectedIndex, setSelectedIndex] = createState(0)

  // Derive the app list from the search string in real time
  const results = createComputed(() => apps.fuzzy_query(search()))

  // User info (for the island display)
  const homeDir = GLib.get_home_dir()
  const realName = GLib.get_real_name()
  const userName =
    realName && realName !== "Unknown" ? realName : GLib.get_user_name()
  const hostName = GLib.get_host_name()

  // Power actions. Close the menu after running
  function runPower(command: string) {
    execAsync(["bash", "-c", command]).catch((err) => console.error(err))
    setOpen(false)
  }

  let entryRef: Gtk.Entry | null = null
  let scrolledRef: Gtk.ScrolledWindow | null = null
  let listRef: Gtk.Box | null = null

  // selected row -> widget map. Used for auto-scroll
  const rowMap = new Map<AstalApps.Application, Gtk.Widget>()

  let closeTimeoutId: number | null = null
  let openIdleId: number | null = null

  function clearTimers() {
    if (closeTimeoutId !== null) {
      GLib.source_remove(closeTimeoutId)
      closeTimeoutId = null
    }

    if (openIdleId !== null) {
      GLib.source_remove(openIdleId)
      openIdleId = null
    }
  }

  function setOpen(open: boolean) {
    clearTimers()

    if (open) {
      // Reset the search state each time it opens
      setSearch("")
      setSelectedIndex(0)
      setMounted(true)

      // Add the open class after mounted=true takes effect
      // Splitting these is needed or the transition sometimes doesn't fire
      openIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        openIdleId = null
        setIsOpen(true)

        // Clear the search field and focus it for immediate input
        if (entryRef !== null) {
          entryRef.set_text("")
          entryRef.grab_focus()
        }

        return GLib.SOURCE_REMOVE
      })
    } else {
      setIsOpen(false)

      // Remove the window after the CSS transition finishes
      closeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        closeTimeoutId = null

        // Only unmount if it wasn't reopened in the meantime
        if (!isOpen()) {
          setMounted(false)
        }

        return GLib.SOURCE_REMOVE
      })
    }
  }

  const states = {
    isOpen,
    setOpen,
  }

  LAYER_STATE.set(gdkmonitor, states)

  // Launch the selected app and close the menu
  function launchSelected() {
    const list = results()
    const target = list[selectedIndex()]

    if (target) {
      target.launch()
      setOpen(false)
    }
  }

  // Keep the selected row within the scroll viewport
  function scrollSelectedIntoView() {
    const list = results()
    const target = list[selectedIndex()]

    if (!target || scrolledRef === null || listRef === null) {
      return
    }

    const widget = rowMap.get(target)
    if (!widget) {
      return
    }

    const adjustment = scrolledRef.get_vadjustment()
    if (!adjustment) {
      return
    }

    const [ok, bounds] = widget.compute_bounds(listRef)
    if (!ok) {
      return
    }

    const top = bounds.get_y()
    const bottom = top + bounds.get_height()
    const viewTop = adjustment.get_value()
    const viewBottom = viewTop + adjustment.get_page_size()

    if (top < viewTop) {
      adjustment.set_value(top)
    } else if (bottom > viewBottom) {
      adjustment.set_value(bottom - adjustment.get_page_size())
    }
  }

  // When the selection changes, scroll after layout settles
  createEffect(() => {
    selectedIndex()
    results()

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      scrollSelectedIntoView()
      return GLib.SOURCE_REMOVE
    })
  })

  const { TOP, LEFT, RIGHT, BOTTOM } = Astal.WindowAnchor

  const inner = (
    <box
      cssName="StartMenu"
      class={isOpen((open) => (open ? "open" : "close"))}
      halign={Gtk.Align.START}
      valign={Gtk.Align.START}
    >
      <box
        orientation={Gtk.Orientation.VERTICAL}
        halign={Gtk.Align.FILL}
        hexpand
        vexpand
      >
        <box cssName={"FirstPadding"} />
        <box
          cssName={"SearchBox"}
          orientation={Gtk.Orientation.VERTICAL}
          valign={Gtk.Align.FILL}
          halign={Gtk.Align.FILL}
          hexpand
          vexpand
        >
          <box
            cssName={"SearchBoxInner"}
            orientation={Gtk.Orientation.HORIZONTAL}
            halign={Gtk.Align.FILL}
            hexpand
          >
            <image
              cssName={"SearchBoxIcon"}
              file={`${SRC}/assets/search.svg`}
            />
            <entry
              $={(self) => (entryRef = self)}
              cssName={"SearchBoxEntry"}
              placeholderText={" Search..."}
              halign={Gtk.Align.FILL}
              hexpand
              onNotifyText={(self) => {
                setSearch(self.text)
                setSelectedIndex(0)
              }}
              onActivate={() => launchSelected()}
            />
          </box>
          <Gtk.Separator
            cssName={"SearchBoxSeparator"}
            orientation={Gtk.Orientation.HORIZONTAL}
          />
          <scrolledwindow
            $={(self) => (scrolledRef = self)}
            cssName={"AppList"}
            hexpand
            vexpand
            hscrollbarPolicy={Gtk.PolicyType.NEVER}
            vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
          >
            <box
              $={(self) => (listRef = self)}
              cssName={"AppListInner"}
              orientation={Gtk.Orientation.VERTICAL}
              halign={Gtk.Align.FILL}
              valign={Gtk.Align.START}
              hexpand
            >
              <For each={results}>
                {(
                  application: AstalApps.Application,
                  index: Accessor<number>,
                ) => {
                  const row = (
                    <button
                      cssName={"AppButton"}
                      class={createComputed(() =>
                        selectedIndex() === index() ? "selected" : "",
                      )}
                      canFocus={false}
                      onClicked={() => {
                        application.launch()
                        setOpen(false)
                      }}
                    >
                      <box
                        cssName={"AppButtonInner"}
                        orientation={Gtk.Orientation.HORIZONTAL}
                        halign={Gtk.Align.FILL}
                        hexpand
                      >
                        <image
                          cssName={"AppButtonIcon"}
                          iconName={
                            application.iconName || "application-x-executable"
                          }
                          pixelSize={28}
                        />
                        <label
                          cssName={"AppButtonLabel"}
                          label={application.name}
                          halign={Gtk.Align.START}
                          ellipsize={Pango.EllipsizeMode.END}
                        />
                      </box>
                    </button>
                  ) as Gtk.Widget

                  rowMap.set(application, row)
                  onCleanup(() => rowMap.delete(application))

                  return row
                }}
              </For>
            </box>
          </scrolledwindow>
        </box>
        <box
          cssName={"UserBox"}
          orientation={Gtk.Orientation.HORIZONTAL}
          halign={Gtk.Align.FILL}
          valign={Gtk.Align.END}
          hexpand
        >
          <box
            cssName={"UserIcon"}
            css={`
              background-image: url("file://${homeDir}/Pictures/icon.png");
            `}
            valign={Gtk.Align.CENTER}
          />
          <box
            cssName={"UserText"}
            orientation={Gtk.Orientation.VERTICAL}
            valign={Gtk.Align.CENTER}
            halign={Gtk.Align.START}
            hexpand
          >
            <label
              cssName={"UserName"}
              label={userName}
              halign={Gtk.Align.START}
              ellipsize={Pango.EllipsizeMode.END}
            />
            <label
              cssName={"HostName"}
              label={hostName}
              halign={Gtk.Align.START}
              ellipsize={Pango.EllipsizeMode.END}
            />
          </box>
          <button
            cssName={"LockButton"}
            valign={Gtk.Align.CENTER}
            onClicked={() => runPower("loginctl lock-session")}
          >
            <image
              cssName={"LockIcon"}
              file={`${SRC}/assets/lock.svg`}
              pixelSize={20}
            />
          </button>
          <menubutton
            cssName={"PowerButton"}
            valign={Gtk.Align.CENTER}
            $={(self) => {
              const icon = (
                <image
                  cssName={"PowerIcon"}
                  file={`${SRC}/assets/power.svg`}
                  pixelSize={20}
                />
              ) as Gtk.Widget
              self.set_child(icon)
            }}
          >
            <popover cssName={"PowerPopover"} hasArrow={false}>
              <box
                cssName={"PowerMenu"}
                orientation={Gtk.Orientation.VERTICAL}
                halign={Gtk.Align.FILL}
              >
                <button
                  cssName={"PowerMenuItem"}
                  onClicked={() => runPower("systemctl poweroff")}
                >
                  <label label={"Power Off"} halign={Gtk.Align.START} hexpand />
                </button>
                <button
                  cssName={"PowerMenuItem"}
                  onClicked={() => runPower("systemctl reboot")}
                >
                  <label label={"Restart"} halign={Gtk.Align.START} hexpand />
                </button>
                <button
                  cssName={"PowerMenuItem"}
                  onClicked={() =>
                    runPower(
                      `loginctl terminate-user "${GLib.get_user_name()}"`,
                    )
                  }
                >
                  <label label={"Logout"} halign={Gtk.Align.START} hexpand />
                </button>
              </box>
            </popover>
          </menubutton>
        </box>
      </box>
    </box>
  ) as Gtk.Box

  const window = (
    <window
      name="startmenulayer"
      class="StartMenuLayer"
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

  // Up/Down to move selection / Enter to launch / Esc to close
  const keyController = Gtk.EventControllerKey.new()
  keyController.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)

  keyController.connect("key-pressed", (_c, keyval) => {
    const length = results().length

    switch (keyval) {
      case Gdk.KEY_Down:
        if (length > 0) {
          setSelectedIndex(Math.min(selectedIndex() + 1, length - 1))
        }
        return true
      case Gdk.KEY_Up:
        if (length > 0) {
          setSelectedIndex(Math.max(selectedIndex() - 1, 0))
        }
        return true
      case Gdk.KEY_Return:
      case Gdk.KEY_KP_Enter:
        launchSelected()
        return true
      case Gdk.KEY_Escape:
        states.setOpen(false)
        return true
      default:
        return false
    }
  })

  window.add_controller(keyController)

  return window
}
