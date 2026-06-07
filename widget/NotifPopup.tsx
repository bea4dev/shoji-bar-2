import { Astal, Gtk } from "ags/gtk4"
import app from "ags/gtk4/app"
import { createRoot, createState, onCleanup } from "gnim"
import GLib from "gi://GLib"
import type AstalNotifd from "gi://AstalNotifd"
import { notifd } from "../utils/statusServices"
import { notificationRow } from "./StatusMenu"

// 1 件あたりの表示時間。経過後は右へスライドアウトして非表示にする
// (dismiss はしない: 通知欄には残る)。
const POPUP_TIMEOUT_MS = 5000
// アニメ時間 (NotifRow CSS の transition と Revealer の transitionDuration の
// 短いほう。CSS 側の 500ms と Revealer 240ms を直列に動かす)。
const REVEALER_MS = 240
const CSS_MS = 500
// 一度に積み上げる最大件数。あふれたら古い方から消す。
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
  // popup が 1 件以上あるときだけ layer window を実体化する。
  // - 性能 (壁紙やゲーム上で常駐させない)
  // - 透明領域のクリック吸い込み防止 (visible=false ならサーフェス自体が無い)
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

    // 既に出ているなら timer だけリセット (更新通知のケース)。
    if (entries.has(id)) {
      scheduleAutoHide(id)
      return
    }

    // 同時表示数の上限を超えそうなら最古を hide させる。
    while (entries.size >= MAX_POPUPS) {
      const oldestId = entries.keys().next().value
      if (oldestId === undefined || oldestId === id) break
      startSlideOut(oldestId)
      break
    }

    // 0 → 1 件目: layer window を実体化。
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

      // Enter sequence: Revealer 展開 → 完了後に entering クラス除去で CSS slide-in。
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
    // Phase 1: CSS slide-out (右へ).
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, CSS_MS + 20, () => {
      if (!tokenValid(id, token)) return GLib.SOURCE_REMOVE
      // Phase 2: Revealer 折りたたみ.
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
        // 最後の 1 件が消えたら window 自体を非表示に。
        if (entries.size === 0) setWindowVisible(false)
        return GLib.SOURCE_REMOVE
      })
      return GLib.SOURCE_REMOVE
    })
  }

  // 新着通知 → popup 表示。DND 中はスキップ。
  const notifiedHandlerId = notifd.connect("notified", (_self, id: number) => {
    if (notifd.dontDisturb) return
    const n = notifd.get_notification(id)
    if (n) showPopup(n)
  })
  // 通知が dismiss/resolve された (popup の close ボタン経由 or 通知欄経由 or
  // app 側からの解決) ら popup も hide。
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
      // TOP|RIGHT のみ: サーフェスは popup の natural サイズに収まり、
      // その外側はクリック吸い込みが起きない。Bar の下 / 画面右端からの
      // 隙間は layer-shell margin で取る (CSS padding だとサーフェスが
      // 膨らんで透明領域がクリックを吸ってしまう)。
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
