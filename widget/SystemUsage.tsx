import { Gtk } from "ags/gtk4"
import { Accessor, createComputed, createState } from "gnim"
import {
  cpuCoreCount,
  cpuUsage,
  formatKbAsGiB,
  loadAverage,
  memAvailableKb,
  memTotalKb,
  memUsage,
  swapFreeKb,
  swapTotalKb,
} from "../utils/statusServices"

/**
 * CPU / memory indicators on the bar. Visually identical to BatteryButton:
 * a monospace "%X" label + icon, with an accent background and dark icon while
 * the popover is open, and a popover with detailed readings. Both share the
 * generic Usage* cssNames so a single style block covers them.
 */

type DetailRow = { label: string; value: Accessor<string> }

function percentLabel(usage: Accessor<number>): Accessor<string> {
  return createComputed(
    () => `${Math.round(Math.max(0, Math.min(1, usage())) * 100)}%`,
  )
}

function UsageButton(props: {
  iconBase: string
  usage: Accessor<number>
  subtitle: string
  details: DetailRow[]
}) {
  // Popover open/closed state, mirrored from menubutton.active. Drives the
  // pressed class (accent background) and the dark icon swap.
  const [pressed, setPressed] = createState(false)
  const percent = percentLabel(props.usage)

  // When pressed (= popover open) the button is on an accent background, so use
  // the -dark icon variant; otherwise the white one.
  const iconFile = createComputed(
    () => `${SRC}/assets/${props.iconBase}${pressed() ? "-dark" : ""}.svg`,
  )
  // The large popover icon always sits on bg-color, so keep it white.
  const iconFileWhite = `${SRC}/assets/${props.iconBase}.svg`

  return (
    <menubutton
      cssName="UsageButton"
      class={pressed((p) => (p ? "pressed" : ""))}
      valign={Gtk.Align.CENTER}
      $={(self) => {
        self.connect("notify::active", () => setPressed(self.get_active()))
        const row = (
          <box cssName="UsageRow" spacing={4} valign={Gtk.Align.CENTER}>
            <label cssName="UsagePercent" label={percent} />
            <image cssName="UsageIcon" file={iconFile} pixelSize={14} />
          </box>
        ) as Gtk.Widget
        self.set_child(row)
      }}
    >
      <popover cssName="UsagePopover" hasArrow={false}>
        <box
          cssName="UsagePopoverBox"
          orientation={Gtk.Orientation.VERTICAL}
          spacing={6}
        >
          <box
            cssName="UsagePopoverHeader"
            spacing={10}
            valign={Gtk.Align.CENTER}
          >
            <image
              cssName="UsagePopoverIcon"
              file={iconFileWhite}
              pixelSize={28}
            />
            <box orientation={Gtk.Orientation.VERTICAL}>
              <label
                cssName="UsagePopoverPercent"
                halign={Gtk.Align.START}
                label={percent}
              />
              <label
                cssName="UsagePopoverState"
                halign={Gtk.Align.START}
                label={props.subtitle}
              />
            </box>
          </box>

          <box cssName="UsagePopoverSep" />

          {props.details.map((d) => detailRow(d.label, d.value))}
        </box>
      </popover>
    </menubutton>
  )
}

function detailRow(label: string, value: Accessor<string>): Gtk.Widget {
  return (
    <box cssName="UsageDetailRow" spacing={8}>
      <label
        cssName="UsageDetailLabel"
        halign={Gtk.Align.START}
        hexpand
        label={label}
      />
      <label cssName="UsageDetailValue" halign={Gtk.Align.END} label={value} />
    </box>
  ) as Gtk.Widget
}

export function CpuButton() {
  const loadText = (index: number) =>
    createComputed(() => (loadAverage()[index] ?? 0).toFixed(2))

  return UsageButton({
    iconBase: "cpu",
    usage: cpuUsage,
    subtitle: "CPU usage",
    details: [
      {
        label: "Cores",
        value: createComputed(() => {
          const n = cpuCoreCount()
          return n > 0 ? n.toString() : "—"
        }),
      },
      { label: "Load (1m)", value: loadText(0) },
      { label: "Load (5m)", value: loadText(1) },
      { label: "Load (15m)", value: loadText(2) },
    ],
  })
}

export function MemoryButton() {
  return UsageButton({
    iconBase: "memory",
    usage: memUsage,
    subtitle: "Memory usage",
    details: [
      {
        label: "Used",
        value: createComputed(() =>
          formatKbAsGiB(Math.max(0, memTotalKb() - memAvailableKb())),
        ),
      },
      { label: "Total", value: createComputed(() => formatKbAsGiB(memTotalKb())) },
      {
        label: "Available",
        value: createComputed(() => formatKbAsGiB(memAvailableKb())),
      },
      {
        label: "Swap",
        value: createComputed(() => {
          const total = swapTotalKb()
          if (total <= 0) return "—"
          const used = Math.max(0, total - swapFreeKb())
          return `${formatKbAsGiB(used)} / ${formatKbAsGiB(total)}`
        }),
      },
    ],
  })
}
