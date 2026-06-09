import { Astal, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { createRoot, createState, onCleanup } from "gnim"
import GLib from "gi://GLib"
import type AstalNotifd from "gi://AstalNotifd"
import { notifd } from "../utils/statusServices"
import { notificationRow } from "./StatusMenu"

// Display time per item. After it elapses, slide out to the right and hide
// (does not dismiss: it stays in the notification list).
const POPUP_TIMEOUT_MS = 5000
// Animation time (the shorter of the NotifRow CSS transition and the Revealer's
// transitionDuration. The CSS 500ms and Revealer 240ms run in series).
const REVEALER_MS = 240
const CSS_MS = 500
// Max stacked at once. When it overflows, drop the oldest first.
const MAX_POPUPS = 5

type Entry = {
  id: number
  revealer: Gtk.Revealer
  dispose: () => void
  hideTimerId: number | null
  token: number
}

export function NotifPopupLayer({
  gdkmonitor,
}: {
  gdkmonitor: import("gi://Gdk").default.Monitor
}) {
  const { TOP, RIGHT } = Astal.WindowAnchor

  const list = (
    <box
      cssName="NotifPopupList"
      orientation={Gtk.Orientation.VERTICAL}
      spacing={4}
      valign={Gtk.Align.START}
    />
  ) as Gtk.Box

  const entries = new Map<number, Entry>()
  let tokenCounter = 0
  // Materialize the layer window only when there is at least one popup.
  // - Performance (don't keep it resident over wallpaper or games)
  // - Avoid swallowing clicks in transparent areas (visible=false means no surface at all)
  const [windowVisible, setWindowVisible] = createState(false)

  function bumpToken(id: number): number {
    tokenCounter += 1
    const e = entries.get(id)
    if (e) e.token = tokenCounter
    return tokenCounter
  }
  function tokenValid(id: number, token: number): boolean {
    const e = entries.get(id)
    return e !== undefined && e.token === token
  }

  function scheduleAutoHide(id: number) {
    const entry = entries.get(id)
    if (!entry) return
    if (entry.hideTimerId !== null) {
      GLib.source_remove(entry.hideTimerId)
      entry.hideTimerId = null
    }
    entry.hideTimerId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      POPUP_TIMEOUT_MS,
      () => {
        const e = entries.get(id)
        if (e) e.hideTimerId = null
        startSlideOut(id)
        return GLib.SOURCE_REMOVE
      },
    )
  }

  function showPopup(n: AstalNotifd.Notification) {
    const id = n.id

    // If already shown, just reset the timer (update-notification case).
    if (entries.has(id)) {
      scheduleAutoHide(id)
      return
    }

    // If we'd exceed the simultaneous limit, hide the oldest.
    while (entries.size >= MAX_POPUPS) {
      const oldestId = entries.keys().next().value
      if (oldestId === undefined || oldestId === id) break
      startSlideOut(oldestId)
      break
    }

    // 0 -> first item: materialize the layer window.
    if (entries.size === 0) setWindowVisible(true)

    createRoot((dispose) => {
      const row = notificationRow(n)
      row.add_css_class("entering")
      const revealer = new Gtk.Revealer({
        transitionType: Gtk.RevealerTransitionType.SLIDE_DOWN,
        transitionDuration: REVEALER_MS,
        revealChild: false,
      })
      revealer.set_child(row)

      const entry: Entry = {
        id,
        revealer,
        dispose,
        hideTimerId: null,
        token: 0,
      }
      entries.set(id, entry)
      const token = bumpToken(id)
      list.append(revealer)

      // Enter sequence: expand the Revealer -> after it completes, remove the entering class for the CSS slide-in.
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        if (!tokenValid(id, token)) return GLib.SOURCE_REMOVE
        revealer.set_reveal_child(true)
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, REVEALER_MS + 20, () => {
          if (!tokenValid(id, token)) return GLib.SOURCE_REMOVE
          const c = revealer.get_child()
          if (c) c.remove_css_class("entering")
          return GLib.SOURCE_REMOVE
        })
        return GLib.SOURCE_REMOVE
      })

      scheduleAutoHide(id)
    })
  }

  function startSlideOut(id: number) {
    const entry = entries.get(id)
    if (!entry) return
    const token = bumpToken(id)
    if (entry.hideTimerId !== null) {
      GLib.source_remove(entry.hideTimerId)
      entry.hideTimerId = null
    }
    const child = entry.revealer.get_child()
    if (child) {
      child.remove_css_class("entering")
      child.add_css_class("leaving")
    }
    // Phase 1: CSS slide-out (to the right).
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, CSS_MS + 20, () => {
      if (!tokenValid(id, token)) return GLib.SOURCE_REMOVE
      // Phase 2: collapse the Revealer.
      entry.revealer.set_reveal_child(false)
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, REVEALER_MS + 20, () => {
        if (!tokenValid(id, token)) return GLib.SOURCE_REMOVE
        try {
          list.remove(entry.revealer)
        } catch {
          // ignore
        }
        entry.dispose()
        entries.delete(id)
        // When the last item disappears, hide the window itself.
        if (entries.size === 0) setWindowVisible(false)
        return GLib.SOURCE_REMOVE
      })
      return GLib.SOURCE_REMOVE
    })
  }

  // New notification -> show popup. Skip while in DND.
  const notifiedHandlerId = notifd.connect("notified", (_self, id: number) => {
    if (notifd.dontDisturb) return
    const n = notifd.get_notification(id)
    if (n) showPopup(n)
  })
  // When a notification is dismissed/resolved (via the popup's close button, the notification list, or
  // resolved by the app), hide the popup too.
  const resolvedHandlerId = notifd.connect(
    "resolved",
    (_self, id: number) => {
      if (entries.has(id)) startSlideOut(id)
    },
  )

  const win = (
    <window
      name="notifpopuplayer"
      class="NotifPopupLayer"
      gdkmonitor={gdkmonitor}
      layer={Astal.Layer.OVERLAY}
      exclusivity={Astal.Exclusivity.NORMAL}
      keymode={Astal.Keymode.NONE}
      // TOP|RIGHT only: the surface fits the popup's natural size,
      // so clicks outside it aren't swallowed. The gap below the Bar / from the screen's
      // right edge is taken via layer-shell margin (CSS padding would inflate the surface
      // and the transparent area would swallow clicks).
      anchor={TOP | RIGHT}
      marginTop={38}
      marginRight={10}
      application={app}
      visible={windowVisible}
    >
      <box
        cssName="NotifPopupContainer"
        orientation={Gtk.Orientation.VERTICAL}
        halign={Gtk.Align.END}
        valign={Gtk.Align.START}
      >
        {list}
      </box>
    </window>
  ) as Gtk.Window

  onCleanup(() => {
    try {
      notifd.disconnect(notifiedHandlerId)
      notifd.disconnect(resolvedHandlerId)
    } catch {
      // ignore
    }
    for (const e of entries.values()) {
      if (e.hideTimerId !== null) GLib.source_remove(e.hideTimerId)
      try {
        e.dispose()
      } catch {
        // ignore
      }
    }
    entries.clear()
  })

  return win
}
