/**
 * Operating system detection.
 *
 * `core` is host-agnostic: it never imports `node:os` or touches `process`.
 * The host injects a `PlatformInfo` so the same code runs in the Tauri webview,
 * in Node (`atomic serve`), or in a browser host.
 */

export const OS_PLATFORMS = ["windows", "macos", "linux", "ios", "android", "unknown"] as const;
export type OsPlatform = (typeof OS_PLATFORMS)[number];

export const ARCHITECTURES = ["x64", "arm64", "x86", "arm", "unknown"] as const;
export type Architecture = (typeof ARCHITECTURES)[number];

export interface PlatformInfo {
  /** Coarse platform family, normalised. */
  readonly os: OsPlatform;
  /** Raw platform string exactly as the host reported it. */
  readonly rawOs: string;
  readonly arch: Architecture;
  /** e.g. `Windows 11`, `macOS 15.3.1`, `Arch Linux`. */
  readonly description: string;
  /** Path separator for this platform: `\` on Windows, `/` elsewhere. */
  readonly sep: "/" | "\\";
  /** Whether paths are case-sensitive (false on Windows and macOS default volumes). */
  readonly caseSensitivePaths: boolean;
  /** Whether line endings default to CRLF. */
  readonly crlfByDefault: boolean;
}

export function normalizeOs(raw: string | null | undefined): OsPlatform {
  const v = (raw ?? "").toLowerCase();
  if (v.startsWith("win")) return "windows";
  if (v === "darwin" || v === "macos" || v === "mac" || v === "osx") return "macos";
  if (v === "ios") return "ios";
  if (v === "android") return "android";
  if (v === "linux" || v === "freebsd" || v === "openbsd" || v === "netbsd") return "linux";
  return "unknown";
}

export function normalizeArch(raw: string | null | undefined): Architecture {
  const v = (raw ?? "").toLowerCase();
  if (v === "x86_64" || v === "amd64" || v === "x64") return "x64";
  if (v === "aarch64" || v === "arm64") return "arm64";
  if (v === "i386" || v === "i686" || v === "x86" || v === "ia32") return "x86";
  if (v.startsWith("arm")) return "arm";
  return "unknown";
}

/** Build a `PlatformInfo` from raw host strings. Used by every host adapter. */
export function describePlatform(
  rawOs: string | null | undefined,
  rawArch?: string | null,
  description?: string,
): PlatformInfo {
  const os = normalizeOs(rawOs);
  const windows = os === "windows";
  return {
    os,
    rawOs: rawOs ?? "unknown",
    arch: normalizeArch(rawArch),
    description: description ?? (rawOs ?? "unknown"),
    sep: windows ? "\\" : "/",
    caseSensitivePaths: !windows && os !== "macos",
    crlfByDefault: windows,
  };
}

export const isWindows = (p: PlatformInfo): boolean => p.os === "windows";
export const isMac = (p: PlatformInfo): boolean => p.os === "macos";
export const isLinux = (p: PlatformInfo): boolean => p.os === "linux";
