import { Astal, Gdk, Gtk } from "ags/gtk4"
import { createComputed, createRoot, createState } from "gnim"
import app from "ags/gtk4/app"
import GLib from "gi://GLib"
import Gio from "gi://Gio"
import GdkPixbuf from "gi://GdkPixbuf"
import { LayerState } from "../utils/LayerState"
import { isPointInsideWidget } from "../utils/pointInside"
import { identifyMonitors } from "./MonitorIdentify"
import {
  wallpaperConfig,
  effectiveWallpaper,
  listWallpapers,
  setDirectory,
  applyToAllMonitors,
  applyToMonitor,
  clearMonitorOverride,
} from "../utils/wallpaperState"

type WallpaperMenuState = {
  isOpen: ReturnType<typeof createState<boolean>>[0]
  setOpen: (open: boolean) => void
}

const LAYER_STATE = new LayerState<WallpaperMenuState>()

// =============================================================================
// 背景ウィンドウ: layer-shell の BACKGROUND レイヤに壁紙を 1 枚描く。
// effectiveWallpaper(global / per-monitor override) の変化に追従する。
// =============================================================================

export function WallpaperBackground({
  gdkmonitor,
}: {
  gdkmonitor: Gdk.Monitor
}) {
  const connector = gdkmonitor.get_connector()
  const { TOP, LEFT, RIGHT, BOTTOM } = Astal.WindowAnchor

  const path = createComputed(() =>
    effectiveWallpaper(wallpaperConfig(), connector),
  )

  const picture = (
    <Gtk.Picture
      cssName="WallpaperBackgroundPicture"
      contentFit={Gtk.ContentFit.COVER}
      canShrink
    />
  ) as Gtk.Picture

  function applyPath(p: string | null) {
    if (p) {
      picture.set_file(Gio.File.new_for_path(p))
    } else {
      picture.set_file(null)
    }
  }
  applyPath(path())
  path.subscribe(() => applyPath(path()))

  return (
    <window
      name="wallpaper-background"
      class="WallpaperBackground"
      gdkmonitor={gdkmonitor}
      layer={Astal.Layer.BACKGROUND}
      exclusivity={Astal.Exclusivity.IGNORE}
      anchor={TOP | LEFT | RIGHT | BOTTOM}
      application={app}
      visible
    >
      {picture}
    </window>
  )
}

// =============================================================================
// バー上のトリガーボタン
// =============================================================================

export function WallpaperButton({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  return (
    <button
      cssName="WallpaperButton"
      class={LAYER_STATE.then(gdkmonitor, (state) =>
        state.isOpen((isOpen) => (isOpen ? "pressed" : "")),
      )}
      onClicked={() =>
        LAYER_STATE.then(gdkmonitor, (state) => state.setOpen(!state.isOpen()))
      }
    >
      <image
        cssName="WallpaperButtonIcon"
        file={`${SRC}/assets/wallpaper.svg`}
        pixelSize={16}
      />
    </button>
  )
}

// =============================================================================
// プルダウン本体
// =============================================================================

const THUMBNAIL_WIDTH = 168
const THUMBNAIL_HEIGHT = 96

type ThumbnailEntry = {
  path: string
  paintable: GdkPixbuf.Pixbuf | null
}

// Pixbuf 読み込みは CPU/IO コストがあるため一度読んだものをプロセス内でキャッシュ。
const thumbnailCache = new Map<string, GdkPixbuf.Pixbuf>()

function loadThumbnail(path: string, scale: number): GdkPixbuf.Pixbuf | null {
  const key = `${path}|${scale}`
  const cached = thumbnailCache.get(key)
  if (cached) return cached
  try {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
      path,
      THUMBNAIL_WIDTH * scale,
      THUMBNAIL_HEIGHT * scale,
      false, // aspect ratio を維持しない(セル全体を覆う)
    )
    if (pixbuf) {
      thumbnailCache.set(key, pixbuf)
    }
    return pixbuf
  } catch (err) {
    console.error("[wallpaper] failed to load thumbnail:", path, err)
    return null
  }
}

// ディレクトリ内の画像一覧をリアクティブに保持。
const [entries, setEntries] = createState<ThumbnailEntry[]>([])

let inFlightDirectory: string | null = null

function refreshEntries(directory: string, scale: number) {
  inFlightDirectory = directory
  listWallpapers(directory).then((paths) => {
    if (inFlightDirectory !== directory) return
    setEntries(
      paths.map((path) => ({ path, paintable: loadThumbnail(path, scale) })),
    )
  })
}

