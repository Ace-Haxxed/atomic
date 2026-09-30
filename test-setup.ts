/**
 * No test may reach the real network.
 *
 * Every provider takes its transport by injection, and every test that talks to
 * a provider passes one. That is easy to get wrong in a way which still looks
 * green: miss the injection, the provider silently falls back to the global
 * `fetch`, and the test either passes against production or fails for a reason
 * that has nothing to do with the assertion. Both happened repeatedly while
 * this suite was being written, once burning real requests and real quota.
 *
 * So the global is replaced once, here, for every test file. A test that meant
 * to make a request now fails on the spot, naming the URL it was not expecting,
 * instead of quietly doing it.
 */

import { beforeEach } from "vitest";

const realFetch = globalThis.fetch;

/** Tests that genuinely need the network opt in by name, explicitly. */
const ALLOWED = new Set<string>(process.env.ATOMIC_TEST_NETWORK_SPLIT ?? "");

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (ALLOWED.has(url)) return realFetch(input as RequestInfo, undefined);
    throw new Error(
      `A test tried to reach the network: ${url}\n` +
        `Provider tests must pass a stub \`fetch\` to the provider's deps. ` +
        `Set ATOMIC_TEST_NETWORK_SPLIT=${url} if this is deliberate.`,
    );
  }) as typeof fetch;
});
