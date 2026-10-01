/**
 * The extension registry: which manifests exist, and which of them are in play.
 *
 * Discovery, validation and filtering are separate steps on purpose. The app has
 * to be able to say "a manifest is broken" without that meaning "no tools", and
 * "this extension does not apply to this platform" without that meaning "the user
 * installed something broken". So a rejected manifest is kept as a record with
 * its problems attached, an inapplicable one is kept but switched off, and only
 * an enabled-and-applicable one contributes tools.
 *
 * Duplicate ids are resolved last-wins with the conflict reported rather than
 * swallowed. Two manifests claiming one id means something is wrong with the
 * source -- a stale install, two extensions packaged under one name -- and
 * picking one silently means the other author's tools appear under someone else's
 * name, which is a supply-chain problem wearing a data-structure problem's
 * clothes. The user is told which id collided and which source won.
 */

import type { OsPlatform, PlatformInfo } from "../platform/platform.js";
import type { ExtensionPlatform } from "./manifest.js";
import {
  ExtensionManifestSchema,
  manifestCategories,
  manifestModes,
  validateManifest,
  type ExtensionManifest,
  type ManifestProblem,
} from "./manifest.js";

/** Everything the app can be asked about one extension. */
export interface ExtensionRecord {
  readonly manifest: ExtensionManifest;
  /** Present when validation failed. The manifest is the best-effort parse. */
  readonly problems: readonly ManifestProblem[];
  /** The app platform, resolved at construction rather than stored in the manifest. */
  readonly platform: PlatformInfo;
  /** Whether the user's own choice has it on. Distinct from whether it can run. */
  readonly enabled: boolean;
  /** Set when the registry cannot use it here, whatever the user chose. */
  readonly unavailable: UnavailableReason | undefined;
}

/**
 * Why an extension is not usable, when it is not the user's choice.
 *
 * A union rather than a string because each of these has a different fix, and a
 * user told "unavailable" with nothing else learns nothing: a platform the
 * extension was not built for cannot be fixed in Settings, a missing host port
 * cannot be fixed by re-enabling, and a duplicate id cannot be fixed by the user
 * at all.
 */
export type UnavailableReason =
  | { readonly kind: "platform"; readonly required: "linux" | "macos" | "win32" }
  | { readonly kind: "service"; readonly missing: readonly string[] }
  | { readonly kind: "credential" }
  | { readonly kind: "invalid"; readonly problems: readonly ManifestProblem[] }
  | { readonly kind: "shadowed"; readonly by: string; readonly bySource?: string };

/** One thing the host can say about itself, so enablement is checkable. */
export interface HostCapabilities {
  readonly platform: PlatformInfo;
  /** Names of the host services and ports that are actually wired up. */
  readonly services: readonly string[];
  /** Whether a credential the app can store is available. */
  readonly hasCredentialStore: boolean;
}

/** What the registry reports to the settings UI. */
export interface ExtensionSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  readonly publisher: string;
  readonly version: string;
  readonly enabled: boolean;
  /** Usable on this platform and by this host, ignoring the user's choice. */
  readonly available: boolean;
  readonly unavailable: UnavailableReason | undefined;
  readonly hidden: boolean;
  readonly toolNames: readonly string[];
  readonly categories: readonly string[];
  readonly modes: readonly string[];
  readonly problems: readonly ManifestProblem[];
  readonly source: string | undefined;
}

type Listener = () => void;

/** The subset of a manifest needed to show it in a list of broken things. */
const IdentitySchema = ExtensionManifestSchema.pick({
  id: true,
  name: true,
  description: true,
});

/**
 * Whatever identifies a manifest the schema would not accept in full.
 *
 * Parsed separately and strictly, so a broken `contributions` block cannot stop
 * the extension from appearing. Returns undefined only when there is no usable
 * id, which is the one field with no fallback: without it there is no row to put
 * the problem in.
 */
function identityOf(input: unknown): { manifest: ExtensionManifest; problems: readonly ManifestProblem[] } | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const picked = IdentitySchema.safeParse(input);
  if (!picked.success) return undefined;
  const salvaged = ExtensionManifestSchema.safeParse({
    ...picked.data,
    contributions: { tools: [] },
  });
  return salvaged.success ? { manifest: salvaged.data, problems: [] } : undefined;
}

