import { Astal, Gdk, Gtk } from "ags/gtk4"
import { Accessor, For, createState, createComputed, createEffect, onCleanup } from "gnim"
import { LayerState } from "../utils/LayerState"
import { isPointInsideWidget } from "../utils/pointInside"
import {
  listClipboard,
  copyEntry,
  ensureThumbnail,
  type ClipEntry,
} from "../utils/clipboard"
import app from "ags/gtk4/app"
import GLib from "gi://GLib"
import Pango from "gi://Pango"

type ClipboardMenuState = {
  isOpen: Accessor<boolean>
  setOpen: (open: boolean) => void
}

const LAYER_STATE = new LayerState<ClipboardMenuState>()

// Max rows rendered at once (cap for performance). Filter all entries by search, then show the first N.
const MAX_RENDERED = 100

export type ClipboardAction = "toggle" | "open" | "close"

// Control the clipboard history from outside (e.g. the ShojiWM config via ags request).
export function controlClipboardMenu(
  connector: string | null,
  action: ClipboardAction = "toggle",
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

export function ClipboardMenuLayer({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  const [isOpen, setIsOpen] = createState(false)
  const [mounted, setMounted] = createState(false)

  const [search, setSearch] = createState("")
  const [selectedIndex, setSelectedIndex] = createState(0)
  const [entries, setEntries] = createState<ClipEntry[]>([])

  // Filter previews by the search string (all when empty). The number of rendered
  // rows is capped for performance (history holds up to 750; widget-ifying all rows at once is heavy).
  const results = createComputed(() => {
    const query = search().trim().toLowerCase()
    const all = entries()
    const filtered =
      query.length === 0
        ? all
        : all.filter((entry) => entry.preview.toLowerCase().includes(query))
    return filtered.slice(0, MAX_RENDERED)
  })

  let entryRef: Gtk.Entry | null = null
  let scrolledRef: Gtk.ScrolledWindow | null = null
  let listRef: Gtk.Box | null = null

  // selected row -> widget map. Used for auto-scroll
  const rowMap = new Map<string, Gtk.Widget>()

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
      setSearch("")
      setSelectedIndex(0)
      setMounted(true)

      // Fetch the latest history each time it opens
      listClipboard()
        .then((list) => setEntries(list))
        .catch((err) => console.error(err))

      openIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        openIdleId = null
        setIsOpen(true)
        if (entryRef !== null) {
          entryRef.set_text("")
          entryRef.grab_focus()
        }
        return GLib.SOURCE_REMOVE
      })
    } else {
      setIsOpen(false)
      closeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        closeTimeoutId = null
        if (!isOpen()) {
          setMounted(false)
        }
        return GLib.SOURCE_REMOVE
      })
    }
  }

  const states = { isOpen, setOpen }
  LAYER_STATE.set(gdkmonitor, states)

  // Copy the selected entry back onto the clipboard and close the menu
  function copySelected() {
    const target = results()[selectedIndex()]
    if (target) {
      copyEntry(target.id).catch((err) => console.error(err))
      setOpen(false)
    }
  }

  function scrollSelectedIntoView() {
    const target = results()[selectedIndex()]
    if (!target || scrolledRef === null || listRef === null) {
      return
    }
    const widget = rowMap.get(target.id)
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
      cssName="ClipboardMenu"
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
            <image cssName={"SearchBoxIcon"} file={`${SRC}/assets/search.svg`} />
            <entry
              $={(self) => (entryRef = self)}
              cssName={"SearchBoxEntry"}
              placeholderText={" Search clipboard..."}
              halign={Gtk.Align.FILL}
              hexpand
              onNotifyText={(self) => {
                setSearch(self.text)
                setSelectedIndex(0)
              }}
              onActivate={() => copySelected()}
            />
          </box>
          <Gtk.Separator
            cssName={"SearchBoxSeparator"}
            orientation={Gtk.Orientation.HORIZONTAL}
          />
          <scrolledwindow
            $={(self) => (scrolledRef = self)}
            cssName={"ClipList"}
            hexpand
            vexpand
            hscrollbarPolicy={Gtk.PolicyType.NEVER}
            vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
          >
            <box
              $={(self) => (listRef = self)}
              cssName={"ClipListInner"}
              orientation={Gtk.Orientation.VERTICAL}
              halign={Gtk.Align.FILL}
              valign={Gtk.Align.START}
              hexpand
            >
              <For each={results} id={(entry: ClipEntry) => entry.id}>
                {(entry: ClipEntry, index: Accessor<number>) => {
                  const row = buildClipRow(entry, index, selectedIndex, () => {
                    copyEntry(entry.id).catch((err) => console.error(err))
                    setOpen(false)
                  })
                  rowMap.set(entry.id, row)
                  onCleanup(() => rowMap.delete(entry.id))
                  return row
                }}
              </For>
            </box>
          </scrolledwindow>
        </box>
      </box>
    </box>
  ) as Gtk.Box

  const window = (
    <window
      name="clipboardmenulayer"
      class="ClipboardMenuLayer"
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
        copySelected()
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

// A row for one history entry. Text shows a preview; images show a thumbnail + dimensions label.
function buildClipRow(
  entry: ClipEntry,
  index: Accessor<number>,
  selectedIndex: Accessor<number>,
  onActivate: () => void,
): Gtk.Widget {
  const klass = createComputed(() =>
    selectedIndex() === index() ? "selected" : "",
  )

  let content: Gtk.Widget
  if (entry.isImage) {
    const [hasThumb, setHasThumb] = createState(false)
    let picture: Gtk.Picture | null = null

    content = (
      <box
        cssName={"ClipButtonInner"}
        orientation={Gtk.Orientation.HORIZONTAL}
        halign={Gtk.Align.FILL}
        hexpand
      >
        <Gtk.Picture
          cssName={"ClipThumb"}
          visible={hasThumb}
          heightRequest={130}
          halign={Gtk.Align.START}
          valign={Gtk.Align.CENTER}
          $={(self) => {
            picture = self
            self.set_can_shrink(true)
            self.set_content_fit(Gtk.ContentFit.CONTAIN)
          }}
        />
        <label
          cssName={"ClipButtonLabel"}
          label={`Image · ${entry.imageType ?? "img"} ${entry.dims ?? ""}`.trim()}
          halign={Gtk.Align.START}
          valign={Gtk.Align.CENTER}
          ellipsize={Pango.EllipsizeMode.END}
        />
      </box>
    ) as Gtk.Widget

    ensureThumbnail(entry)
      .then((path) => {
        if (path && picture) {
          picture.set_filename(path)
          setHasThumb(true)
        }
      })
      .catch((err) => console.error(err))
  } else {
    content = (
      <box
        cssName={"ClipButtonInner"}
        orientation={Gtk.Orientation.HORIZONTAL}
        halign={Gtk.Align.FILL}
        hexpand
      >
        <label
          cssName={"ClipButtonLabel"}
          label={entry.preview}
          halign={Gtk.Align.START}
          ellipsize={Pango.EllipsizeMode.END}
        />
      </box>
    ) as Gtk.Widget
  }

  return (
    <button cssName={"ClipButton"} class={klass} canFocus={false} onClicked={onActivate}>
      {content}
    </button>
  ) as Gtk.Widget
}
