import { Gtk } from "ags/gtk4"
import { For, createBinding, onCleanup } from "gnim"
import AstalTray from "gi://AstalTray"

// SNI (StatusNotifierItem) host. Aggregates apps' tray icons.
const tray = AstalTray.get_default()

// Bar system tray. Lays out tray items horizontally; hidden when there are 0 items.
// Wrap everything in a gray translucent rounded box so it reads as a tray.
export function SystemTray() {
  const items = createBinding(tray, "items")

  return (
    <box
      cssName="SystemTray"
      visible={items((list) => list.length > 0)}
      valign={Gtk.Align.CENTER}
    >
      <For each={items}>
        {(item: AstalTray.TrayItem) => buildTrayItem(item)}
      </For>
    </box>
  )
}

// One item = one button. Click opens the dbusmenu popover.
// Items without a menu fall back to activate().
function buildTrayItem(item: AstalTray.TrayItem): Gtk.Widget {
  let popover: Gtk.PopoverMenu | null = null

  const button = (
    <button
      cssName="SystemTrayItem"
      tooltipText={createBinding(item, "tooltipText")}
      onClicked={() => {
        // Call about_to_show before showing, in case the menu is generated lazily
        item.about_to_show()
        const model = item.get_menu_model()
        if (model) {
          if (!popover) {
            popover = Gtk.PopoverMenu.new_from_model(model)
            popover.set_has_arrow(true)
            popover.set_position(Gtk.PositionType.BOTTOM)
            // Scoping class (prevents the global theme from bleeding through)
            popover.add_css_class("SystemTrayPopover")
            popover.set_parent(button)
          } else {
            popover.set_menu_model(model)
          }
          const actionGroup = item.get_action_group()
          if (actionGroup) {
            button.insert_action_group("dbusmenu", actionGroup)
          }
          popover.popup()
        } else {
          // Items without a menu: activate on left click
          item.activate(0, 0)
        }
      }}
    >
      <image
        cssName="SystemTrayIcon"
        gicon={createBinding(item, "gicon")}
        pixelSize={16}
      />
    </button>
  ) as Gtk.Widget

  onCleanup(() => {
    if (popover) {
      popover.unparent()
      popover = null
    }
  })

  return button
}
