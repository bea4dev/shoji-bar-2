<div align="center">
<h2>Shoji Bar 2</h2>

The default desktop shell for [ShojiWM](https://bea4dev.github.io/ShojiWM/).

![Screenshot](./screenshot/screenshot0.png)

</div>

Shoji Bar 2 is an [AGS](https://aylur.github.io/ags/) (Astal + GTK4) desktop
shell written in TypeScript/JSX. It is built for **ShojiWM** and integrates with
it over a Unix-socket IPC, but most widgets work on any wlroots-style Wayland
compositor that supports the layer-shell protocol.

## Features

- **Top bar** — start menu, workspaces, tiling/floating layout indicator,
  clock + calendar, system tray, CPU / memory indicators, battery, wallpaper
  picker, and a status area (Wi-Fi, Bluetooth, audio, brightness, power
  profiles, notifications, media controls).
- **Dock** — auto-hiding, pinned + running apps, per-app window list.
- **Start menu** — searchable application launcher with user info / power menu.
- **Clipboard history** — text and image entries with thumbnails (`Super+V`).
- **Wallpaper picker** — thumbnail grid + a monitor-identify overlay.
- **Snap-zone preview** — Windows-style edge-snapping overlay driven by ShojiWM.
- **Notifications** — popups + a notification center in the status menu.

## Dependencies

> [!IMPORTANT]
> **The Astal libraries are NOT dependencies of AGS — you must install them
> separately.** Installing the `ags` CLI only brings in GTK 4, `gtk4-layer-shell`
> and the Astal core (`astal-io` / `astal4`); each `gi://Astal*` module used by a
> widget (`AstalApps`, `AstalBattery`, …) is its own package that ships its own
> GObject-introspection typelib. If they are missing you get a runtime error like
> `Requiring AstalApps … Typelib file for namespace 'AstalApps' … not found`.
>
> On Arch/AUR the easiest fix is the meta package that pulls all of them:
> ```sh
> paru -S libastal-meta        # or: yay -S libastal-meta
> ```
> or install just the ones this shell uses (see the table below).
>
> Note: `ags types` succeeding is **not** proof the libraries are installed — it
> only generates TypeScript stubs for the typelibs that are *already present* and
> installs nothing. And `ags run` strips the types, so a missing library only
> surfaces at runtime.

### Core

- [AGS](https://aylur.github.io/ags/) ≥ 3 (the `ags` CLI; provides the `gnim`
  runtime, the GTK4 bindings, and usually GTK 4 + `gtk4-layer-shell` + the Astal
  core as dependencies)
- GTK 4
- `gtk4-layer-shell`

### Astal libraries

These back individual widgets (imported as `gi://Astal*`). Each is a separate
package — install them alongside AGS (Arch/AUR package names shown). All are used
by the default layout:

| Library              | Arch/AUR package          | Used for                   | Backing service          |
| -------------------- | ------------------------- | -------------------------- | ------------------------ |
| `AstalApps`          | `libastal-apps`           | application launcher / dock | `.desktop` files         |
| `AstalBattery`       | `libastal-battery`        | battery indicator          | UPower                   |
| `AstalNetwork`       | `libastal-network`        | Wi-Fi status               | NetworkManager           |
| `AstalNotifd`        | `libastal-notifd`         | notifications              | (built-in daemon)        |
| `AstalMpris`         | `libastal-mpris`          | media controls             | any MPRIS player         |
| `AstalWp`            | `libastal-wireplumber`    | volume control             | WirePlumber / PipeWire   |
| `AstalPowerProfiles` | `libastal-powerprofiles`  | power-profile toggle       | power-profiles-daemon    |
| `AstalTray`          | `libastal-tray`           | system tray                | StatusNotifierItem hosts |

### Command-line tools

| Tool                              | Used for                         |
| --------------------------------- | -------------------------------- |
| `nmcli` (NetworkManager)          | Wi-Fi scan / connect / toggle    |
| `bluetoothctl` (BlueZ)            | Bluetooth devices                |
| `rfkill` (util-linux)             | Bluetooth radio toggle           |
| `brightnessctl`                   | screen brightness                |
| `cliphist`                        | clipboard history store / decode |
| `wl-clipboard` (`wl-copy` / `wl-paste`) | clipboard read / write     |
| `imagemagick` (`magick`)          | clipboard image thumbnails       |
| `bash`                            | pipelines for the above          |

> The clipboard chain is: `cliphist list` to enumerate, `cliphist decode <id> |
> wl-copy` to restore, and `cliphist decode <id> | magick - -thumbnail 480x300`
> to build image thumbnails (cached under `$TMPDIR/shoji-bar-2-clip`).

## Installation

The shell is loaded directly from `~/.config/shoji-bar-2`.

```sh
# 1. Install AGS and the Astal libraries (see Dependencies above).
#    IMPORTANT: the Astal libraries are NOT pulled in by AGS. On Arch/AUR:
paru -S aylurs-gtk-shell libastal-meta   # ags + all Astal libs
#    ...and the command-line tools your widgets need (cliphist, wl-clipboard,
#    imagemagick, brightnessctl, ...).

# 2. Clone into the config directory
git clone https://github.com/bea4dev/shoji-bar-2 ~/.config/shoji-bar-2
cd ~/.config/shoji-bar-2

# 3. Generate the GObject-introspection type stubs (@girs).
#    Run this AFTER the Astal libraries are installed — it only introspects the
#    typelibs already present, and installs nothing. Re-run it whenever you
#    add/upgrade a library.
ags types -u -d ./

# 4. (optional) JS tooling for editing / formatting (gnim types, prettier)
npm install
```

Then run it:

```sh
# Standalone
ags run app.tsx

# Or let ShojiWM autostart it (already wired in the ShojiWM config):
#   GTK_A11Y=none ags run app.tsx
```

> `GTK_A11Y=none` disables the AT-SPI accessibility bridge. A status bar never
> needs a screen reader, and it avoids a GTK 4.22 accessibility notify-storm
> that can peg a CPU core when a tray menu is torn down while open.

### Clipboard history setup

`cliphist` only contains entries while clipboard watchers are running. Start
one watcher per MIME class (text + image):

```sh
wl-paste --type text  --watch cliphist store &
wl-paste --type image --watch cliphist store &
```

The ShojiWM config starts these automatically as restartable services, so under
ShojiWM no extra setup is required.

### User-provided assets

| Path                     | Purpose                                            |
| ------------------------ | -------------------------------------------------- |
| `~/Pictures/icon.png`    | avatar shown in the start menu user card           |
| `~/Pictures/wallpapers/` | source folder scanned by the wallpaper picker      |

Runtime state is written next to the config and is git-ignored:
`wallpapers.json` (per-monitor wallpaper) and `dock.json` (pinned apps).

## ShojiWM integration

The bar talks to ShojiWM over the Unix socket
`$XDG_RUNTIME_DIR/shojiwm-$WAYLAND_DISPLAY.sock` (newline-delimited JSON). It
consumes broadcasts (workspace layout, dock proximity, snap-zone previews) and
sends commands (switch/activate workspace, activate window).

It also exposes a few `ags request` commands that ShojiWM binds to keys:

```sh
ags request -i ags start-menu toggle <connector>   # Super+A
ags request -i ags clipboard  toggle <connector>   # Super+V
```

## Development

```sh
npx tsc --noEmit -p tsconfig.json   # type-check
ags bundle app.tsx /tmp/out.js      # bundle check (compiles TS + SCSS)
npm run format                      # prettier
```

A diagnostic script for when the shell pegs a CPU core lives at
[`scripts/diag-bar-perf.sh`](./scripts/diag-bar-perf.sh) (perf + stack/log
capture; see the header for usage).
