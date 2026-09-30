/**
 * Picking an all-rounder from a model catalog.
 *
 * The scores here are deliberately boring and configurable. Every weight lives
 * in `WEIGHTS` with a comment saying what it buys, and `scoreModel` returns the
 * per-factor breakdown alongside the total, so the settings panel can show *why*
 * a model won instead of asserting a preference the user cannot check.
 *
 * Two rules the heuristic must never break:
 *  - no model ids or names are matched, except to exclude models that are
 *    clearly not conversational (embeddings, audio, image generation)
 *  - a model that cannot call tools is never eligible for Cowork or Code
 */

import type { ModelInfo } from "../models/provider.js";
import {
  freenessFor,
  isFreeEnough,
  type Freeness,
} from "../models/freeness.js";
import type { ProviderDefinition } from "../providers/registry.js";
import type { Mode } from "../settings/schema.js";

export interface Weights {
  /** Big context windows, with diminishing returns so 10M is not 10x 1M. */
  readonly context: number;
  /** Headroom for long tool outputs and diffs. */
  readonly output: number;
  /** Thinking models handle multi-step code better. */
  readonly reasoning: number;
  /** Can read screenshots and PDFs the user attaches. */
  readonly vision: number;
  /** Newer models usually beat older ones on the same task. */
  readonly recency: number;
  /** Charged models are worse than free ones *for the same quality*. */
  readonly cost: number;
  /**
   * We have completed a real call to this model from Atomic with no credential.
   *
   * This is the one signal here that is not read off a spec. Everything else is
   * a claim by Zen or an inference from a model card; this is a thing that
   * happened. A model that has been refused the free tier, or that has never
   * been reached, scores 0 -- so among equally good free models, Auto picks the
   * one we know actually answers, instead of the one whose price is lowest on
   * paper.
   */
  readonly reachability: number;
}

const SHARED: Weights = {
  context: 0.3,
  output: 0.15,
  reasoning: 0.15,
  vision: 0.08,
  recency: 0.12,
  cost: 0.2,
  // Deliberately a tiebreak, not a trump card. Chosen so that the full swing of
  // a useless context window (8k vs 128k, scored 0 vs 0.57 on a 0.22 weight)
  // still outranks it: being reachable is worth something, but not more than
  // being able to do the job. An untested model is not a bad model.
  reachability: 0.10,
};

/**
 * Per-mode weights. Chat leans on general quality and cost; the agentic modes
 * move weight onto context and reasoning because that is what a long tool-using
 * turn actually spends its budget on.
 */
export const WEIGHTS: Readonly<Record<Mode, Weights>> = {
  chat: { ...SHARED, context: 0.22, reasoning: 0.08, cost: 0.28 },
  cowork: { ...SHARED, context: 0.32, reasoning: 0.2, output: 0.18 },
  code: {
    ...SHARED,
    context: 0.34,
    reasoning: 0.22,
    output: 0.18,
    recency: 0.08,
  },
};

/** Modes that must drive tools, so a model without tool calling is ineligible. */
const REQUIRES_TOOLS: ReadonlySet<Mode> = new Set(["cowork", "code"]);

export interface ScoredModel {
  readonly model: ModelInfo;
  readonly freeness: Freeness;
  readonly reason: string;
  /** 0..1, higher is better. Comparable only within one mode. */
  readonly score: number;
  /** Per-factor contributions, for the "Why this model?" panel. */
  readonly factors: readonly {
    readonly label: string;
    readonly detail: string;
    readonly weight: number;
  }[];
}

/**
 * Model kinds that cannot hold a conversation.
 *
 * This is the one place names are inspected, and it is a denylist of families
 * that are unambiguously not chat models. Anything not listed is treated as
 * eligible rather than risking a false exclusion.
 */
const NON_CHAT_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly why: string;
}[] = [
  { pattern: /embed/i, why: "embedding model" },
  { pattern: /(whisper|tts|transcribe|speech)/i, why: "audio model" },
  {
    pattern: /(dall-?e|image-gen|stable-diffusion|flux|imagen)/i,
    why: "image model",
  },
  { pattern: /(rerank|moderation|moderator)/i, why: "non-generative model" },
];

export function isNonChatModel(model: ModelInfo): boolean {
  return NON_CHAT_PATTERNS.some((entry) => entry.pattern.test(model.id));
}