/**
 * The desktop platform a manifest can target, or undefined when the app is
 * running somewhere it has none.
 *
 * The app's `OsPlatform` is wider than any manifest can honestly be: android,
 * ios and unknown are real values of it, and none of them is a platform a
 * desktop extension ships for. Returning undefined rather than guessing one is
 * what keeps a manifest marked `linux` from being offered on a phone build.
 */
export function extensionPlatformOf(os: OsPlatform): ExtensionPlatform | undefined {
  switch (os) {
    case "linux":
    case "macos":
    case "windows":
      return os === "windows" ? "win32" : os;
    default:
      return undefined;
  }
}

export class ExtensionRegistry {
  #records = new Map<string, ExtensionRecord>();
  /** Where the winning manifest for each id came from, for conflict messages. */
  #sources = new Map<string, string | undefined>();
  #choices = new Map<string, boolean>();
  #shadowed = new Map<string, { by: string; bySource: string | undefined }>();
  #listeners = new Set<Listener>();

  constructor(private capabilities: HostCapabilities) {}

  /**
   * Add a manifest from a source, replacing any earlier one with the same id.
   *
   * Returns the problems found, which the caller surfaces. An invalid manifest is
   * still recorded: dropping it would mean a typo in a `description` looks
   * identical to an extension that was never installed, and the first of those is
   * fixable.
   */
  discover(source: { readonly label?: string; readonly manifest: unknown }): readonly ManifestProblem[] {
    const { manifest, problems } = validateManifest(source.manifest);
    if (!manifest) {
      // Salvage whatever identifies it, so a manifest with one bad tool name is
      // still listed as "Example browser, 1 problem" rather than disappearing.
      // A user who cannot see it cannot fix it, and a manifest whose tool list is
      // wrong is usually one typo from working. Only a manifest with no usable id
      // at all has nowhere to be listed, and then the problems are all there is.
      const identity = identityOf(source.manifest);
      if (identity) {
        this.#record(
          identity.manifest,
          problems,
          source.label,
        );
      }
      return problems;
    }

