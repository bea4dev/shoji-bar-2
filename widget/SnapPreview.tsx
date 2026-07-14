import { Astal, Gdk, Gtk } from "ags/gtk4"
import { createComputed, createState, onCleanup } from "gnim"
import GLib from "gi://GLib"
import Cairo from "gi://cairo"
import { snapPreview, type SnapPreview } from "../utils/workspaceState"

// How long the fade-out lasts before the layer is unmounted (matches the CSS
// opacity transition on .SnapPreviewBox).
const FADE_OUT_MS = 220

// Snap-zone preview overlay, one per monitor. ShojiWM broadcasts the target
// rect (monitor-local logical px) during a window drag; we draw a rounded
// rectangle there with an expanding pop-in and an opacity fade-out.
//
// The layer covers the whole monitor (constant surface size) and the preview
// box is positioned inside via margins. The surface input region is cleared so
// the overlay never intercepts the drag or post-drop clicks.
export function SnapPreviewLayer({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  const connector = gdkmonitor.get_connector() ?? ""
  const { TOP, LEFT, RIGHT, BOTTOM } = Astal.WindowAnchor

  // Last non-null rect: kept while fading out so the box stays in place.
  const [rect, setRect] = createState<SnapPreview>(null)
  const [mounted, setMounted] = createState(false)
  // `shown` drives opacity, `grown` drives scale. They are toggled together on
  // first appearance (in a single update) so there is never a frame where the
  // box is opaque at full scale — which previously flashed like a maximized
  // window when the maximize zone appeared.
  const [shown, setShown] = createState(false)
  const [grown, setGrown] = createState(false)

  let hideTimeoutId: number | null = null
  let showIdleId: number | null = null
  let regrowIdleId: number | null = null

  function clearHideTimeout() {
    if (hideTimeoutId !== null) {
      GLib.source_remove(hideTimeoutId)
      hideTimeoutId = null
    }
  }

  function clearIdles() {
    if (showIdleId !== null) {
      GLib.source_remove(showIdleId)
      showIdleId = null
    }
    if (regrowIdleId !== null) {
      GLib.source_remove(regrowIdleId)
      regrowIdleId = null
    }
  }

  function react() {
    const preview = snapPreview()[connector] ?? null

    if (preview) {
      clearHideTimeout()
      const wasShown = shown()
      setRect(preview)
      setMounted(true)

      if (!wasShown) {
        // First appearance: mount in the base (scaled-down, transparent) state,
        // then on the next idle flip opacity + scale together so both
        // transitions run from the base — fading in while expanding.
        if (showIdleId !== null) {
          GLib.source_remove(showIdleId)
        }
        showIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
          showIdleId = null
          setShown(true)
          setGrown(true)
          return GLib.SOURCE_REMOVE
        })
      } else {
        // Already visible, the target zone changed: replay only the expand
        // (opacity stays at 1) so the new region pops without a fade.
        setGrown(false)
        if (regrowIdleId !== null) {
          GLib.source_remove(regrowIdleId)
        }
        regrowIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
          regrowIdleId = null
          setGrown(true)
          return GLib.SOURCE_REMOVE
        })
      }
    } else {
      setShown(false)
      setGrown(false)
      clearHideTimeout()
      hideTimeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        FADE_OUT_MS,
        () => {
          hideTimeoutId = null
          if (!shown()) {
            setMounted(false)
          }
          return GLib.SOURCE_REMOVE
        },
      )
    }
  }

  snapPreview.subscribe(react)
  onCleanup(() => {
    clearHideTimeout()
    clearIdles()
  })

  const className = createComputed(() =>
    [shown() ? "shown" : "", grown() ? "grown" : ""].filter(Boolean).join(" "),
  )

  return (
    <window
      name="snap-preview"
      namespace="no_blur"
      class="SnapPreviewLayer"
      gdkmonitor={gdkmonitor}
      layer={Astal.Layer.OVERLAY}
      // IGNORE so the surface spans the full monitor (does not get pushed below
      // the bar's exclusive zone). The preview rects are already monitor-local
      // (relative to the true monitor top), so the surface origin must match.
      exclusivity={Astal.Exclusivity.IGNORE}
      anchor={TOP | LEFT | RIGHT | BOTTOM}
      visible={mounted}
      $={(self) => {
        onCleanup(() => self.destroy())
        // Make the whole surface click-through so the overlay never steals the
        // drag or a click during the fade-out. The surface size is constant
        // (full monitor), so an empty input region set on map stays valid.
        const apply = () => {
          const surface = self.get_surface()
          if (surface) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              surface.set_input_region(new Cairo.Region() as any)
            } catch {
              // Cairo region unavailable — fall back to default (no harm during
              // the drag itself since the compositor holds a pointer grab).
            }
          }
        }
        self.connect("map", apply)
        if (self.get_mapped()) {
          apply()
        }
      }}
    >
      <box
        cssName="SnapPreviewBox"
        class={className}
        halign={Gtk.Align.START}
        valign={Gtk.Align.START}
        marginStart={rect((r) => Math.round(r?.x ?? 0))}
        marginTop={rect((r) => Math.round(r?.y ?? 0))}
        widthRequest={rect((r) => Math.max(1, Math.round(r?.width ?? 1)))}
        heightRequest={rect((r) => Math.max(1, Math.round(r?.height ?? 1)))}
      />
    </window>
  )
}