/** Log-scaled so context grows usefully without one huge window dominating. */
function contextScore(contextWindow: number | undefined): number {
  if (!contextWindow || contextWindow <= 0) return 0;
  // 8k -> ~0, 1M -> ~1. log10(window/8000)/log10(1M/8000)
  const ratio = contextWindow / 8_000;
  if (ratio <= 1) return 0;
  return Math.min(1, Math.log10(ratio) / Math.log10(1_000_000 / 8_000));
}

function outputScore(maxOutput: number | undefined): number {
  if (!maxOutput || maxOutput <= 0) return 0;
  return Math.min(1, Math.log10(maxOutput / 512) / Math.log10(64_000 / 512));
}

/** Newer is better, saturating around 18 months old. */
function recencyScore(releaseDate: string | undefined, now: number): number {
  if (!releaseDate) return 0.4; // Unknown, not worst-case: most models are new.
  const parsed = Date.parse(releaseDate);
  if (Number.isNaN(parsed)) return 0.4;
  const ageDays = (now - parsed) / 86_400_000;
  if (ageDays <= 0) return 1;
  return Math.max(0, 1 - ageDays / 548);
}

/** Cheaper is better, saturating at $10/M in and $30/M out. */
function costScore(freeness: Freeness, model: ModelInfo): number {
  if (freeness === "free") return 1;
  if (freeness === "free-tier") return 0.85;
  if (freeness === "unknown") return 0.5;
  const input = model.cost?.input ?? 0;
  const output = model.cost?.output ?? 0;
  const blended = (input + output) / 2;
  if (blended <= 0) return 1;
  return Math.max(0, 1 - Math.log10(blended / 0.05) / Math.log10(10 / 0.05));
}

/** Penalise preview / experimental / retired models so stable ones win ties. */
function statusPenalty(model: ModelInfo): number {
  const text = `${model.id} ${model.name}`.toLowerCase();
  if (/\b(deprecated|legacy|retired|sunset)\b/.test(text)) return 0.4;
  if (/\b(preview|experimental|alpha|beta|rc\d|dev)\b/.test(text)) return 0.8;
  return 1;
}

export interface RankOptions {
  readonly provider: ProviderDefinition;
  readonly mode: Mode;
  /** When true, only `free` models are eligible. */
  readonly onlyFree: boolean;
  readonly now?: number;
  readonly weights?: Weights;
}

export function scoreModel(
  model: ModelInfo,
  options: RankOptions,
): ScoredModel {
  const { provider, mode, onlyFree } = options;
  const now = options.now ?? Date.now();
  const weights = options.weights ?? WEIGHTS[mode];
  const caps = model.capabilities;
  const freeness = freenessFor(provider, model).freeness;

  const context = contextScore(caps.contextWindow);
  const output = outputScore(caps.maxOutputTokens);
  const reasoning = caps.reasoning ? 1 : 0;
  const vision = caps.vision ? 1 : 0;
  const recency = recencyScore(model.releaseDate, now);
  const cost = costScore(freeness, model);
  const reachability = model.verifiedReachable ? 1 : 0;

  const factors = [
    {
      label: "Context",
      detail: formatTokens(caps.contextWindow),
      value: context,
      weight: weights.context,
    },
    {
      label: "Output",
      detail: formatTokens(caps.maxOutputTokens),
      value: output,
      weight: weights.output,
    },
    {
      label: "Reasoning",
      detail: caps.reasoning ? "supports reasoning" : "no reasoning",
      value: reasoning,
      weight: weights.reasoning,
    },
    {
      label: "Vision",
      detail: caps.vision ? "reads images" : "text only",
      value: vision,
      weight: weights.vision,
    },
    {
      label: "Recency",
      detail: model.releaseDate ?? "unknown release",
      value: recency,
      weight: weights.recency,
    },
    {
      label: "Cost",
      detail: freeness === "free" ? "free" : freeness,
      value: cost,
      weight: weights.cost,
    },
    {
      label: "Reachable",
      detail: model.verifiedReachable
        ? "answered a real call from Atomic"
        : "not yet reached from Atomic",
      value: reachability,
      weight: weights.reachability,
    },
  ];

  const weighted =
    factors.reduce((sum, factor) => sum + factor.value * factor.weight, 0) *
    statusPenalty(model);
  const weightTotal =
    factors.reduce((sum, factor) => sum + factor.weight, 0) || 1;
  const score = weighted / weightTotal;

  const detail = freenessFor(provider, model);
  return {
    model,
    freeness,
    reason: detail.reason,
    score,
    factors: factors.map((factor) => ({
      label: factor.label,
      detail: factor.detail,
      weight: factor.weight,
    })),
  };
}

