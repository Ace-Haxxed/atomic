/**
 * Approval broker.
 *
 * When the permission gate returns `ask`, the run needs a human decision. The
 * in-process host resolves it from the UI; a notification with Approve/Deny
 * buttons can resolve the same pending request from the tray. Either way there
 * is exactly one pending-request table.
 */

import { ProviderError } from "../providers/errors.js";
import type { AllowList } from "../permissions/gate.js";
import type { Mode } from "../settings/schema.js";

export interface ApprovalRequest {
  readonly runId: string;
  readonly callId: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /**
   * The mode the call was made in, so a standing grant from "always allow" is
   * written to the allow-list the user was actually working in.
   */
  readonly mode: Mode;
  /** Human-readable line shown on the button in the notification. */
  readonly summary: string;
  /** Value the user can permanently allow. */
  readonly suggestion?: string;
  /**
   * Which allow-list `suggestion` belongs in.
   *
   * Carried with the value rather than left for the host to infer, because the
   * host has to write the entry to one specific list to make "always allow"
   * mean anything, and it cannot tell from a command line or a URL whether the
   * user meant a command, a domain or a path.
   */
  readonly suggestionList?: AllowList;
  readonly signal?: AbortSignal;
}

export type ApprovalDecision = "allow" | "deny" | "allow-always";

export interface PendingApproval extends ApprovalRequest {
  readonly createdAt: number;
}

export type ApprovalListener = (pending: readonly PendingApproval[]) => void;

export class ApprovalBroker {
  #pending = new Map<string, PendingApproval>();
  #waiters = new Map<string, (decision: ApprovalDecision) => void>();
  #listeners = new Set<ApprovalListener>();
  #timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    // Generous: an unattended Cowork run should wait rather than fail.
    this.#timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  }

  /** Ask for a decision. Rejects with a `cancelled` error if the run aborts. */
  request(request: ApprovalRequest): Promise<ApprovalDecision> {
    const existing = this.#waiters.get(request.callId);
    if (existing) return new Promise((resolve) => this.#waiters.set(request.callId, resolve));

    const entry: PendingApproval = { ...request, createdAt: Date.now() };
    this.#pending.set(request.callId, entry);
    this.#notify();

    return new Promise<ApprovalDecision>((resolve, reject) => {
      let settled = false;
      const finish = (decision: ApprovalDecision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#waiters.delete(request.callId);
        this.#pending.delete(request.callId);
        this.#notify();
        resolve(decision);
      };

      const timer = setTimeout(() => {
        finish("deny");
      }, this.#timeoutMs);

      this.#waiters.set(request.callId, finish);

      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#waiters.delete(request.callId);
        this.#pending.delete(request.callId);
        this.#notify();
        reject(new ProviderError("cancelled", "cancelled", "Run cancelled while awaiting approval"));
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Resolve a pending approval from anywhere (UI, tray notification, CLI). */
  resolve(callId: string, decision: ApprovalDecision): boolean {
    const waiter = this.#waiters.get(callId);
    if (!waiter) return false;
    waiter(decision);
    return true;
  }

  /** Deny everything; used when a run is cancelled. */
  denyAll(): void {
    for (const callId of [...this.#waiters.keys()]) this.resolve(callId, "deny");
  }

  list(): PendingApproval[] {
    return [...this.#pending.values()];
  }

  subscribe(listener: ApprovalListener): () => void {
    this.#listeners.add(listener);
    listener(this.list());
    return () => this.#listeners.delete(listener);
  }

  #notify(): void {
    const snapshot = this.list();
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error("[approval] listener failed", error);
      }
    }
  }
}
