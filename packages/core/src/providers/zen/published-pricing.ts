/**
 * Zen's published pricing table, read from the provider's own documentation.
 *
 * Why this exists: `models.dev` is the good signal, but it lags. At the time of
 * writing it has no entry for a model Zen is already serving, and one live
 * example -- `jev-1.13-free` -- carries an empty cost object rather than a real
 * zero. The docs table does list it. So without this second signal a model that
 * is free in fact, and free by name, still reads as `unknown` and is excluded
 * from free-only selection.
 *
 * Why it is a *signal* and not truth: the table is keyed by display name
 * ("Big Pickle"), not by model id, and the names do not always match the ones
 * the feed uses ("Muse Spark 1.3 Free" vs "Muse Spark 1.3 Contributor Free"). A
 * scraped HTML table with a fuzzy join is weaker evidence than a JSON price, and
 * it is consulted only after that price. Every consumer must treat a failure to
 * parse as "no opinion", never as "free" and never as "paid".
 */

import { ProviderErrorKind } from "../errors.js";

/** The docs page that carries the pricing table. */
export const ZEN_PRICING_URL = "https://opencode.ai/docs/zen";

/** Human-readable origin, quoted verbatim in the freeness reason. */
export const ZEN_PRICING_SOURCE = "OpenCode Zen's published pricing table";

export interface PublishedPrice {
  readonly free: boolean;
  readonly input?: number;
  readonly output?: number;
}

export interface PublishedPricing {
  /** Normalised display name -> price. */
  readonly prices: ReadonlyMap<string, PublishedPrice>;
  /** Models whose row existed but could not be understood. */
  readonly unparsed: number;
}

const PRICING_HEADING = 'id="pricing"';

/**
 * Normalise a name so the join can survive punctuation and case.
 *
 * "MiMo-V2.6-Flash Free" and "mimo v2.6 flash free" have to land on the same
 * key, and "Ling 3.0 Flash Fin Free" has to survive the dash-stripping that
 * makes that possible. Stripping *all* non-alphanumerics (rather than just
 * normalising dashes and spaces) is what lets the join tolerate both spellings.
 */
export function normalizeModelName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Strip tags and decode the handful of entities a docs table contains. */
function textOf(cell: string): string {
  return cell
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number(code)),
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a dollar figure, or `null` for the literal "Free".
 *
 * The table spells a zero price as the word "Free" rather than as "$0", which
 * is the only thing that makes the row unambiguous -- a bare dash is a column
 * that does not apply (cached-write on a free model, for instance), and must
 * not be read as either free or paid.
 */
function parsePriceCell(
  cell: string,
): { free: boolean; value?: number } | null {
  if (/^free$/i.test(cell)) return { free: true, value: 0 };
  const numeric = cell.replace(/[$,\s]/g, "").replace(/\/1m$/i, "");
  if (numeric === "" || !/^\d*\.?\d+$/.test(numeric)) return null;
  return { free: false, value: Number(numeric) };
}

/**
 * Extract the pricing table.
 *
 * Only the region after the "Pricing" heading is considered, and the scan stops
 * at the next heading: a docs page also carries a model *list* table, and a free
 * model appearing in a capability table is not a price.
 */
export function parseZenPricing(html: string): PublishedPricing | null {
  const start = html.indexOf(PRICING_HEADING);
  if (start === -1) return null;
  const rest = html.slice(start + PRICING_HEADING.length);
  const nextHeading = rest.search(/<h[1-6]\b/i);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  const prices = new Map<string, PublishedPrice>();
  let unparsed = 0;
  for (const row of section.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [
      ...(row[1] ?? "").matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi),
    ].map((cell) => textOf(cell[1] ?? ""));
    // Model, Input, Output. Anything shorter is not a price row.
    if (cells.length < 3) continue;
    const name = cells[0] ?? "";
    const inputCell = cells[1] ?? "";
    const outputCell = cells[2] ?? "";
    if (!name || /^model$/i.test(name)) continue;

    const input = parsePriceCell(inputCell);
    const output = parsePriceCell(outputCell);
    if (!input || !output) {
      unparsed += 1;
      continue;
    }
    const price: PublishedPrice =
      input.free && output.free
        ? { free: true }
        : { free: false, input: input.value, output: output.value };
    prices.set(normalizeModelName(name), price);
  }

  // A page with no readable rows means the markup changed, which is different
  // from a page that genuinely lists no prices. Returning null keeps the caller
  // from treating a parse failure as an authoritative empty price list.
  return prices.size > 0 ? { prices, unparsed } : null;
}

/** Fetch and parse the published table, or `null` on any failure. */
export async function fetchZenPricing(
  fetchText: (url: string, signal?: AbortSignal) => Promise<string>,
  signal?: AbortSignal,
): Promise<PublishedPricing | null> {
  try {
    return parseZenPricing(await fetchText(ZEN_PRICING_URL, signal));
  } catch (error) {
    // A 404 here is normal when the docs move; it must not surface as a provider
    // error, because the only consequence is one fewer signal.
    if (
      error instanceof Error &&
      (error as { kind?: string }).kind === ProviderErrorKind.parse
    ) {
      return null;
    }
    return null;
  }
}
