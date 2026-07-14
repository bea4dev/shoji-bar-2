import { Astal, Gdk, Gtk } from "ags/gtk4"
import { Accessor, createState, onCleanup } from "gnim"
import { createPoll } from "ags/time"
import { LayerState } from "../utils/LayerState"
import { isPointInsideWidget } from "../utils/pointInside"
import GLib from "gi://GLib"

type ClockMenuState = {
  isOpen: Accessor<boolean>
  setOpen: (open: boolean) => void
}

const LAYER_STATE = new LayerState<ClockMenuState>()

// Current time, updated every second. Shared across all monitors
const now = createPoll(GLib.DateTime.new_now_local(), 1000, () =>
  GLib.DateTime.new_now_local(),
)

// Whether the locale is Japanese. Use Japanese formatting if so, English otherwise
const IS_JP = GLib.get_language_names()[0].toLowerCase().startsWith("ja")

// get_day_of_week(): 1=Mon ... 7=Sun
const WEEKDAYS_JP = ["月", "火", "水", "木", "金", "土", "日"]
const WEEKDAYS_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const WEEKDAYS_EN_FULL = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]
// get_month(): 1=January ... 12=December
const MONTHS_EN = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

// Locale-aware short weekday name (e.g. Fri, or localized in a Japanese locale).
function weekday(dt: GLib.DateTime): string {
  const i = dt.get_day_of_week() - 1
  return IS_JP ? WEEKDAYS_JP[i] : WEEKDAYS_EN[i]
}

// Locale-aware date (e.g. Friday, June 5, 2026, or the Japanese form in a JP locale).
function dateLabel(dt: GLib.DateTime): string {
  if (IS_JP) {
    return `${dt.get_year()}年${dt.get_month()}月${dt.get_day_of_month()}日 (${WEEKDAYS_JP[dt.get_day_of_week() - 1]})`
  }
  return `${WEEKDAYS_EN_FULL[dt.get_day_of_week() - 1]}, ${MONTHS_EN[dt.get_month() - 1]} ${dt.get_day_of_month()}, ${dt.get_year()}`
}

// e.g. Asia/Tokyo · JST (UTC+09:00)
function timezoneLabel(dt: GLib.DateTime): string {
  const identifier = dt.get_timezone().get_identifier()
  return `${identifier} · ${dt.format("%Z")} (UTC${dt.format("%:z")})`
}

export function ClockButton({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  return (
    <button
      cssName="ClockButton"
      class={LAYER_STATE.then(gdkmonitor, (state) =>
        state.isOpen((isOpen) => (isOpen ? "pressed" : "")),
      )}
      onClicked={() =>
        LAYER_STATE.then(gdkmonitor, (state) => state.setOpen(!state.isOpen()))
      }
    >
      <label
        cssName="ClockButtonLabel"
        label={now(
          (dt) => `${dt.format("%m/%d")} ${weekday(dt)} ${dt.format("%H:%M")}`,
        )}
      />
    </button>
  )
}

export function ClockMenuLayer({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  const [isOpen, setIsOpen] = createState(false)
  const [mounted, setMounted] = createState(false)

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
      setMounted(true)

      // Add the open class after mounted=true takes effect
      // Splitting these is needed or the transition sometimes doesn't fire
      openIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        openIdleId = null
        setIsOpen(true)
        return GLib.SOURCE_REMOVE
      })
    } else {
      setIsOpen(false)

      // Remove the window after the CSS transition finishes
      closeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
        closeTimeoutId = null

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

  const { TOP, LEFT, RIGHT, BOTTOM } = Astal.WindowAnchor

  const inner = (
    <box
      cssName="ClockMenu"
      class={isOpen((open) => (open ? "open" : "close"))}
      orientation={Gtk.Orientation.VERTICAL}
      halign={Gtk.Align.CENTER}
      valign={Gtk.Align.START}
    >
      {/* Padding so it can tuck under the bar (same as StartMenu's FirstPadding) */}
      <box cssName="FirstPadding" />

      {/* Top island: date/weekday + clock + timezone */}
      <box
        cssName="ClockIsland"
        orientation={Gtk.Orientation.VERTICAL}
        halign={Gtk.Align.FILL}
        hexpand
      >
        <label
          cssName="ClockDate"
          halign={Gtk.Align.CENTER}
          label={now((dt) => dateLabel(dt))}
        />
        <label
          cssName="ClockTime"
          halign={Gtk.Align.CENTER}
          label={now((dt) => dt.format("%H:%M:%S") ?? "")}
        />
        <label
          cssName="ClockTimezone"
          halign={Gtk.Align.CENTER}
          label={now((dt) => timezoneLabel(dt))}
        />
      </box>

      {/* Bottom island: calendar */}
      <box
        cssName="CalendarIsland"
        orientation={Gtk.Orientation.VERTICAL}
        halign={Gtk.Align.FILL}
        hexpand
      >
        <Gtk.Calendar
          cssName="Calendar"
          showHeading
          showDayNames
          showWeekNumbers={false}
          hexpand
        />
      </box>
    </box>
  ) as Gtk.Box

  const window = (
    <window
      name="clockmenulayer"
      class="ClockMenuLayer"
      gdkmonitor={gdkmonitor}
      layer={Astal.Layer.OVERLAY}
      exclusivity={Astal.Exclusivity.NORMAL}
      keymode={Astal.Keymode.ON_DEMAND}
      anchor={TOP | LEFT | RIGHT | BOTTOM}
      $={(self) => onCleanup(() => self.destroy())}
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
