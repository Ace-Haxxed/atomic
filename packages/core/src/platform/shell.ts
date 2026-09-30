/**
 * Shell abstraction.
 *
 * The shell tool never assumes bash. It resolves a concrete shell for the host
 * and reports OS + shell to the model in the system prompt so the model writes
 * commands for the right interpreter.
 */

import type { PlatformInfo } from "./platform.js";
import { shellQuote } from "./paths.js";

export const SHELLS = ["powershell", "cmd", "bash", "zsh", "fish", "sh"] as const;
export type ShellKind = (typeof SHELLS)[number];

export interface ShellProfile {
  readonly kind: ShellKind;
  /** Executable name as it must be invoked (e.g. `pwsh`, `bash`, `zsh`). */
  readonly executable: string;
  /** Stable identifier for the platform package installer, e.g. `npm.brew`. */
  readonly displayName: string;
  /** Argument that makes the shell read a script from stdin. */
  readonly readStdinArg: string | null;
  /** True when the shell interprets `$VAR`, `&&`, globs, pipes natively. */
  readonly posixSyntax: boolean;
}

/** Ordered preference list; the host picks the first one that actually exists. */
export function shellCandidates(platform: PlatformInfo): ShellProfile[] {
  if (platform.os === "windows") {
    return [
      { kind: "powershell", executable: "pwsh", displayName: "PowerShell 7", readStdinArg: "-NoProfile", posixSyntax: false },
      { kind: "powershell", executable: "powershell.exe", displayName: "Windows PowerShell 5.1", readStdinArg: "-NoProfile", posixSyntax: false },
      { kind: "cmd", executable: "cmd.exe", displayName: "Command Prompt", readStdinArg: null, posixSyntax: false },
    ];
  }
  if (platform.os === "macos") {
    return [
      { kind: "zsh", executable: "zsh", displayName: "zsh", readStdinArg: null, posixSyntax: true },
      { kind: "bash", executable: "bash", displayName: "bash", readStdinArg: null, posixSyntax: true },
      { kind: "sh", executable: "sh", displayName: "sh", readStdinArg: null, posixSyntax: true },
    ];
  }
  return [
    { kind: "bash", executable: "bash", displayName: "bash", readStdinArg: null, posixSyntax: true },
    { kind: "sh", executable: "sh", displayName: "sh", readStdinArg: null, posixSyntax: true },
  ];
}

export function fallbackShell(platform: PlatformInfo): ShellProfile {
  const candidates = shellCandidates(platform);
  const first = candidates[0];
  if (!first) throw new Error("no shell candidates for platform");
  return first;
}

/** Human/OS-readable line injected into the system prompt so the model knows the target. */
export function describeShell(platform: PlatformInfo, shell: ShellProfile): string {
  if (platform.os === "windows") {
    return `You are running on ${platform.description} (${platform.arch}) using ${shell.displayName}. Windows paths use backslashes; drive letters look like C:\\Users\\name. Do not use POSIX-only syntax like \`export\`, \`grep -P\`, or \`curl -o\` with a single dash for long flags — prefer their PowerShell equivalents (\`\$env:VAR\`, \`Select-String\`, \`Invoke-WebRequest\`).`;
  }
  const packageHint =
    platform.os === "macos" ? "Homebrew (`brew`)" : "your system package manager (`apt`, `dnf`, `pacman`, `apk`)";
  return `You are running on ${platform.description} (${platform.arch}) using ${shell.displayName}. This is a POSIX-like system: paths use forward slashes, commands are case-sensitive, and \`curl\`, \`grep\`, \`sed\` and friends are GNU/BSD variants. To install packages prefer ${packageHint}.`;
}

export interface ShellInvocation {
  readonly executable: string;
  readonly args: string[];
  /** Command text as passed to the shell (unquoted). */
  readonly command: string;
}

/** Build the argv used to run `command` through the resolved shell. */
export function buildShellCommand(shell: ShellProfile, command: string): ShellInvocation {
  if (shell.kind === "powershell") {
    return {
      executable: shell.executable,
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
      command,
    };
  }
  if (shell.kind === "cmd") {
    return { executable: shell.executable, args: ["/d", "/s", "/c", command], command };
  }
  if (shell.kind === "fish") {
    return { executable: shell.executable, args: ["-c", command], command };
  }
  return { executable: shell.executable, args: ["-lc", command], command };
}

/** Quote a value for interpolation into a command in the given shell. */
export function quoteForShell(value: string, shell: ShellProfile): string {
  if (shell.kind === "powershell") {
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (shell.kind === "cmd") {
    return value.includes(" ") ? `"${value}"` : value;
  }
  return shellQuote(value, { os: "linux", sep: "/", caseSensitivePaths: true, crlfByDefault: false } as PlatformInfo);
}
