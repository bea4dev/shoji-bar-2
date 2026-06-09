import { Gtk } from "ags/gtk4"

// (x, y) are in the coordinate space of root (the widget the gesture is attached to).
// widget.contains() expects coordinates in that widget's own local space, so
// if it is shifted by halign=CENTER or a transform, the spaces don't match and it misjudges.
//
// Instead, use GTK's own hit-test pick(): take the widget at the click position and
// walk up its ancestors to decide whether it is target (or a descendant of it).
// This judges inside/outside correctly even with centering or CSS transforms.
export function isPointInsideWidget(
  root: Gtk.Widget,
  target: Gtk.Widget,
  x: number,
  y: number,
): boolean {
  let widget: Gtk.Widget | null = root.pick(x, y, Gtk.PickFlags.DEFAULT)

  while (widget !== null) {
    if (widget === target) {
      return true
    }
    widget = widget.get_parent()
  }

  return false
}
