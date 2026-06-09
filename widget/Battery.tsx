import { Gtk } from "ags/gtk4"
import { createComputed, createState } from "gnim"
import {
  batteryChargeCycles,
  batteryCharging,
  batteryEnergyRate,
  batteryIconName,
  batteryPercentage,
  batteryPresent,
  batteryState,
  batteryStateLabel,
  batteryTemperature,
  batteryTimeToEmpty,
  batteryTimeToFull,
  formatBatteryDuration,
} from "../utils/statusServices"

/**
 * Battery indicator on the bar.
 * - Hide the widget itself when not present
 *   (`visible` binding: presence basically doesn't change after startup, so
 *    reactive issues are unlikely)
 * - Switch the icon based on charge level
 * - Monospace 3-digit "%X" display
 * - Click to open a popover with detailed info
 */
export function BatteryButton() {
  // Popover open/closed state (tied to the menubutton's active property).
  // Toggle the pressed class for the same accent background as other bar buttons + swap the icon
  // to the black version.
  const [pressed, setPressed] = createState(false)

  // 0..1 to a 0..100 integer. The font stays monospace (fixed width), but
  // since it comes before the icon (leftmost), padding with spaces looks bad. We don't
  // padStart; digit-count changes are absorbed on the right (= the icon position).
  const percentLabel = createComputed(() => {
    const p = batteryPercentage()
    const n = Math.round(Math.max(0, Math.min(1, p)) * 100)
    return `${n}%`
  })

  // Icon filename: determined by the percentage / state / pressed combination.
  // When pressed (= popover open) it's on an accent background, so use -dark.
  const iconFile = createComputed(() => {
    batteryPercentage()
    batteryState()
    const dark = pressed() ? "-dark" : ""
    return `${SRC}/assets/${batteryIconName()}${dark}.svg`
  })

  // The large icon in the popover always sits on bg-color, so keep it white.
  const iconFileWhite = createComputed(() => {
    batteryPercentage()
    batteryState()
    return `${SRC}/assets/${batteryIconName()}.svg`
  })

  // ---- popover content ----
  // Remaining time: timeToEmpty when discharging, timeToFull when charging.
  const remainingText = createComputed(() => {
    if (batteryCharging()) {
      const t = batteryTimeToFull()
      return t > 0 ? `${formatBatteryDuration(t)} to full` : "Calculating..."
    }
    const t = batteryTimeToEmpty()
    return t > 0 ? `${formatBatteryDuration(t)} remaining` : "Calculating..."
  })

  const stateText = createComputed(() => {
    batteryState()
    return batteryStateLabel()
  })

  const rateText = createComputed(() => {
    const r = batteryEnergyRate()
    if (!isFinite(r) || r <= 0) return "—"
    return `${r.toFixed(1)} W`
  })

  const cyclesText = createComputed(() => {
    const c = batteryChargeCycles()
    return c > 0 ? c.toString() : "—"
  })

  const tempText = createComputed(() => {
    const t = batteryTemperature()
    if (!isFinite(t) || t === 0) return "—"
    return `${t.toFixed(1)} °C`
  })

  const percentBigText = createComputed(() => {
    const p = batteryPercentage()
    return `${Math.round(p * 100)}%`
  })

  return (
    <menubutton
      cssName="BatteryButton"
      class={pressed((p) => (p ? "pressed" : ""))}
      visible={batteryPresent}
      valign={Gtk.Align.CENTER}
      $={(self) => {
        // Reflect popover open/close into the pressed state (observe menubutton.active).
        self.connect("notify::active", () => setPressed(self.get_active()))
        // We want the menubutton's child to be an image with a label beside it, so
        // build the box ourselves.
        const row = (
          <box cssName="BatteryRow" spacing={4} valign={Gtk.Align.CENTER}>
            <label cssName="BatteryPercent" label={percentLabel} />
            <image cssName="BatteryIcon" file={iconFile} pixelSize={14} />
          </box>
        ) as Gtk.Widget
        self.set_child(row)
      }}
    >
      <popover cssName="BatteryPopover" hasArrow={false}>
        <box
          cssName="BatteryPopoverBox"
          orientation={Gtk.Orientation.VERTICAL}
          spacing={6}
        >
          <box cssName="BatteryPopoverHeader" spacing={10} valign={Gtk.Align.CENTER}>
            <image
              cssName="BatteryPopoverIcon"
              file={iconFileWhite}
              pixelSize={28}
            />
            <box orientation={Gtk.Orientation.VERTICAL}>
              <label
                cssName="BatteryPopoverPercent"
                halign={Gtk.Align.START}
                label={percentBigText}
              />
              <label
                cssName="BatteryPopoverState"
                halign={Gtk.Align.START}
                label={stateText}
              />
            </box>
          </box>

          <box cssName="BatteryPopoverSep" />

          {detailRow("Remaining", remainingText)}
          {detailRow("Power draw", rateText)}
          {detailRow("Charge cycles", cyclesText)}
          {detailRow("Temperature", tempText)}
        </box>
      </popover>
    </menubutton>
  )
}

function detailRow(
  label: string,
  value: import("gnim").Accessor<string>,
): Gtk.Widget {
  return (
    <box cssName="BatteryDetailRow" spacing={8}>
      <label
        cssName="BatteryDetailLabel"
        halign={Gtk.Align.START}
        hexpand
        label={label}
      />
      <label
        cssName="BatteryDetailValue"
        halign={Gtk.Align.END}
        label={value}
      />
    </box>
  ) as Gtk.Widget
}
