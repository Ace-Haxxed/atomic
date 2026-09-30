import { describe, expect, it } from "vitest";
import { describePlatform, type PlatformInfo } from "./platform.js";
import {
  basename,
  dirname,
  isAbsolutePath,
  isPathInside,
  joinPath,
  normalizePath,
  relativePath,
} from "./paths.js";
import {
  APP_DIR_NAME,
  databasePath,
  deriveAppDirs,
  resolveAppDirs,
  type AppDirs,
  type HostEnvironment,
} from "./dirs.js";
import { buildShellCommand, describeShell, fallbackShell } from "./shell.js";

const windows: PlatformInfo = describePlatform("windows", "x86_64", "Windows 11");
const macos: PlatformInfo = describePlatform("darwin", "arm64", "macOS 15.3");
const linux: PlatformInfo = describePlatform("linux", "x86_64", "Arch Linux");

/** The platform that goes with each `cases` entry below. */
const PLATFORM_FOR: Record<string, PlatformInfo> = {
  Windows: windows,
  macOS: macos,
  Linux: linux,
};

describe("describePlatform", () => {
  it("normalises platform and architecture aliases", () => {
    expect(describePlatform("win32", "AMD64").os).toBe("windows");
    expect(describePlatform("win32", "AMD64").arch).toBe("x64");
    expect(describePlatform("darwin", "aarch64").os).toBe("macos");
    expect(describePlatform("darwin", "aarch64").arch).toBe("arm64");
    expect(describePlatform("sunos", "sparc").os).toBe("unknown");
  });

  it("survives a host that reports nothing", () => {
    // A host that cannot answer must not crash the app on startup.
    const info = describePlatform("linux");
    expect(info.os).toBe("linux");
    expect(info.arch).toBe("unknown");
    expect(info.rawOs).toBe("linux");
    expect(describePlatform(null, null).os).toBe("unknown");
    expect(describePlatform(undefined).sep).toBe("/");
  });

  it("reports the right separator, case sensitivity and line endings", () => {
    expect(windows.sep).toBe("\\");
    expect(linux.sep).toBe("/");
    expect(windows.caseSensitivePaths).toBe(false);
    expect(linux.caseSensitivePaths).toBe(true);
    expect(windows.crlfByDefault).toBe(true);
    expect(linux.crlfByDefault).toBe(false);
  });
});

describe("joinPath", () => {
  it("uses the platform separator", () => {
    expect(joinPath(windows, "C:", "Users", "me", "project")).toBe("C:\\Users\\me\\project");
    expect(joinPath(linux, "/home/me", "project")).toBe("/home/me/project");
  });

  it("accepts either separator as input", () => {
    expect(joinPath(windows, "C:/Users/me")).toBe("C:\\Users\\me");
    expect(joinPath(linux, "a/b/c")).toBe("a/b/c");
  });

  it("keeps a Windows drive as the root", () => {
    expect(joinPath(windows, "C:")).toBe("C:\\");
    expect(joinPath(windows, "C:", "Users")).toBe("C:\\Users");
  });

  it("collapses redundant separators and dot segments", () => {
    expect(joinPath(linux, "/a/", "/b/", "./c")).toBe("/a/b/c");
  });

  it("leaves .. to normalizePath, which is the only resolver", () => {
    expect(joinPath(linux, "a", "..", "b")).toBe("a/../b");
    expect(normalizePath("/a/b/../c", linux)).toBe("/a/c");
    expect(normalizePath("C:\\a\\b\\..\\c", windows)).toBe("c:\\a\\c");
  });
});

describe("basename / dirname / extname", () => {
  it("handles both separators", () => {
    expect(basename("C:\\Users\\me\\file.txt", windows)).toBe("file.txt");
    expect(basename("/home/me/file.txt", linux)).toBe("file.txt");
    expect(basename("/home/me/", linux)).toBe("me");
  });

  it("resolves parent directories", () => {
    expect(dirname("C:\\Users\\me\\file.txt", windows)).toBe("C:\\Users\\me");
    expect(dirname("/home/me/file.txt", linux)).toBe("/home/me");
  });
});

