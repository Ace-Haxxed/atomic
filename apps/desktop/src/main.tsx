/**
 * Entry point.
 *
 * The only thing that happens before React mounts is the theme, and that lives
 * in `index.html` so the first paint is already correct. Here we mount, then
 * wait for the host.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@atomic/ui";

import "@atomic/ui/styles.css";
import { App } from "./app/app.js";
import { HostProvider, useHostState } from "./app/host-context.js";
import { Spinner } from "@atomic/ui";

const container = document.getElementById("root");
if (!container) {
  // Without a mount point there is nothing to render into, and a silent failure
  // here would look exactly like a hung app.
  throw new Error("#root is missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <HostProvider>
        <Gate />
      </HostProvider>
    </ThemeProvider>
  </StrictMode>,
);

/**
 * Loading and failure states live here rather than inside `App`, so `App` can
 * assume a working host and never deal with a null API.
 */
function Gate() {
  const state = useHostState();
  if (state.status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-surface">
        <Spinner className="size-5 text-content-muted" />
      </div>
    );
  }
  if (state.status === "failed") {
    return <BootFailure message={state.error.message} />;
  }
  // Read the api off the state rather than through a hook: a hook called after
  // an early return breaks the rules of hooks the first time loading finishes.
  return <App api={state.api} degraded={state.degraded} />;
}

function BootFailure({ message }: { message: string }) {
  return (
    <div className="flex h-screen items-center justify-center bg-surface p-6">
      <div className="max-w-sm space-y-2 text-center">
        <h1 className="text-sm font-semibold text-danger">Atomic could not start</h1>
        <p className="text-[12px] text-content-muted">{message}</p>
        <button
          type="button"
          className="mt-2 rounded-md border border-border-base px-3 py-1.5 text-[12px] hover:bg-surface-raised"
          onClick={() => window.location.reload()}
        >
          Try again
        </button>
      </div>
    </div>
  );
}