    this.#record(manifest, problems, source.label);
    return problems;
  }

  #record(manifest: ExtensionManifest, problems: readonly ManifestProblem[], label: string | undefined): void {
    const id = manifest.id;
    if (this.#records.has(id)) {
      this.#shadowed.set(id, { by: id, bySource: this.#sources.get(id) });
    }
    this.#sources.set(id, label);
    this.#records.set(id, {
      manifest,
      problems,
      platform: this.capabilities.platform,
      enabled: this.#choices.get(id) ?? manifest.defaultEnabled,
      unavailable: this.#blockedBy(manifest, problems, this.#shadowed.get(id)),
    });
    this.#changed();
  }

  /**
   * Resolve whether the host can use a manifest at all, ignoring the user.
   *
   * Platform first, then services, then credentials: each is a hard
   * precondition, and reporting the first unmet one is what lets the UI say
   * something actionable rather than listing every reason an extension is off.
   */
  #blockedBy(
    manifest: ExtensionManifest,
    problems: readonly ManifestProblem[],
    shadowed: { by: string; bySource: string | undefined } | undefined,
  ): UnavailableReason | undefined {
    if (problems.length > 0) return { kind: "invalid", problems };
    if (shadowed) return { kind: "shadowed", by: shadowed.by, ...(shadowed.bySource ? { bySource: shadowed.bySource } : {}) };

    const { needsPlatform, requiresCredential, requiresService } = manifest.enablement;
    const os = extensionPlatformOf(this.capabilities.platform.os);
    // No desktop platform at all -- a mobile or unrecognised host -- blocks every
    // extension rather than allowing the ones that happen not to declare one.
    // A manifest with no `platforms` means "portable", not "runs anywhere".
    if (os === undefined) {
      return { kind: "platform", required: manifest.enablement.needsPlatform ?? "linux" };
    }
    if (needsPlatform && needsPlatform !== os) return { kind: "platform", required: needsPlatform };
    if (manifest.platforms.length > 0 && !manifest.platforms.includes(os)) {
      // The narrower of two conflicting statements wins: being offered on a
      // platform the tool cannot run on produces a tool that always refuses.
      const [narrowest] = manifest.platforms;
      if (narrowest) return { kind: "platform", required: narrowest };
    }
    const missing = requiresService.filter((service) => !this.capabilities.services.includes(service));
    if (missing.length > 0) return { kind: "service", missing };
    if ((requiresCredential || manifest.lifecycle.requiresCredential) && !this.capabilities.hasCredentialStore) {
      return { kind: "credential" };
    }
    return undefined;
  }

  /**
   * Turn the user's own choices on or off.
   *
   * Returns false when the extension cannot run here, rather than storing a
   * choice that will never take effect. Silently accepting it would leave the UI
   * showing a switch that is on and a capability that is not, which is the exact
   * shape of the bug this whole area started from.
   */
  setEnabled(id: string, enabled: boolean): boolean {
    const record = this.#records.get(id);
    if (!record) {
      // Only a refusal is remembered, and the asymmetry is the point.
      //
      // Recording "off" for an extension this machine does not have means that
      // uninstalling and reinstalling cannot quietly hand back a capability the
      // user decided against -- the failure is the one that matters, because a
      // tool the user turned off is a tool they expected not to be used.
      //
      // Recording "on" is refused, because there is nothing to turn on. A user
      // cannot have decided an absent extension should be active, and writing it
      // would let a manifest with `defaultEnabled: false` install itself switched
      // on the moment it appeared, having never been looked at.
      if (enabled) return false;
      this.#choices.set(id, false);
      this.#changed();
      return true;
    }
    if (enabled && record.unavailable) return false;
    this.#choices.set(id, enabled);
    if (record.enabled !== enabled) {
      this.#records.set(id, { ...record, enabled });
      this.#changed();
    }
    return true;
  }

  /** Extensions that are enabled and usable: the only ones that may contribute. */
  active(): ExtensionRecord[] {
    return [...this.#records.values()].filter(
      (record) => record.enabled && record.unavailable === undefined,
    );
  }

  /** Every known extension, installed or not, for a settings list. */
  all(): ExtensionRecord[] {
    return [...this.#records.values()];
  }

  get(id: string): ExtensionRecord | undefined {
    return this.#records.get(id);
  }

  /** Recompute availability. For when a service is wired up after startup. */
  refresh(): void {
    let changed = false;
    for (const [id, record] of this.#records) {
      const unavailable = this.#blockedBy(
        record.manifest,
        record.problems,
        this.#shadowed.get(id),
      );
      const same =
        (unavailable === undefined) === (record.unavailable === undefined) &&
        JSON.stringify(unavailable ?? null) === JSON.stringify(record.unavailable ?? null);
      if (!same) {
        this.#records.set(id, { ...record, unavailable });
        changed = true;
      }
    }
    if (changed) this.#changed();
  }

  /** Replace the host capabilities and re-resolve. Used when ports arrive late. */
  setCapabilities(capabilities: HostCapabilities): void {
    this.capabilities = capabilities;
    this.refresh();
  }

  summaries(): ExtensionSummary[] {
    return this.all().map((record) => ({
      id: record.manifest.id,
      name: record.manifest.name,
      description: record.manifest.description,
      icon: record.manifest.icon,
      publisher: record.manifest.publisher,
      version: record.manifest.version,
      enabled: record.enabled,
      available: record.unavailable === undefined,
      unavailable: record.unavailable,
      hidden: record.manifest.defaultHidden,
      toolNames: record.manifest.contributions.tools.map((tool) => tool.name),
      categories: [...manifestCategories(record.manifest)],
      modes: [...manifestModes(record.manifest)],
      problems: record.problems,
      source: record.manifest.source,
    }));
  }

  /** Tool names that some *inactive* extension also claims, and so must not be relied on. */
  contendedToolNames(): Map<string, string[]> {
    const owners = new Map<string, string[]>();
    for (const record of this.all()) {
      for (const tool of record.manifest.contributions.tools) {
        const existing = owners.get(tool.name);
        if (existing) existing.push(record.manifest.id);
        else owners.set(tool.name, [record.manifest.id]);
      }
    }
    for (const [name, ids] of owners) if (ids.length < 2) owners.delete(name);
    return owners;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  get size(): number {
    return this.#records.size;
  }
}
