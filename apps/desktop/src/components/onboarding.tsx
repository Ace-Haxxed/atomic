/**
 * First run.
 *
 * Two steps, because that is all it takes to be useful: connect a provider,
 * then pick a folder. Everything else has a safe default already, and a user
 * who wants to change it can reach settings from the first real conversation.
 */

import { useState } from "react";
import type { HostApi, Settings } from "@atomic/core";
import { Badge, Button, Card, CardBody, CardTitle, Separator, Spinner } from "@atomic/ui";

import { Icon } from "./sidebar.js";

export interface OnboardingProps {
  readonly api: HostApi;
  readonly settings: Settings;
  readonly onDone: (settings: Settings) => void;
}

export function Onboarding({ api, settings, onDone }: OnboardingProps) {
  const [step, setStep] = useState<"key" | "folder">("key");
  const [apiKey, setApiKey] = useState("");
  const [workspace, setWorkspace] = useState(settings.lastWorkspace || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    // An empty field is a legitimate choice: the key may come from an env var,
    // and a Linux box with no Secret Service must not be locked out of the app.
    if (apiKey.trim().length === 0) {
      setStep("folder");
      setBusy(false);
      return;
    }
    try {
      // The key goes to the keychain first: if that fails, the user is told now
      // rather than after a confusing first failed request.
      await api.setApiKey(settings.providerId, apiKey.trim());
      const result = await api.testConnection(settings.providerId);
      if (!result.ok) setError(result.message);
      setStep("folder");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const pickFolder = async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await api.pickFolder("Choose a folder to work in");
      if (picked) setWorkspace(picked);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.updateSettings({
        onboardingCompleted: true,
        lastWorkspace: workspace,
      });
      onDone(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-surface p-6">
      <Card className="w-full max-w-md">
        <CardBody className="space-y-4">
          <div>
            <p className="flex items-center gap-1.5 text-sm font-semibold text-content">
              <Icon name="chat" className="size-4 text-accent" />
              Welcome to Atomic
            </p>
            <p className="mt-1 text-[12px] text-content-muted">
              Two steps and you can start. Your key is stored in the OS keychain,
              never in the app's database.
            </p>
          </div>

          <ol className="flex items-center gap-2 text-[11px]">
            <li className="flex items-center gap-1">
              <Badge tone={step === "key" ? "accent" : "success"}>
                {step === "key" ? "1" : <Icon name="check" className="size-3" />}
              </Badge>
              Connect
            </li>
            <li className="h-px flex-1 bg-border-base" />
            <li className="flex items-center gap-1">
              <Badge tone={step === "folder" ? "accent" : "neutral"}>2</Badge>
              Folder
            </li>
          </ol>

          <Separator />

          {step === "key" ? (
            <div className="space-y-2">
              <label className="block">
                <span className="mb-1 block text-[11px] text-content-muted">
                  OpenCode Zen API key
                </span>
                <input
                  type="password"
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="sk-…"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && apiKey.trim()) void connect();
                  }}
                  className="h-9 w-full rounded-md border border-border-base bg-surface-raised px-2 font-mono text-sm text-content focus:border-accent focus:outline-none"
                />
              </label>
              <p className="text-[11px] text-content-muted">
                Get one at{" "}
                <span className="font-mono">opencode.ai/zen</span>. Without a key
                you can still browse, but nothing will answer.
              </p>
              <Button
                variant="primary"
                size="lg"
                block
                disabled={busy}
                onClick={() => void connect()}
              >
                {busy
                  ? "Checking…"
                  : apiKey.trim().length > 0
                    ? "Connect"
                    : "Skip for now"}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <CardTitle className="text-xs">Where should Atomic work?</CardTitle>
              <div className="flex items-center gap-1.5">
                <input
                  readOnly
                  value={workspace}
                  placeholder="No folder chosen — you can pick one later"
                  className="h-8 flex-1 rounded-md border border-border-base bg-surface-raised px-2 font-mono text-[11px] text-content"
                />
                <Button size="sm" onClick={() => void pickFolder()}>
                  <Icon name="folder" />
                  Choose
                </Button>
              </div>
              <p className="text-[11px] text-content-muted">
                A folder gives Code and Cowork a workspace, and lets Atomic read
                <span className="font-mono"> AGENTS.md</span> for project rules.
              </p>
              <Button
                variant="primary"
                size="lg"
                block
                disabled={busy}
                onClick={() => void finish()}
              >
                {busy ? <Spinner className="size-4" /> : null}
                Start chatting
              </Button>
            </div>
          )}

          {error ? (
            <p role="alert" className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] text-danger">
              {error}
            </p>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}