describe("isPathInside", () => {
  it("is case-insensitive on Windows and sensitive on Linux", () => {
    expect(isPathInside("C:\\Users\\Me\\Proj\\src", "c:\\users\\me\\proj", windows)).toBe(true);
    expect(isPathInside("/home/me/proj/src", "/home/me/PROJ", linux)).toBe(false);
  });

  it("does not treat a sibling with a shared prefix as inside", () => {
    expect(isPathInside("/home/me/project-evil", "/home/me/project", linux)).toBe(false);
    expect(isPathInside("/home/me/project", "/home/me/project", linux)).toBe(true);
  });

  it("resolves .. before comparing", () => {
    expect(isPathInside("/home/me/proj/src/../lib", "/home/me/proj", linux)).toBe(true);
  });
});

describe("relativePath", () => {
  it("produces one .. per level climbed", () => {
    expect(relativePath("/a/b/c", "/a/d", linux)).toBe("../../d");
    expect(relativePath("/a/b", "/a/b/c", linux)).toBe("c");
    expect(relativePath("/a/b", "/a/b", linux)).toBe(".");
  });
});

describe("isAbsolutePath", () => {
  it("understands drive letters, UNC and POSIX roots", () => {
    expect(isAbsolutePath("C:\\x", windows)).toBe(true);
    expect(isAbsolutePath("\\\\server\\share", windows)).toBe(true);
    expect(isAbsolutePath("x\\y", windows)).toBe(false);
    expect(isAbsolutePath("/x", linux)).toBe(true);
    expect(isAbsolutePath("x/y", linux)).toBe(false);
  });
});

const posixEnv: HostEnvironment = {
  home: "/home/me",
  appData: null,
  localAppData: null,
  tempDir: "/tmp",
  xdgDataHome: null,
  xdgConfigHome: null,
  xdgCacheHome: null,
  xdgStateHome: null,
  libraryDir: null,
};

const windowsEnv: HostEnvironment = {
  home: "C:\\Users\\me",
  appData: "C:\\Users\\me\\AppData\\Roaming",
  localAppData: "C:\\Users\\me\\AppData\\Local",
  tempDir: "C:\\Users\\me\\AppData\\Local\\Temp",
  xdgDataHome: null,
  xdgConfigHome: null,
  xdgCacheHome: null,
  xdgStateHome: null,
  libraryDir: null,
};

const macEnv: HostEnvironment = {
  ...posixEnv,
  home: "/Users/me",
  libraryDir: "/Users/me/Library",
};

describe("resolveAppDirs", () => {
  it("uses AppData on Windows", () => {
    const dirs = resolveAppDirs(windows, windowsEnv);
    expect(dirs.data).toBe("C:\\Users\\me\\AppData\\Roaming\\dev.atomic.app");
    expect(dirs.cache).toBe("C:\\Users\\me\\AppData\\Local\\dev.atomic.app\\Cache");
  });

  it("uses XDG on Linux", () => {
    const dirs = resolveAppDirs(linux, posixEnv);
    expect(dirs.data).toBe("/home/me/.local/share/dev.atomic.app");
    expect(dirs.config).toBe("/home/me/.config/dev.atomic.app");
    expect(dirs.cache).toBe("/home/me/.cache/dev.atomic.app");
  });

  it("honours XDG overrides", () => {
    const dirs = resolveAppDirs(linux, { ...posixEnv, xdgDataHome: "/mnt/data" });
    expect(dirs.data).toBe("/mnt/data/dev.atomic.app");
  });

  it("uses Application Support on macOS", () => {
    const dirs = resolveAppDirs(macos, macEnv);
    expect(dirs.data).toBe("/Users/me/Library/Application Support/dev.atomic.app");
    expect(dirs.cache).toBe("/Users/me/Library/Caches/dev.atomic.app");
  });
});

/**
 * The regression that made the app fail to start: the data directory contained
 * `dev.atomic.app` twice, so SQLite's parent directory did not exist and it
 * returned `SQLITE_CANTOPEN` (code 14) instead of creating anything.
 */
describe("app directory appears exactly once", () => {
  const cases: readonly [string, AppDirs][] = [
    [
      "Windows",
      resolveAppDirs(windows, windowsEnv),
    ],
    [
      "macOS",
      resolveAppDirs(macos, macEnv),
    ],
    [
      "Linux",
      resolveAppDirs(linux, posixEnv),
    ],
  ];

  for (const [label, dirs] of cases) {
    it(`resolves one app directory on ${label}`, () => {
      for (const [name, path] of Object.entries(dirs)) {
        expect(countSegments(path, APP_DIR_NAME), `${label} ${name}: ${path}`).toBe(1);
      }
    });

    it(`resolves one app directory in the database path on ${label}`, () => {
      expect(countSegments(databasePath(dirs, PLATFORM_FOR[label]), APP_DIR_NAME)).toBe(1);
    });
  }

  it("keeps every dir absolute", () => {
    for (const [label, dirs] of cases) {
      expect(isAbsolute(dirs.dataDir), `${label}: ${dirs.dataDir}`).toBe(true);
      expect(isAbsolute(dirs.logs), `${label}: ${dirs.logs}`).toBe(true);
    }
  });

  it("puts the database directly in the data directory", () => {
    const dirs = resolveAppDirs(linux, posixEnv);
    expect(databasePath(dirs, linux)).toBe("/home/me/.local/share/dev.atomic.app/atomic.db");
  });
});

