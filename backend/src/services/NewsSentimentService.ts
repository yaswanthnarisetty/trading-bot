import axios from "axios";
import type { AssetKey } from "../config/assets";
import type { NewsSentiment } from "../types/trading";
import { generateNewsSentiment as generateMockSentiment } from "./MockDataService";
import { logger } from "../utils/logger";

interface CachedSentiment {
  data: NewsSentiment;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<AssetKey, CachedSentiment>();

const POSITIVE_KEYWORDS = [
  "surge",
  "rally",
  "growth",
  "beats",
  "strong",
  "record",
  "high",
  "gain",
];

const NEGATIVE_KEYWORDS = [
  "crash",
  "fall",
  "miss",
  "weak",
  "probe",
  "ban",
  "loss",
  "low",
  "drop",
];

/**
 * Scores a set of news headlines into aggregate sentiment.
 * The scoring is keyword-based and intentionally simple for deterministic behavior.
 *
 * @param headlines - Array of headline strings to analyse.
 * @returns An object containing sentiment label, numeric score, and a representative headline.
 */
export function scoreHeadlines(
  headlines: string[]
): { sentiment: NewsSentiment["sentiment"]; score: number; headline: string } {
  if (headlines.length === 0) {
    return {
      sentiment: "neutral",
      score: 0,
      headline: "No recent headlines available",
    };
  }

  let positiveCount = 0;
  let negativeCount = 0;

  for (const h of headlines) {
    const lower = h.toLowerCase();
    if (POSITIVE_KEYWORDS.some((k) => lower.includes(k))) {
      positiveCount += 1;
    }
    if (NEGATIVE_KEYWORDS.some((k) => lower.includes(k))) {
      negativeCount += 1;
    }
  }

  const total = Math.max(1, headlines.length);
  const score = (positiveCount - negativeCount) / total;

  const sentiment: NewsSentiment["sentiment"] =
    score > 0.1 ? "bullish" : score < -0.1 ? "bearish" : "neutral";

  return {
    sentiment,
    score,
    headline: headlines[0]!,
  };
}

/**
 * Generates a deterministic mock sentiment snapshot for testing.
 * This delegates to MockDataService and keeps all mock behavior centralized.
 *
 * @returns A NewsSentiment instance based on rotating canned headlines.
 */
export function getMockSentiment(): NewsSentiment {
  return generateMockSentiment();
}

/**
 * Fetches and caches news sentiment for a given asset.
 * Uses NewsAPI when configured, otherwise falls back to mock sentiment.
 *
 * @param asset - Asset symbol whose sentiment is being requested.
 * @returns Promise resolving to a NewsSentiment snapshot.
 */
export async function fetchSentiment(
  asset: AssetKey
): Promise<NewsSentiment> {
  const apiKey = process.env.NEWSAPI_KEY;

  const cached = cache.get(asset);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  if (!apiKey) {
    const mock = getMockSentiment();
    cache.set(asset, { data: mock, fetchedAt: now });
    return mock;
  }

  try {
    const response = await axios.get("https://newsapi.org/v2/everything", {
      params: {
        q: asset,
        language: "en",
        sortBy: "publishedAt",
        pageSize: 10,
      },
      headers: {
        "X-Api-Key": apiKey,
      },
    });

    const articles: Array<{ title?: string }> = response.data?.articles ?? [];
    const titles = articles
      .map((a) => a.title)
      .filter((t): t is string => Boolean(t));

    const scored = scoreHeadlines(titles);

    const sentiment: NewsSentiment = {
      sentiment: scored.sentiment,
      score: scored.score,
      headline: scored.headline,
    };

    cache.set(asset, { data: sentiment, fetchedAt: now });

    return sentiment;
  } catch (error) {
    logger.error("News sentiment fetch failed, using mock data", {
      asset,
      error,
    });
    const mock = getMockSentiment();
    cache.set(asset, { data: mock, fetchedAt: now });
    return mock;
  }
}