/** Why this model is ineligible, or `null` when it is eligible. */
export function ineligibility(
  model: ModelInfo,
  options: RankOptions,
): string | null {
  if (isNonChatModel(model)) {
    const hit = NON_CHAT_PATTERNS.find((entry) => entry.pattern.test(model.id));
    return `Not a conversational model (${hit?.why ?? "specialised"}).`;
  }
  if (!model.capabilities.streaming) return "Does not support streaming.";
  if (REQUIRES_TOOLS.has(options.mode) && !model.capabilities.tools) {
    return "Cannot call tools, so it cannot work in this mode.";
  }
  // Learned, not declared: we called this model and were told we may not have
  // it. Automatic selection must not spend a turn rediscovering that, and the
  // reason comes from the provider so the UI can show it verbatim.
  if (model.unavailableInAtomic) {
    return `Not usable from Atomic: ${model.unavailableInAtomic.reason}`;
  }
  if (
    !isFreeEnough(
      freenessFor(options.provider, model).freeness,
      options.onlyFree,
    )
  ) {
    return options.onlyFree
      ? "Not free, and auto-selection is limited to free models."
      : "Not free.";
  }
  return null;
}

export interface RankedCatalog {
  /** Eligible models, best first. */
  readonly ranked: readonly ScoredModel[];
  /** Why nothing was eligible, when nothing was. */
  readonly emptyReason: string | null;
  /** Models that were excluded and how, for an honest UI message. */
  readonly excluded: readonly {
    readonly id: string;
    readonly reason: string;
  }[];
}

export function rankModels(
  models: readonly ModelInfo[],
  options: RankOptions,
): RankedCatalog {
  const scored: ScoredModel[] = [];
  const excluded: { id: string; reason: string }[] = [];

  for (const model of models) {
    const reason = ineligibility(model, options);
    if (reason) {
      excluded.push({ id: model.id, reason });
      continue;
    }
    scored.push(scoreModel(model, options));
  }

  scored.sort(
    (a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id),
  );

  return {
    ranked: scored,
    excluded,
    emptyReason:
      scored.length > 0
        ? null
        : options.onlyFree
          ? "No free model on this provider can run this mode."
          : "No model on this provider can run this mode.",
  };
}

/**
 * The model to use, plus the ordered list to fall back through.
 *
 * A free-only policy that finds nothing returns no choice at all rather than a
 * paid one: choosing a paid model silently is the one outcome that must never
 * happen without the user agreeing to it first.
 */
export interface AutoSelection {
  readonly chosen: ScoredModel | null;
  /** Ordered fallbacks, excluding `chosen`. */
  readonly fallbacks: readonly ScoredModel[];
  readonly ranked: readonly ScoredModel[];
  readonly emptyReason: string | null;
  /** True when nothing free exists and a paid model is the only option. */
  readonly needsPaidConfirmation: boolean;
  readonly cheapestPaid: ScoredModel | null;
}

/**
 * One model paired with the provider that will actually serve it.
 *
 * Duplicated here rather than imported from `auto-model.ts` because that module
 * imports this one, and a cycle between the two would make the ranking's
 * eligibility rules depend on import order.
 */
export interface RankedCandidate {
  readonly provider: ProviderDefinition;
  readonly model: ModelInfo;
}

/** A scored candidate, with the provider kept attached. */
export interface ScoredCandidate {
  readonly candidate: RankedCandidate;
  readonly score: number;
  readonly freeness: Freeness;
  readonly reason: string;
  readonly factors: ScoredModel["factors"];
}

export interface CrossProviderAutoSelection {
  readonly chosen: ScoredCandidate | null;
  /**
   * Alternatives, best first.
   *
   * Ordered so that a *different provider* comes before another model on the
   * same one. A rate limit or an outage is usually one provider's problem, and
   * trying the provider that is currently refusing is the one fallback that
   * cannot work; switching provider is what actually recovers the send.
   */
  readonly fallbacks: readonly ScoredCandidate[];
  readonly ranked: readonly ScoredCandidate[];
  readonly emptyReason: string | null;
  readonly needsPaidConfirmation: boolean;
  readonly cheapestPaid: ScoredCandidate | null;
}