describe("deriveAppDirs", () => {
  it("uses OS-resolved directories verbatim", () => {
    // What Tauri's `app_data_dir()` and friends actually return.
    const dirs = deriveAppDirs(linux, {
      dataDir: "/home/me/.local/share/dev.atomic.app",
      config: "/home/me/.config/dev.atomic.app",
      cache: "/home/me/.cache/dev.atomic.app",
      logs: "/home/me/.local/state/dev.atomic.app/logs",
    });
    expect(dirs.dataDir).toBe("/home/me/.local/share/dev.atomic.app");
    expect(dirs.backups).toBe("/home/me/.local/share/dev.atomic.app/checkpoints");
    expect(dirs.attachments).toBe("/home/me/.local/share/dev.atomic.app/attachments");
    expect(countSegments(databasePath(dirs, linux), APP_DIR_NAME)).toBe(1);
  });

  it("rejects a doubled app directory instead of repeating it", () => {
    const doubled = {
      dataDir: "/home/me/.local/share/dev.atomic.app/dev.atomic.app",
      config: "/home/me/.config/dev.atomic.app",
      cache: "/home/me/.cache/dev.atomic.app",
      logs: "/home/me/.local/state/dev.atomic.app/logs",
    };
    expect(() => deriveAppDirs(linux, doubled)).toThrow(/repeats "dev.atomic.app"/);
  });

  it.each(["config", "cache", "logs"] as const)("rejects a doubled %s directory", (field) => {
    const doubled = {
      dataDir: "/home/me/.local/share/dev.atomic.app",
      config: "/home/me/.config/dev.atomic.app",
      cache: "/home/me/.cache/dev.atomic.app",
      logs: "/home/me/.local/state/dev.atomic.app/logs",
      [field]: "/home/me/other/dev.atomic.app/dev.atomic.app",
    };
    expect(() => deriveAppDirs(linux, doubled)).toThrow(/repeats "dev.atomic.app"/);
  });

  it("accepts a path that merely contains the name as part of a segment", () => {
    const dirs = deriveAppDirs(linux, {
      dataDir: "/home/me/.local/share/dev.atomic.app.backup",
      config: "/home/me/.config/dev.atomic.app",
      cache: "/home/me/.cache/dev.atomic.app",
      logs: "/home/me/.local/state/dev.atomic.app/logs",
    });
    expect(dirs.dataDir).toBe("/home/me/.local/share/dev.atomic.app.backup");
  });
});

function countSegments(path: string, segment: string): number {
  return path.split(/[\\/]/).filter((part) => part === segment).length;
}

function isAbsolute(path: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(path);
}

describe("shell", () => {
  it("prefers pwsh on Windows and bash on Linux", () => {
    expect(fallbackShell(windows).kind).toBe("powershell");
    expect(fallbackShell(linux).kind).toBe("bash");
    expect(fallbackShell(macos).kind).toBe("zsh");
  });

  it("builds a PowerShell invocation with -Command", () => {
    const invocation = buildShellCommand(fallbackShell(windows), "Get-ChildItem");
    expect(invocation.executable).toBe("pwsh");
    expect(invocation.args).toContain("-Command");
    expect(invocation.args.at(-1)).toBe("Get-ChildItem");
  });

  it("builds a bash invocation with -lc", () => {
    const invocation = buildShellCommand(fallbackShell(linux), "ls -la");
    expect(invocation.args).toEqual(["-lc", "ls -la"]);
  });

  it("tells the model which OS and shell it is on", () => {
    const win = describeShell(windows, fallbackShell(windows));
    expect(win).toContain("Windows");
    expect(win).toContain("PowerShell");
    expect(win).not.toContain("Homebrew");

    const mac = describeShell(macos, fallbackShell(macos));
    expect(mac).toContain("macOS");
    expect(mac).toContain("Homebrew");
  });
});
