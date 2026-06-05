import Gio from "gi://Gio"
import GLib from "gi://GLib"
import { createState } from "gnim"

// 壁紙設定の永続化 + リアクティブ共有状態。
//
// global: 全モニタ共通の壁紙パス
// overrides: connector(モニタ名) ごとの上書き
// directory: サムネ一覧に表示する画像ディレクトリ
//
// 設定ファイルは ~/.config/shoji-bar-2/wallpapers.json。

export type WallpaperConfig = {
  directory: string
  global: string | null
  overrides: Record<string, string>
}

function defaultDirectory(): string {
  return `${GLib.get_home_dir()}/Pictures/wallpapers`
}

function configPath(): string {
  return `${GLib.get_user_config_dir()}/shoji-bar-2/wallpapers.json`
}

function loadConfig(): WallpaperConfig {
  const fallback: WallpaperConfig = {
    directory: defaultDirectory(),
    global: null,
    overrides: {},
  }

  try {
    const file = Gio.File.new_for_path(configPath())
    if (!file.query_exists(null)) {
      return fallback
    }
    const [, contents] = file.load_contents(null)
    const text = new TextDecoder().decode(contents)
    const parsed = JSON.parse(text) as Partial<WallpaperConfig>
    return {
      directory:
        typeof parsed.directory === "string"
          ? parsed.directory
          : fallback.directory,
      global: typeof parsed.global === "string" ? parsed.global : null,
      overrides:
        parsed.overrides && typeof parsed.overrides === "object"
          ? Object.fromEntries(
              Object.entries(parsed.overrides).filter(
                ([, v]) => typeof v === "string",
              ),
            )
          : {},
    }
  } catch (err) {
    console.error("[wallpaper] failed to load config:", err)
    return fallback
  }
}

function saveConfig(config: WallpaperConfig) {
  try {
    const dir = Gio.File.new_for_path(
      `${GLib.get_user_config_dir()}/shoji-bar-2`,
    )
    if (!dir.query_exists(null)) {
      dir.make_directory_with_parents(null)
    }
    const file = Gio.File.new_for_path(configPath())
    const text = JSON.stringify(config, null, 2) + "\n"
    file.replace_contents(
      new TextEncoder().encode(text),
      null,
      false,
      Gio.FileCreateFlags.NONE,
      null,
    )
  } catch (err) {
    console.error("[wallpaper] failed to save config:", err)
  }
}

const [wallpaperConfig, setWallpaperConfigRaw] = createState(loadConfig())
export { wallpaperConfig }

export function setWallpaperConfig(config: WallpaperConfig) {
  setWallpaperConfigRaw(config)
  saveConfig(config)
}

// connector の有効壁紙(override 優先、無ければ global)
export function effectiveWallpaper(
  config: WallpaperConfig,
  connector: string | null,
): string | null {
  if (connector && config.overrides[connector]) {
    return config.overrides[connector]
  }
  return config.global
}

// 設定ヘルパ群 ----------------------------------------------------------------

export function setDirectory(directory: string) {
  setWallpaperConfig({ ...wallpaperConfig(), directory })
}

export function applyToAllMonitors(path: string) {
  // 全モニタ共通(global)に設定。override は全て解除して上書きの揺れを無くす
  setWallpaperConfig({
    ...wallpaperConfig(),
    global: path,
    overrides: {},
  })
}

export function applyToMonitor(connector: string, path: string) {
  const current = wallpaperConfig()
  setWallpaperConfig({
    ...current,
    overrides: { ...current.overrides, [connector]: path },
  })
}

export function clearMonitorOverride(connector: string) {
  const current = wallpaperConfig()
  const next = { ...current.overrides }
  delete next[connector]
  setWallpaperConfig({ ...current, overrides: next })
}

// 画像列挙 --------------------------------------------------------------------

const IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
])

const IMAGE_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
])

function hasImageExt(name: string): boolean {
  const lower = name.toLowerCase()
  for (const ext of IMAGE_EXT) {
    if (lower.endsWith(ext)) return true
  }
  return false
}

// directory 直下の画像をファイル名昇順で返す(非同期)。
export function listWallpapers(directory: string): Promise<string[]> {
  return new Promise((resolve) => {
    const dir = Gio.File.new_for_path(directory)
    if (!dir.query_exists(null)) {
      resolve([])
      return
    }

    dir.enumerate_children_async(
      "standard::name,standard::content-type,standard::type",
      Gio.FileQueryInfoFlags.NONE,
      GLib.PRIORITY_DEFAULT,
      null,
      (_src, res) => {
        let enumerator: Gio.FileEnumerator
        try {
          enumerator = dir.enumerate_children_finish(res)
        } catch (err) {
          console.error("[wallpaper] enumerate failed:", err)
          resolve([])
          return
        }

        const out: string[] = []

        function pump() {
          enumerator.next_files_async(
            32,
            GLib.PRIORITY_DEFAULT,
            null,
            (_e, res2) => {
              let infos: Gio.FileInfo[]
              try {
                infos = enumerator.next_files_finish(res2)
              } catch (err) {
                console.error("[wallpaper] next_files failed:", err)
                resolve(out.sort())
                return
              }
              if (infos.length === 0) {
                resolve(out.sort())
                return
              }
              for (const info of infos) {
                if (info.get_file_type() !== Gio.FileType.REGULAR) {
                  continue
                }
                const name = info.get_name()
                const mime = info.get_content_type()
                if ((mime && IMAGE_MIME.has(mime)) || hasImageExt(name)) {
                  out.push(`${directory}/${name}`)
                }
              }
              pump()
            },
          )
        }

        pump()
      },
    )
  })
}