export interface CrossProviderRankOptions {
  readonly mode: Mode;
  readonly onlyFree: boolean;
  readonly now?: number;
  readonly weights?: Weights;
  /**
   * The provider the run is already using.
   *
   * Set when the result is a *fallback list*, so entries on other providers are
   * tried first. Left unset for the initial choice, where preferring novelty
   * would be wrong -- the user asked for this provider.
   */
  readonly avoidProviderId?: string;
}

/**
 * Rank every configured provider's models together, best first.
 *
 * Each model is scored under the provider that serves it, because freeness and
 * the paid/free gate are properties of that pair and not of a model id: the
 * same id can be free on one provider and paid on another, and a ranking that
 * flattened them first would compare prices that belong to different accounts.
 *
 * With one provider this reduces exactly to `selectAutoModel`. The multi-provider
 * ordering is applied on top: within a score, prefer the provider we are not
 * already using, so a fallback after a 429 changes provider before it changes
 * anything else.
 */
export function selectAutoModelAcrossProviders(
  candidates: readonly RankedCandidate[],
  options: CrossProviderRankOptions,
): CrossProviderAutoSelection {
  // The provider to treat as "already tried". A fallback that changes provider is
  // the only thing that recovers from a rate limit, so ordering is relative to
  // the model that was just chosen.
  const preferred = options.avoidProviderId;
  const now = options.now ?? Date.now();
  /**
   * Score one candidate. `forFreePass` says which pass is running, *not* what to
   * tell the scorer about the user's policy.
   *
   * These have to stay separate. The single-provider selector scores the paid
   * ranking with `onlyFree: false` so it can rank paid models for the "cheapest
   * paid" offer; if that flag also drove eligibility, Auto would quietly pick a
   * paid model while free-only was on. Eligibility is checked here against the
   * real freeness, and the policy flag is passed to the scorer only as a ranking
   * input.
   */
  const score = (
    candidate: RankedCandidate,
    forFreePass: boolean,
  ): ScoredCandidate | null => {
    const freeness = freenessFor(candidate.provider, candidate.model).freeness;
    if (forFreePass && !isFreeEnough(freeness, true)) return null;
    const scored = scoreModel(candidate.model, {
      provider: candidate.provider,
      mode: options.mode,
      onlyFree: options.onlyFree,
      now,
      ...(options.weights ? { weights: options.weights } : {}),
    });
    if (scored === null) return null;
    return {
      candidate,
      score: scored.score,
      freeness: scored.freeness,
      reason: scored.reason,
      factors: scored.factors,
    };
  };

  const free = candidates
    .map((candidate) => score(candidate, true))
    .filter((entry): entry is ScoredCandidate => entry !== null);

  if (free.length > 0) {
    // Rank order decides the *choice*; the provider preference only orders what
    // is left after it. Combining them would mean Auto picked the model just
    // because it was somewhere else, which is not a ranking.
    const ranked = sortAcrossProviders(free);
    const [chosen, ...alternatives] = ranked;
    return {
      chosen: chosen ?? null,
      fallbacks: sortAcrossProviders(alternatives, preferred),
      ranked,
      emptyReason: null,
      needsPaidConfirmation: false,
      cheapestPaid: null,
    };
  }

  // The paid ranking exists only to be offered, never to be chosen from: see the
  // `fallbacks: []` below.
  const paid = candidates
    .map((candidate) => score(candidate, false))
    .filter((entry): entry is ScoredCandidate => entry !== null);
  const ranked = sortAcrossProviders(paid);
  const reason = explainCrossProviderEmpty(candidates, options);
  return {
    chosen: null,
    // Empty under free-only, for the same reason as `selectAutoModel`: paid
    // models are offered here, never tried without being agreed to.
    fallbacks: [],
    ranked,
    emptyReason: reason,
    needsPaidConfirmation: ranked.length > 0,
    cheapestPaid: cheapestOf(ranked),
  };
}

/**
 * Order a ranking.
 *
 * `fallbackOrder` is set only when the list will be walked after something has
 * already failed, and it moves entries on *other* providers ahead of the rest --
 * but never ahead of a genuinely better model, because a rate limit is a
 * reason to change provider, not a reason to take a worse answer. The
 * preference applies within a score, so it orders ties rather than overriding
 * quality.
 *
 * With no `fallbackOrder` the order is score then provider id, which is stable:
 * two models with equal scores must resolve the same way on every launch, or
 * Auto silently changes the user's model between runs and the "why this model"
 * panel cannot explain it.
 */
