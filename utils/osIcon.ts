import GLib from "gi://GLib"

// Map /etc/os-release IDs to asset base names in assets/
const DISTRO_ICONS: Record<string, string> = {
  arch: "arch-linux",
  nixos: "nixos",
  ubuntu: "ubuntu",
  debian: "debian",
  fedora: "fedora",
}

function detectIconBase(): string {
  const id = GLib.get_os_info("ID")
  if (id && DISTRO_ICONS[id]) {
    return DISTRO_ICONS[id]
  }
  // Derivatives (e.g. EndeavourOS -> "arch", Mint -> "ubuntu debian")
  const idLike = GLib.get_os_info("ID_LIKE")
  for (const token of idLike?.split(/\s+/) ?? []) {
    if (DISTRO_ICONS[token]) {
      return DISTRO_ICONS[token]
    }
  }
  return "linux"
}

const base = detectIconBase()

export const OS_ICON_BLACK = `${SRC}/assets/${base}-black.svg`
export const OS_ICON_WHITE = `${SRC}/assets/${base}-white.svg`