export function WallpaperLayer({ gdkmonitor }: { gdkmonitor: Gdk.Monitor }) {
  const connector = gdkmonitor.get_connector()
  const scale = gdkmonitor.get_scale_factor()
  const [isOpen, setIsOpen] = createState(false)
  const [mounted, setMounted] = createState(false)
  // "all" = 全モニタに適用 / "this" = このモニタだけ override
  const [applyMode, setApplyMode] = createState<"all" | "this">("all")

  let closeTimeoutId: number | null = null
  let openIdleId: number | null = null
  let dialogPendingTimeoutId: number | null = null

  function clearTimers() {
    if (closeTimeoutId !== null) {
      GLib.source_remove(closeTimeoutId)
      closeTimeoutId = null
    }
    if (openIdleId !== null) {
      GLib.source_remove(openIdleId)
      openIdleId = null
    }
    if (dialogPendingTimeoutId !== null) {
      GLib.source_remove(dialogPendingTimeoutId)
      dialogPendingTimeoutId = null
    }
  }

  function setOpen(open: boolean) {
    clearTimers()

    if (open) {
      // 開くたびに最新のディレクトリ内容を読み直す
      refreshEntries(wallpaperConfig().directory, scale)
      setMounted(true)

      openIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        openIdleId = null
        setIsOpen(true)
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

  const states: WallpaperMenuState = { isOpen, setOpen }
  LAYER_STATE.set(gdkmonitor, states)

  // 設定の directory 変更にも追従(他モニタの WallpaperLayer から更新された場合)
  wallpaperConfig.subscribe(() => {
    if (mounted()) {
      refreshEntries(wallpaperConfig().directory, scale)
    }
  })

  function chooseDirectory() {
    // WallpaperLayer は OVERLAY なので、xdg-shell の FileDialog は下に潜るうえに
    // 全画面の outsideClick ジェスチャでクリックを横取りしてしまう。
    // setOpen(false) でクローズアニメを開始し、surface が unmount された後に
    // ダイアログを出し、戻ってきたら setOpen(true) で再オープンする。
    setOpen(false)

    dialogPendingTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 520, () => {
      dialogPendingTimeoutId = null

      const dialog = new Gtk.FileDialog({
        title: "Select wallpaper directory",
        modal: false,
      })
      dialog.set_initial_folder(
        Gio.File.new_for_path(wallpaperConfig().directory),
      )
      dialog.select_folder(null, null, (src, res) => {
        try {
          const file = (src as Gtk.FileDialog).select_folder_finish(res)
          const newDir = file?.get_path()
          if (newDir) {
            setDirectory(newDir)
          }
        } catch {
          // キャンセル
        }
        // 選択完了/キャンセル後にメニューを開き直す
        setOpen(true)
      })

      return GLib.SOURCE_REMOVE
    })
  }

  function applyWallpaper(path: string) {
    if (applyMode() === "all" || !connector) {
      applyToAllMonitors(path)
    } else {
      applyToMonitor(connector, path)
    }
  }

  const currentPath = createComputed(() =>
    effectiveWallpaper(wallpaperConfig(), connector),
  )
  const hasOverride = createComputed(() =>
    connector ? !!wallpaperConfig().overrides[connector] : false,
  )

  const { TOP, LEFT, RIGHT, BOTTOM } = Astal.WindowAnchor

  const inner = (
    <box
      cssName="WallpaperMenu"
      class={isOpen((open) => (open ? "open" : "close"))}
      orientation={Gtk.Orientation.VERTICAL}
      halign={Gtk.Align.END}
      valign={Gtk.Align.START}
    >
      <box cssName="FirstPadding" />

      {/* 上の島: ディレクトリ表示 + 変更ボタン */}
      <box
        cssName="WallpaperDirIsland"
        orientation={Gtk.Orientation.HORIZONTAL}
        halign={Gtk.Align.FILL}
        hexpand
      >
        <box
          cssName="WallpaperDirInfo"
          orientation={Gtk.Orientation.VERTICAL}
          hexpand
          valign={Gtk.Align.CENTER}
        >
          <label
            cssName="WallpaperDirCaption"
            halign={Gtk.Align.START}
            label="Directory"
          />
          <label
            cssName="WallpaperDirPath"
            halign={Gtk.Align.START}
            ellipsize={3 /* PANGO_ELLIPSIZE_END */}
            maxWidthChars={36}
            label={wallpaperConfig((c) =>
              c.directory.replace(GLib.get_home_dir(), "~"),
            )}
          />
        </box>
        <button
          cssName="WallpaperDirButton"
          valign={Gtk.Align.CENTER}
          onClicked={() => chooseDirectory()}
        >
          <label label="Change..." />
        </button>
      </box>

      {/* 中央の島: サムネ一覧 */}
      <scrolledwindow
        cssName="WallpaperGridScroll"
        hscrollbarPolicy={Gtk.PolicyType.NEVER}
        vscrollbarPolicy={Gtk.PolicyType.AUTOMATIC}
        hexpand
        vexpand
      >
        <Gtk.FlowBox
          cssName="WallpaperGrid"
          minChildrenPerLine={3}
          maxChildrenPerLine={3}
          selectionMode={Gtk.SelectionMode.NONE}
          rowSpacing={8}
          columnSpacing={8}
          homogeneous
          $={(self) => {
            // FlowBox は children を直接 JSX で生やせないので生で詰める。
            // rebuild は state.subscribe のコールバックから呼ばれるため、tracking context
            // の外側になり、子の <button>/<Gtk.Picture> 生成内で onCleanup が登録できず警告が出る。
            // createRoot でスコープを作り、rebuild ごとに前回のスコープを dispose して再生成する。
            let disposeItems: (() => void) | null = null

            const rebuild = () => {
              if (disposeItems) {
                disposeItems()
                disposeItems = null
              }
              let child = self.get_first_child()
              while (child) {
                const next = child.get_next_sibling()
                self.remove(child)
                child = next
              }
              createRoot((dispose) => {
                disposeItems = dispose
                const cur = currentPath()
                for (const entry of entries()) {
                  const item = buildThumbnailItem(entry, cur, () =>
                    applyWallpaper(entry.path),
                  )
                  self.append(item)
                }
              })
            }
            rebuild()
            entries.subscribe(rebuild)
            currentPath.subscribe(rebuild)
          }}
        />
      </scrolledwindow>

      {/* 下の島: 適用範囲の切替 + override 解除 */}
      <box
        cssName="WallpaperControlIsland"
        orientation={Gtk.Orientation.HORIZONTAL}
        halign={Gtk.Align.FILL}
        hexpand
      >
        <box cssName="WallpaperModeToggle" valign={Gtk.Align.CENTER}>
          <button
            cssName="WallpaperModeButton"
            class={applyMode((m) => (m === "all" ? "active" : ""))}
            onClicked={() => setApplyMode("all")}
          >
            <label label="All monitors" />
          </button>
          <button
            cssName="WallpaperModeButton"
            class={applyMode((m) => (m === "this" ? "active" : ""))}
            onClicked={() => setApplyMode("this")}
          >
            <label label={`This monitor (${connector ?? "?"})`} />
          </button>
        </box>
        <box hexpand />
        <button
          cssName="WallpaperIdentifyButton"
          valign={Gtk.Align.CENTER}
          onClicked={() => identifyMonitors()}
        >
          <label label="Identify monitors" />
        </button>
        <button
          cssName="WallpaperClearButton"
          valign={Gtk.Align.CENTER}
          sensitive={hasOverride}
          onClicked={() => {
            if (connector) clearMonitorOverride(connector)
          }}
        >
          <label label="Clear override" />
        </button>
      </box>
    </box>
  ) as Gtk.Box

  const window = (
    <window
      name="wallpapermenulayer"
      class="WallpaperMenuLayer"
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
    if (keyval === Gdk.KEY_Escape) {
      states.setOpen(false)
      return true
    }
    return false
  })
  window.add_controller(keyController)

  return window
}

// FlowBox の 1 セル
function buildThumbnailItem(
  entry: ThumbnailEntry,
  currentPath: string | null,
  onClick: () => void,
): Gtk.Widget {
  const imageWidget = entry.paintable ? (
    <Gtk.Picture
      cssName="WallpaperThumbnailImage"
      contentFit={Gtk.ContentFit.COVER}
      canShrink
      paintable={Gdk.Texture.new_for_pixbuf(entry.paintable)}
      widthRequest={THUMBNAIL_WIDTH}
      heightRequest={THUMBNAIL_HEIGHT}
    />
  ) : (
    <box
      cssName="WallpaperThumbnailImage"
      widthRequest={THUMBNAIL_WIDTH}
      heightRequest={THUMBNAIL_HEIGHT}
    />
  )

  const button = (
    <button
      cssName="WallpaperThumbnail"
      class={currentPath === entry.path ? "selected" : ""}
      tooltipText={entry.path}
      onClicked={onClick}
    >
      {imageWidget}
    </button>
  ) as Gtk.Widget
  return button
}