function sortAcrossProviders(
  entries: readonly ScoredCandidate[],
  fallbackOrder?: string,
): readonly ScoredCandidate[] {
  return [...entries].sort((a, b) => {
    if (fallbackOrder !== undefined) {
      const aOther = a.candidate.provider.id !== fallbackOrder ? 0 : 1;
      const bOther = b.candidate.provider.id !== fallbackOrder ? 0 : 1;
      if (aOther !== bOther) return aOther - bOther;
    }
    return (
      b.score - a.score ||
      a.candidate.provider.id.localeCompare(b.candidate.provider.id) ||
      a.candidate.model.id.localeCompare(b.candidate.model.id)
    );
  });
}

/** Why nothing free was usable, across every provider. */
function explainCrossProviderEmpty(
  candidates: readonly RankedCandidate[],
  options: CrossProviderRankOptions,
): string {
  void options;
  if (candidates.length === 0) {
    return "No provider reported any models. Refresh the model list, or choose a model yourself.";
  }
  const free = candidates.filter((entry) =>
    isFreeEnough(freenessFor(entry.provider, entry.model).freeness, true),
  );
  if (free.length === 0) {
    return "No configured provider is offering a free model right now.";
  }
  if (options.mode !== "chat" && free.every((entry) => !entry.model.capabilities.tools)) {
    return "The free models available cannot use tools, which this mode needs.";
  }
  return "No free model available is suitable for this mode.";
}

export function selectAutoModel(
  models: readonly ModelInfo[],
  options: RankOptions,
): AutoSelection {
  const free = rankModels(models, { ...options, onlyFree: true });
  if (free.ranked.length > 0) {
    const [chosen, ...fallbacks] = free.ranked;
    return {
      chosen: chosen ?? null,
      fallbacks,
      ranked: free.ranked,
      emptyReason: null,
      needsPaidConfirmation: false,
      cheapestPaid: null,
    };
  }

  if (options.onlyFree) {
    // Nothing free. Report it, and offer the cheapest capable model as a
    // deliberate choice the user has to confirm.
    //
    // `fallbacks` is empty on purpose even though `ranked` lists paid models.
    // It used to be the paid ranking, which meant a run that could not find a
    // free model would still carry a list of paid ones to fall through to: the
    // policy that exists to stop that is enforced at resolution, but the list
    // outlived it, and a rate limit on a free model is exactly the moment it
    // gets used. The paid models are here to be *offered*, in `ranked` and
    // `cheapestPaid`, never to be tried without being agreed to.
    const paid = rankModels(models, { ...options, onlyFree: false });
    return {
      chosen: null,
      fallbacks: [],
      ranked: paid.ranked,
      emptyReason: free.emptyReason,
      needsPaidConfirmation: paid.ranked.length > 0,
      cheapestPaid: cheapest(paid.ranked),
    };
  }

  const paid = rankModels(models, { ...options, onlyFree: false });
  const [chosen, ...fallbacks] = paid.ranked;
  return {
    chosen: chosen ?? null,
    fallbacks,
    ranked: paid.ranked,
    emptyReason: paid.emptyReason,
    needsPaidConfirmation: false,
    cheapestPaid: null,
  };
}

/** Cheapest capable model, by blended price, used for the paid-confirmation hint. */
/** Cheapest genuinely paid entry, for a cross-provider ranked list. */
function cheapestOf(ranked: readonly ScoredCandidate[]): ScoredCandidate | null {
  let best: ScoredCandidate | null = null;
  for (const candidate of ranked) {
    const cost = candidate.candidate.model.cost;
    if (!cost || cost.input <= 0) continue;
    if (!best || cost.input < (best.candidate.model.cost?.input ?? Infinity)) best = candidate;
  }
  return best;
}

function cheapest(ranked: readonly ScoredModel[]): ScoredModel | null {
  let best: ScoredModel | null = null;
  for (const candidate of ranked) {
    const cost = candidate.model.cost;
    const blended = cost
      ? (cost.input + cost.output) / 2
      : Number.POSITIVE_INFINITY;
    if (!best) {
      best = candidate;
      continue;
    }
    const bestCost = best.model.cost;
    const bestBlended = bestCost
      ? (bestCost.input + bestCost.output) / 2
      : Number.POSITIVE_INFINITY;
    if (blended < bestBlended) best = candidate;
  }
  return best;
}

export function formatTokens(value: number | undefined): string {
  if (!value || value <= 0) return "unknown";
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
