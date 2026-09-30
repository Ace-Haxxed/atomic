/**
 * The host, shared through React context.
 *
 * Bootstrap touches SQLite, the keychain and the OS, so it is async and can
 * fail. The UI therefore has three explicit states — loading, ready, failed —
 * rather than a nullable host that every component has to null-check.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { HostApi } from "@atomic/core";

import { bootstrap } from "../lib/bootstrap.js";

type HostState =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly api: HostApi;
      /** Set when the database is in memory only, so nothing is being saved. */
      readonly degraded: { readonly reason: string } | null;
    }
  | { readonly status: "failed"; readonly error: Error };

const HostContext = createContext<HostState | null>(null);

export function HostProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<HostState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    bootstrap()
      .then(({ api, degraded }) => {
        if (!cancelled) setState({ status: "ready", api, degraded });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "failed",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <HostContext.Provider value={state}>{children}</HostContext.Provider>;
}

export function useHostState(): HostState {
  const state = useContext(HostContext);
  if (!state) throw new Error("useHostState must be used inside <HostProvider>");
  return state;
}
