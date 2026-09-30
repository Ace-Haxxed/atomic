import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark" | "system";

export interface ThemeController {
  readonly theme: Theme;
  /** What `theme: "system"` actually resolved to right now. */
  readonly resolved: "light" | "dark";
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeController | null>(null);

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

export function ThemeProvider({
  initial = "system",
  children,
}: {
  initial?: Theme;
  children: ReactNode;
}) {
  const [theme, setTheme] = useState<Theme>(initial);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  // Track the OS setting live so switching windows does not strand the theme.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const resolved: "light" | "dark" =
    theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    // Keep the native window chrome in step with the app background.
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  const controller = useMemo<ThemeController>(
    () => ({ theme, resolved, setTheme }),
    [theme, resolved],
  );

  return <ThemeContext.Provider value={controller}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeController {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside <ThemeProvider>");
  return context;
}

/** Apply the persisted theme before React mounts, to avoid a flash of the wrong one. */
export function useApplyStoredTheme(theme: Theme): void {
  const apply = useCallback(() => {
    const dark = theme === "dark" || (theme === "system" && systemPrefersDark());
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }, [theme]);

  useEffect(apply, [apply]);
}
