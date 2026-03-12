import { z } from "zod";
import { type PrimarySignal } from "./signal";
import { type VerifierResult } from "./verifier";
import { type IndicatorSnapshot } from "./indicators";
import { type GreeksSnapshot } from "./greeks";
import { type ExpiryContext } from "./expiry";
import { type OptionsPosition } from "./trade";
/**
 * Zod schema describing the payload for a real-time trading signal message.
 * This message is pushed over WebSocket to synchronize LLM decisions and analysis context.
 */
export declare const signalPayloadSchema: z.ZodObject<{
    sessionId: z.ZodString;
    asset: z.ZodString;
    ltp: z.ZodNumber;
    signal: z.ZodObject<{
        direction: z.ZodEnum<["BULLISH", "BEARISH", "NEUTRAL", "HOLD"]>;
        strategy: z.ZodEnum<["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD", "HOLD"]>;
        strikeSelection: z.ZodObject<{
            rationale: z.ZodString;
            preferredDelta: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            preferredDTE: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        }, "strip", z.ZodTypeAny, {
            rationale: string;
            preferredDelta?: number | null | undefined;
            preferredDTE?: number | null | undefined;
        }, {
            rationale: string;
            preferredDelta?: number | null | undefined;
            preferredDTE?: number | null | undefined;
        }>;
        ivContext: z.ZodEnum<["selling_cheap", "selling_fair", "selling_expensive"]>;
        confidence: z.ZodNumber;
        reasoning: z.ZodString;
        keyFactors: z.ZodArray<z.ZodString, "many">;
        riskFlags: z.ZodArray<z.ZodString, "many">;
        suggestedEntry: z.ZodNullable<z.ZodNumber>;
        suggestedSL: z.ZodNullable<z.ZodNumber>;
        suggestedTarget: z.ZodNullable<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";
        strategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        strikeSelection: {
            rationale: string;
            preferredDelta?: number | null | undefined;
            preferredDTE?: number | null | undefined;
        };
        ivContext: "selling_cheap" | "selling_fair" | "selling_expensive";
        confidence: number;
        reasoning: string;
        keyFactors: string[];
        riskFlags: string[];
        suggestedEntry: number | null;
        suggestedSL: number | null;
        suggestedTarget: number | null;
    }, {
        direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";
        strategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        strikeSelection: {
            rationale: string;
            preferredDelta?: number | null | undefined;
            preferredDTE?: number | null | undefined;
        };
        ivContext: "selling_cheap" | "selling_fair" | "selling_expensive";
        confidence: number;
        reasoning: string;
        keyFactors: string[];
        riskFlags: string[];
        suggestedEntry: number | null;
        suggestedSL: number | null;
        suggestedTarget: number | null;
    }>;
    verifierResult: z.ZodNullable<z.ZodObject<{
        verified: z.ZodBoolean;
        adjustedStrategy: z.ZodEnum<["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD", "HOLD"]>;
        adjustedConfidence: z.ZodNumber;
        auditNotes: z.ZodString;
        overruled: z.ZodBoolean;
        additionalRiskFlags: z.ZodArray<z.ZodString, "many">;
    }, "strip", z.ZodTypeAny, {
        verified: boolean;
        adjustedStrategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        adjustedConfidence: number;
        auditNotes: string;
        overruled: boolean;
        additionalRiskFlags: string[];
    }, {
        verified: boolean;
        adjustedStrategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        adjustedConfidence: number;
        auditNotes: string;
        overruled: boolean;
        additionalRiskFlags: string[];
    }>>;
    riskAction: z.ZodEnum<["SUGGEST", "BLOCK"]>;
    blockReason: z.ZodNullable<z.ZodString>;
    indicators: z.ZodObject<{
        rsi: z.ZodNumber;
        ema20: z.ZodNullable<z.ZodNumber>;
        ema50: z.ZodNullable<z.ZodNumber>;
        atr: z.ZodNullable<z.ZodNumber>;
        volumeRatio: z.ZodNumber;
        regime: z.ZodEnum<["trending", "ranging", "volatile", "INSUFFICIENT_DATA"]>;
        priceVsEma20: z.ZodEnum<["above", "below", "unknown"]>;
        priceVsEma50: z.ZodEnum<["above", "below", "unknown"]>;
        emaAlignment: z.ZodEnum<["bullish", "bearish", "mixed"]>;
        candleCount: z.ZodOptional<z.ZodNumber>;
        rsiSlope: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        candleMomentum: z.ZodOptional<z.ZodEnum<["BULLISH", "BEARISH", "NEUTRAL"]>>;
    }, "strip", z.ZodTypeAny, {
        rsi: number;
        ema20: number | null;
        ema50: number | null;
        atr: number | null;
        volumeRatio: number;
        regime: "trending" | "ranging" | "volatile" | "INSUFFICIENT_DATA";
        priceVsEma20: "unknown" | "above" | "below";
        priceVsEma50: "unknown" | "above" | "below";
        emaAlignment: "bullish" | "bearish" | "mixed";
        candleCount?: number | undefined;
        rsiSlope?: number | null | undefined;
        candleMomentum?: "BULLISH" | "BEARISH" | "NEUTRAL" | undefined;
    }, {
        rsi: number;
        ema20: number | null;
        ema50: number | null;
        atr: number | null;
        volumeRatio: number;
        regime: "trending" | "ranging" | "volatile" | "INSUFFICIENT_DATA";
        priceVsEma20: "unknown" | "above" | "below";
        priceVsEma50: "unknown" | "above" | "below";
        emaAlignment: "bullish" | "bearish" | "mixed";
        candleCount?: number | undefined;
        rsiSlope?: number | null | undefined;
        candleMomentum?: "BULLISH" | "BEARISH" | "NEUTRAL" | undefined;
    }>;
    greeksSnapshot: z.ZodNullable<z.ZodObject<{
        delta: z.ZodNumber;
        gamma: z.ZodNumber;
        theta: z.ZodNumber;
        vega: z.ZodNumber;
        currentIV: z.ZodNumber;
        ivRank: z.ZodNumber;
        ivPercentile: z.ZodNumber;
        ivTrend: z.ZodEnum<["expanding", "contracting", "stable"]>;
        pcr: z.ZodNumber;
        maxPain: z.ZodNumber;
        oiSkew: z.ZodEnum<["calls_heavy", "puts_heavy", "neutral"]>;
        nearWeekIV: z.ZodNumber;
        nextWeekIV: z.ZodNumber;
        expectedMoveUp: z.ZodNumber;
        expectedMoveDown: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        delta: number;
        gamma: number;
        theta: number;
        vega: number;
        currentIV: number;
        ivRank: number;
        ivPercentile: number;
        ivTrend: "expanding" | "contracting" | "stable";
        pcr: number;
        maxPain: number;
        oiSkew: "calls_heavy" | "puts_heavy" | "neutral";
        nearWeekIV: number;
        nextWeekIV: number;
        expectedMoveUp: number;
        expectedMoveDown: number;
    }, {
        delta: number;
        gamma: number;
        theta: number;
        vega: number;
        currentIV: number;
        ivRank: number;
        ivPercentile: number;
        ivTrend: "expanding" | "contracting" | "stable";
        pcr: number;
        maxPain: number;
        oiSkew: "calls_heavy" | "puts_heavy" | "neutral";
        nearWeekIV: number;
        nextWeekIV: number;
        expectedMoveUp: number;
        expectedMoveDown: number;
    }>>;
    expiryContext: z.ZodObject<{
        currentDTE: z.ZodNumber;
        nextExpiryDTE: z.ZodNumber;
        nearestExpiry: z.ZodString;
        isExpiryWeek: z.ZodBoolean;
        isExpiryDay: z.ZodBoolean;
        thetaRisk: z.ZodEnum<["high", "medium", "low"]>;
    }, "strip", z.ZodTypeAny, {
        currentDTE: number;
        nextExpiryDTE: number;
        nearestExpiry: string;
        isExpiryWeek: boolean;
        isExpiryDay: boolean;
        thetaRisk: "high" | "medium" | "low";
    }, {
        currentDTE: number;
        nextExpiryDTE: number;
        nearestExpiry: string;
        isExpiryWeek: boolean;
        isExpiryDay: boolean;
        thetaRisk: "high" | "medium" | "low";
    }>;
    paperPnL: z.ZodNumber;
    openPositions: z.ZodNumber;
    dataMode: z.ZodEnum<["LIVE", "MOCK"]>;
    timestamp: z.ZodNumber;
    /** S/R context — optional, present when SR data is available for the tick */
    srContext: z.ZodOptional<z.ZodUnknown>;
    /** Breakout detection result — optional, present when breakout analysis ran */
    breakoutResult: z.ZodOptional<z.ZodUnknown>;
}, "strip", z.ZodTypeAny, {
    sessionId: string;
    asset: string;
    dataMode: "LIVE" | "MOCK";
    paperPnL: number;
    ltp: number;
    signal: {
        direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";
        strategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        strikeSelection: {
            rationale: string;
            preferredDelta?: number | null | undefined;
            preferredDTE?: number | null | undefined;
        };
        ivContext: "selling_cheap" | "selling_fair" | "selling_expensive";
        confidence: number;
        reasoning: string;
        keyFactors: string[];
        riskFlags: string[];
        suggestedEntry: number | null;
        suggestedSL: number | null;
        suggestedTarget: number | null;
    };
    verifierResult: {
        verified: boolean;
        adjustedStrategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        adjustedConfidence: number;
        auditNotes: string;
        overruled: boolean;
        additionalRiskFlags: string[];
    } | null;
    riskAction: "SUGGEST" | "BLOCK";
    blockReason: string | null;
    indicators: {
        rsi: number;
        ema20: number | null;
        ema50: number | null;
        atr: number | null;
        volumeRatio: number;
        regime: "trending" | "ranging" | "volatile" | "INSUFFICIENT_DATA";
        priceVsEma20: "unknown" | "above" | "below";
        priceVsEma50: "unknown" | "above" | "below";
        emaAlignment: "bullish" | "bearish" | "mixed";
        candleCount?: number | undefined;
        rsiSlope?: number | null | undefined;
        candleMomentum?: "BULLISH" | "BEARISH" | "NEUTRAL" | undefined;
    };
    greeksSnapshot: {
        delta: number;
        gamma: number;
        theta: number;
        vega: number;
        currentIV: number;
        ivRank: number;
        ivPercentile: number;
        ivTrend: "expanding" | "contracting" | "stable";
        pcr: number;
        maxPain: number;
        oiSkew: "calls_heavy" | "puts_heavy" | "neutral";
        nearWeekIV: number;
        nextWeekIV: number;
        expectedMoveUp: number;
        expectedMoveDown: number;
    } | null;
    expiryContext: {
        currentDTE: number;
        nextExpiryDTE: number;
        nearestExpiry: string;
        isExpiryWeek: boolean;
        isExpiryDay: boolean;
        thetaRisk: "high" | "medium" | "low";
    };
    openPositions: number;
    timestamp: number;
    srContext?: unknown;
    breakoutResult?: unknown;
}, {
    sessionId: string;
    asset: string;
    dataMode: "LIVE" | "MOCK";
    paperPnL: number;
    ltp: number;
    signal: {
        direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";
        strategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        strikeSelection: {
            rationale: string;
            preferredDelta?: number | null | undefined;
            preferredDTE?: number | null | undefined;
        };
        ivContext: "selling_cheap" | "selling_fair" | "selling_expensive";
        confidence: number;
        reasoning: string;
        keyFactors: string[];
        riskFlags: string[];
        suggestedEntry: number | null;
        suggestedSL: number | null;
        suggestedTarget: number | null;
    };
    verifierResult: {
        verified: boolean;
        adjustedStrategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        adjustedConfidence: number;
        auditNotes: string;
        overruled: boolean;
        additionalRiskFlags: string[];
    } | null;
    riskAction: "SUGGEST" | "BLOCK";
    blockReason: string | null;
    indicators: {
        rsi: number;
        ema20: number | null;
        ema50: number | null;
        atr: number | null;
        volumeRatio: number;
        regime: "trending" | "ranging" | "volatile" | "INSUFFICIENT_DATA";
        priceVsEma20: "unknown" | "above" | "below";
        priceVsEma50: "unknown" | "above" | "below";
        emaAlignment: "bullish" | "bearish" | "mixed";
        candleCount?: number | undefined;
        rsiSlope?: number | null | undefined;
        candleMomentum?: "BULLISH" | "BEARISH" | "NEUTRAL" | undefined;
    };
    greeksSnapshot: {
        delta: number;
        gamma: number;
        theta: number;
        vega: number;
        currentIV: number;
        ivRank: number;
        ivPercentile: number;
        ivTrend: "expanding" | "contracting" | "stable";
        pcr: number;
        maxPain: number;
        oiSkew: "calls_heavy" | "puts_heavy" | "neutral";
        nearWeekIV: number;
        nextWeekIV: number;
        expectedMoveUp: number;
        expectedMoveDown: number;
    } | null;
    expiryContext: {
        currentDTE: number;
        nextExpiryDTE: number;
        nearestExpiry: string;
        isExpiryWeek: boolean;
        isExpiryDay: boolean;
        thetaRisk: "high" | "medium" | "low";
    };
    openPositions: number;
    timestamp: number;
    srContext?: unknown;
    breakoutResult?: unknown;
}>;
export type SignalPayload = z.infer<typeof signalPayloadSchema>;
/**
 * Zod schemas for individual WebSocket message variants used between backend and frontend.
 * Every message carries a type discriminator to enable robust union parsing and validation.
 */
export declare const signalMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"SIGNAL">;
    payload: z.ZodObject<{
        sessionId: z.ZodString;
        asset: z.ZodString;
        ltp: z.ZodNumber;
        signal: z.ZodObject<{
            direction: z.ZodEnum<["BULLISH", "BEARISH", "NEUTRAL", "HOLD"]>;
            strategy: z.ZodEnum<["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD", "HOLD"]>;
            strikeSelection: z.ZodObject<{
                rationale: z.ZodString;
                preferredDelta: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
                preferredDTE: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            }, "strip", z.ZodTypeAny, {
                rationale: string;
                preferredDelta?: number | null | undefined;
                preferredDTE?: number | null | undefined;
            }, {
                rationale: string;
                preferredDelta?: number | null | undefined;
                preferredDTE?: number | null | undefined;
            }>;
            ivContext: z.ZodEnum<["selling_cheap", "selling_fair", "selling_expensive"]>;
            confidence: z.ZodNumber;
            reasoning: z.ZodString;
            keyFactors: z.ZodArray<z.ZodString, "many">;
            riskFlags: z.ZodArray<z.ZodString, "many">;
            suggestedEntry: z.ZodNullable<z.ZodNumber>;
            suggestedSL: z.ZodNullable<z.ZodNumber>;
            suggestedTarget: z.ZodNullable<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";
            strategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            strikeSelection: {
                rationale: string;
                preferredDelta?: number | null | undefined;
                preferredDTE?: number | null | undefined;
            };
            ivContext: "selling_cheap" | "selling_fair" | "selling_expensive";
            confidence: number;
            reasoning: string;
            keyFactors: string[];
            riskFlags: string[];
            suggestedEntry: number | null;
            suggestedSL: number | null;
            suggestedTarget: number | null;
        }, {
            direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";
            strategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            strikeSelection: {
                rationale: string;
                preferredDelta?: number | null | undefined;
                preferredDTE?: number | null | undefined;
            };
            ivContext: "selling_cheap" | "selling_fair" | "selling_expensive";
            confidence: number;
            reasoning: string;
            keyFactors: string[];
            riskFlags: string[];
            suggestedEntry: number | null;
            suggestedSL: number | null;
            suggestedTarget: number | null;
        }>;
        verifierResult: z.ZodNullable<z.ZodObject<{
            verified: z.ZodBoolean;
            adjustedStrategy: z.ZodEnum<["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD", "HOLD"]>;
            adjustedConfidence: z.ZodNumber;
            auditNotes: z.ZodString;
            overruled: z.ZodBoolean;
            additionalRiskFlags: z.ZodArray<z.ZodString, "many">;
        }, "strip", z.ZodTypeAny, {
            verified: boolean;
            adjustedStrategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            adjustedConfidence: number;
            auditNotes: string;
            overruled: boolean;
            additionalRiskFlags: string[];
        }, {
            verified: boolean;
            adjustedStrategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            adjustedConfidence: number;
            auditNotes: string;
            overruled: boolean;
            additionalRiskFlags: string[];
        }>>;
        riskAction: z.ZodEnum<["SUGGEST", "BLOCK"]>;
        blockReason: z.ZodNullable<z.ZodString>;
        indicators: z.ZodObject<{
            rsi: z.ZodNumber;
            ema20: z.ZodNullable<z.ZodNumber>;
            ema50: z.ZodNullable<z.ZodNumber>;
            atr: z.ZodNullable<z.ZodNumber>;
            volumeRatio: z.ZodNumber;
            regime: z.ZodEnum<["trending", "ranging", "volatile", "INSUFFICIENT_DATA"]>;
            priceVsEma20: z.ZodEnum<["above", "below", "unknown"]>;
            priceVsEma50: z.ZodEnum<["above", "below", "unknown"]>;
            emaAlignment: z.ZodEnum<["bullish", "bearish", "mixed"]>;
            candleCount: z.ZodOptional<z.ZodNumber>;
            rsiSlope: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            candleMomentum: z.ZodOptional<z.ZodEnum<["BULLISH", "BEARISH", "NEUTRAL"]>>;
        }, "strip", z.ZodTypeAny, {
            rsi: number;
            ema20: number | null;
            ema50: number | null;
            atr: number | null;
            volumeRatio: number;
            regime: "trending" | "ranging" | "volatile" | "INSUFFICIENT_DATA";
            priceVsEma20: "unknown" | "above" | "below";
            priceVsEma50: "unknown" | "above" | "below";
            emaAlignment: "bullish" | "bearish" | "mixed";
            candleCount?: number | undefined;
            rsiSlope?: number | null | undefined;
            candleMomentum?: "BULLISH" | "BEARISH" | "NEUTRAL" | undefined;
        }, {
            rsi: number;
            ema20: number | null;
            ema50: number | null;
            atr: number | null;
            volumeRatio: number;
            regime: "trending" | "ranging" | "volatile" | "INSUFFICIENT_DATA";
            priceVsEma20: "unknown" | "above" | "below";
            priceVsEma50: "unknown" | "above" | "below";
            emaAlignment: "bullish" | "bearish" | "mixed";
            candleCount?: number | undefined;
            rsiSlope?: number | null | undefined;
            candleMomentum?: "BULLISH" | "BEARISH" | "NEUTRAL" | undefined;
        }>;
        greeksSnapshot: z.ZodNullable<z.ZodObject<{
            delta: z.ZodNumber;
            gamma: z.ZodNumber;
            theta: z.ZodNumber;
            vega: z.ZodNumber;
            currentIV: z.ZodNumber;
            ivRank: z.ZodNumber;
            ivPercentile: z.ZodNumber;
            ivTrend: z.ZodEnum<["expanding", "contracting", "stable"]>;
            pcr: z.ZodNumber;
            maxPain: z.ZodNumber;
            oiSkew: z.ZodEnum<["calls_heavy", "puts_heavy", "neutral"]>;
            nearWeekIV: z.ZodNumber;
            nextWeekIV: z.ZodNumber;
            expectedMoveUp: z.ZodNumber;
            expectedMoveDown: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            delta: number;
            gamma: number;
            theta: number;
            vega: number;
            currentIV: number;
            ivRank: number;
            ivPercentile: number;
            ivTrend: "expanding" | "contracting" | "stable";
            pcr: number;
            maxPain: number;
            oiSkew: "calls_heavy" | "puts_heavy" | "neutral";
            nearWeekIV: number;
            nextWeekIV: number;
            expectedMoveUp: number;
            expectedMoveDown: number;
        }, {
            delta: number;
            gamma: number;
            theta: number;
            vega: number;
            currentIV: number;
            ivRank: number;
            ivPercentile: number;
            ivTrend: "expanding" | "contracting" | "stable";
            pcr: number;
            maxPain: number;
            oiSkew: "calls_heavy" | "puts_heavy" | "neutral";
            nearWeekIV: number;
            nextWeekIV: number;
            expectedMoveUp: number;
            expectedMoveDown: number;
        }>>;
        expiryContext: z.ZodObject<{
            currentDTE: z.ZodNumber;
            nextExpiryDTE: z.ZodNumber;
            nearestExpiry: z.ZodString;
            isExpiryWeek: z.ZodBoolean;
            isExpiryDay: z.ZodBoolean;
            thetaRisk: z.ZodEnum<["high", "medium", "low"]>;
        }, "strip", z.ZodTypeAny, {
            currentDTE: number;
            nextExpiryDTE: number;
            nearestExpiry: string;
            isExpiryWeek: boolean;
            isExpiryDay: boolean;
            thetaRisk: "high" | "medium" | "low";
        }, {
            currentDTE: number;
            nextExpiryDTE: number;
            nearestExpiry: string;
            isExpiryWeek: boolean;
            isExpiryDay: boolean;
            thetaRisk: "high" | "medium" | "low";
        }>;
        paperPnL: z.ZodNumber;
        openPositions: z.ZodNumber;
        dataMode: z.ZodEnum<["LIVE", "MOCK"]>;
        timestamp: z.ZodNumber;
        /** S/R context — optional, present when SR data is available for the tick */
        srContext: z.ZodOptional<z.ZodUnknown>;
        /** Breakout detection result — optional, present when breakout analysis ran */
        breakoutResult: z.ZodOptional<z.ZodUnknown>;
    }, "strip", z.ZodTypeAny, {
        sessionId: string;
        asset: string;
        dataMode: "LIVE" | "MOCK";
        paperPnL: number;
        ltp: number;
        signal: {
            direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";
            strategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            strikeSelection: {
                rationale: string;
                preferredDelta?: number | null | undefined;
                preferredDTE?: number | null | undefined;
            };
            ivContext: "selling_cheap" | "selling_fair" | "selling_expensive";
            confidence: number;
            reasoning: string;
            keyFactors: string[];
            riskFlags: string[];
            suggestedEntry: number | null;
            suggestedSL: number | null;
            suggestedTarget: number | null;
        };
        verifierResult: {
            verified: boolean;
            adjustedStrategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            adjustedConfidence: number;
            auditNotes: string;
            overruled: boolean;
            additionalRiskFlags: string[];
        } | null;
        riskAction: "SUGGEST" | "BLOCK";
        blockReason: string | null;
        indicators: {
            rsi: number;
            ema20: number | null;
            ema50: number | null;
            atr: number | null;
            volumeRatio: number;
            regime: "trending" | "ranging" | "volatile" | "INSUFFICIENT_DATA";
            priceVsEma20: "unknown" | "above" | "below";
            priceVsEma50: "unknown" | "above" | "below";
            emaAlignment: "bullish" | "bearish" | "mixed";
            candleCount?: number | undefined;
            rsiSlope?: number | null | undefined;
            candleMomentum?: "BULLISH" | "BEARISH" | "NEUTRAL" | undefined;
        };
        greeksSnapshot: {
            delta: number;
            gamma: number;
            theta: number;
            vega: number;
            currentIV: number;
            ivRank: number;
            ivPercentile: number;
            ivTrend: "expanding" | "contracting" | "stable";
            pcr: number;
            maxPain: number;
            oiSkew: "calls_heavy" | "puts_heavy" | "neutral";
            nearWeekIV: number;
            nextWeekIV: number;
            expectedMoveUp: number;
            expectedMoveDown: number;
        } | null;
        expiryContext: {
            currentDTE: number;
            nextExpiryDTE: number;
            nearestExpiry: string;
            isExpiryWeek: boolean;
            isExpiryDay: boolean;
            thetaRisk: "high" | "medium" | "low";
        };
        openPositions: number;
        timestamp: number;
        srContext?: unknown;
        breakoutResult?: unknown;
    }, {
        sessionId: string;
        asset: string;
        dataMode: "LIVE" | "MOCK";
        paperPnL: number;
        ltp: number;
        signal: {
            direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";
            strategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            strikeSelection: {
                rationale: string;
                preferredDelta?: number | null | undefined;
                preferredDTE?: number | null | undefined;
            };
            ivContext: "selling_cheap" | "selling_fair" | "selling_expensive";
            confidence: number;
            reasoning: string;
            keyFactors: string[];
            riskFlags: string[];
            suggestedEntry: number | null;
            suggestedSL: number | null;
            suggestedTarget: number | null;
        };
        verifierResult: {
            verified: boolean;
            adjustedStrategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            adjustedConfidence: number;
            auditNotes: string;
            overruled: boolean;
            additionalRiskFlags: string[];
        } | null;
        riskAction: "SUGGEST" | "BLOCK";
        blockReason: string | null;
        indicators: {
            rsi: number;
            ema20: number | null;
            ema50: number | null;
            atr: number | null;
            volumeRatio: number;
            regime: "trending" | "ranging" | "volatile" | "INSUFFICIENT_DATA";
            priceVsEma20: "unknown" | "above" | "below";
            priceVsEma50: "unknown" | "above" | "below";
            emaAlignment: "bullish" | "bearish" | "mixed";
            candleCount?: number | undefined;
            rsiSlope?: number | null | undefined;
            candleMomentum?: "BULLISH" | "BEARISH" | "NEUTRAL" | undefined;
        };
        greeksSnapshot: {
            delta: number;
            gamma: number;
            theta: number;
            vega: number;
            currentIV: number;
            ivRank: number;
            ivPercentile: number;
            ivTrend: "expanding" | "contracting" | "stable";
            pcr: number;
            maxPain: number;
            oiSkew: "calls_heavy" | "puts_heavy" | "neutral";
            nearWeekIV: number;
            nextWeekIV: number;
            expectedMoveUp: number;
            expectedMoveDown: number;
        } | null;
        expiryContext: {
            currentDTE: number;
            nextExpiryDTE: number;
            nearestExpiry: string;
            isExpiryWeek: boolean;
            isExpiryDay: boolean;
            thetaRisk: "high" | "medium" | "low";
        };
        openPositions: number;
        timestamp: number;
        srContext?: unknown;
        breakoutResult?: unknown;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "SIGNAL";
    payload: {
        sessionId: string;
        asset: string;
        dataMode: "LIVE" | "MOCK";
        paperPnL: number;
        ltp: number;
        signal: {
            direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";
            strategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            strikeSelection: {
                rationale: string;
                preferredDelta?: number | null | undefined;
                preferredDTE?: number | null | undefined;
            };
            ivContext: "selling_cheap" | "selling_fair" | "selling_expensive";
            confidence: number;
            reasoning: string;
            keyFactors: string[];
            riskFlags: string[];
            suggestedEntry: number | null;
            suggestedSL: number | null;
            suggestedTarget: number | null;
        };
        verifierResult: {
            verified: boolean;
            adjustedStrategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            adjustedConfidence: number;
            auditNotes: string;
            overruled: boolean;
            additionalRiskFlags: string[];
        } | null;
        riskAction: "SUGGEST" | "BLOCK";
        blockReason: string | null;
        indicators: {
            rsi: number;
            ema20: number | null;
            ema50: number | null;
            atr: number | null;
            volumeRatio: number;
            regime: "trending" | "ranging" | "volatile" | "INSUFFICIENT_DATA";
            priceVsEma20: "unknown" | "above" | "below";
            priceVsEma50: "unknown" | "above" | "below";
            emaAlignment: "bullish" | "bearish" | "mixed";
            candleCount?: number | undefined;
            rsiSlope?: number | null | undefined;
            candleMomentum?: "BULLISH" | "BEARISH" | "NEUTRAL" | undefined;
        };
        greeksSnapshot: {
            delta: number;
            gamma: number;
            theta: number;
            vega: number;
            currentIV: number;
            ivRank: number;
            ivPercentile: number;
            ivTrend: "expanding" | "contracting" | "stable";
            pcr: number;
            maxPain: number;
            oiSkew: "calls_heavy" | "puts_heavy" | "neutral";
            nearWeekIV: number;
            nextWeekIV: number;
            expectedMoveUp: number;
            expectedMoveDown: number;
        } | null;
        expiryContext: {
            currentDTE: number;
            nextExpiryDTE: number;
            nearestExpiry: string;
            isExpiryWeek: boolean;
            isExpiryDay: boolean;
            thetaRisk: "high" | "medium" | "low";
        };
        openPositions: number;
        timestamp: number;
        srContext?: unknown;
        breakoutResult?: unknown;
    };
}, {
    type: "SIGNAL";
    payload: {
        sessionId: string;
        asset: string;
        dataMode: "LIVE" | "MOCK";
        paperPnL: number;
        ltp: number;
        signal: {
            direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";
            strategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            strikeSelection: {
                rationale: string;
                preferredDelta?: number | null | undefined;
                preferredDTE?: number | null | undefined;
            };
            ivContext: "selling_cheap" | "selling_fair" | "selling_expensive";
            confidence: number;
            reasoning: string;
            keyFactors: string[];
            riskFlags: string[];
            suggestedEntry: number | null;
            suggestedSL: number | null;
            suggestedTarget: number | null;
        };
        verifierResult: {
            verified: boolean;
            adjustedStrategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            adjustedConfidence: number;
            auditNotes: string;
            overruled: boolean;
            additionalRiskFlags: string[];
        } | null;
        riskAction: "SUGGEST" | "BLOCK";
        blockReason: string | null;
        indicators: {
            rsi: number;
            ema20: number | null;
            ema50: number | null;
            atr: number | null;
            volumeRatio: number;
            regime: "trending" | "ranging" | "volatile" | "INSUFFICIENT_DATA";
            priceVsEma20: "unknown" | "above" | "below";
            priceVsEma50: "unknown" | "above" | "below";
            emaAlignment: "bullish" | "bearish" | "mixed";
            candleCount?: number | undefined;
            rsiSlope?: number | null | undefined;
            candleMomentum?: "BULLISH" | "BEARISH" | "NEUTRAL" | undefined;
        };
        greeksSnapshot: {
            delta: number;
            gamma: number;
            theta: number;
            vega: number;
            currentIV: number;
            ivRank: number;
            ivPercentile: number;
            ivTrend: "expanding" | "contracting" | "stable";
            pcr: number;
            maxPain: number;
            oiSkew: "calls_heavy" | "puts_heavy" | "neutral";
            nearWeekIV: number;
            nextWeekIV: number;
            expectedMoveUp: number;
            expectedMoveDown: number;
        } | null;
        expiryContext: {
            currentDTE: number;
            nextExpiryDTE: number;
            nearestExpiry: string;
            isExpiryWeek: boolean;
            isExpiryDay: boolean;
            thetaRisk: "high" | "medium" | "low";
        };
        openPositions: number;
        timestamp: number;
        srContext?: unknown;
        breakoutResult?: unknown;
    };
}>;
export type SignalMessage = z.infer<typeof signalMessageSchema>;
export declare const positionOpenedMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"POSITION_OPENED">;
    payload: z.ZodObject<{
        positionId: z.ZodString;
        sessionId: z.ZodString;
        asset: z.ZodString;
        strategy: z.ZodEnum<["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD"]>;
        legs: z.ZodArray<z.ZodObject<{
            action: z.ZodEnum<["BUY", "SELL"]>;
            type: z.ZodEnum<["CALL", "PUT"]>;
            strike: z.ZodNumber;
            expiry: z.ZodString;
            lotSize: z.ZodNumber;
            lots: z.ZodNumber;
            entryPremium: z.ZodNumber;
            exitPremium: z.ZodNullable<z.ZodNumber>;
            legPnL: z.ZodNullable<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }, {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }>, "many">;
        entrySpot: z.ZodNumber;
        entryDTE: z.ZodNumber;
        entryIVRank: z.ZodNumber;
        entryTimestamp: z.ZodString;
        maxProfit: z.ZodNumber;
        maxLoss: z.ZodNumber;
        breakevenPoint: z.ZodNumber;
        riskRewardRatio: z.ZodNumber;
        status: z.ZodEnum<["OPEN", "CLOSED_SL", "CLOSED_TARGET", "CLOSED_EXPIRY", "CLOSED_MANUAL"]>;
        exitSpot: z.ZodNullable<z.ZodNumber>;
        exitTimestamp: z.ZodNullable<z.ZodString>;
        exitReason: z.ZodNullable<z.ZodEnum<["SL_HIT", "TARGET_HIT", "NEAR_EXPIRY", "EOD_CLOSE", "EOD_FORCED_CLOSE", "TIME_EXIT", "SESSION_STOP", "MANUAL", "DIRECTIONAL_STOP"]>>;
        realizedPnL: z.ZodNullable<z.ZodNumber>;
        entryATR: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        dataMode: z.ZodEnum<["LIVE", "MOCK"]>;
        premiumSource: z.ZodOptional<z.ZodEnum<["KITE_LTP", "BLACK_SCHOLES", "BLACK_SCHOLES_FALLBACK"]>>;
        requiredMargin: z.ZodOptional<z.ZodNumber>;
        marginSource: z.ZodOptional<z.ZodEnum<["KITE_API", "ESTIMATED"]>>;
    }, "strip", z.ZodTypeAny, {
        status: "OPEN" | "CLOSED_SL" | "CLOSED_TARGET" | "CLOSED_EXPIRY" | "CLOSED_MANUAL";
        strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        positionId: string;
        sessionId: string;
        asset: string;
        legs: {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }[];
        entrySpot: number;
        entryDTE: number;
        entryIVRank: number;
        entryTimestamp: string;
        maxProfit: number;
        maxLoss: number;
        breakevenPoint: number;
        riskRewardRatio: number;
        exitSpot: number | null;
        exitTimestamp: string | null;
        exitReason: "SL_HIT" | "TARGET_HIT" | "NEAR_EXPIRY" | "EOD_CLOSE" | "EOD_FORCED_CLOSE" | "TIME_EXIT" | "SESSION_STOP" | "MANUAL" | "DIRECTIONAL_STOP" | null;
        realizedPnL: number | null;
        dataMode: "LIVE" | "MOCK";
        entryATR?: number | null | undefined;
        premiumSource?: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" | undefined;
        requiredMargin?: number | undefined;
        marginSource?: "KITE_API" | "ESTIMATED" | undefined;
    }, {
        status: "OPEN" | "CLOSED_SL" | "CLOSED_TARGET" | "CLOSED_EXPIRY" | "CLOSED_MANUAL";
        strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        positionId: string;
        sessionId: string;
        asset: string;
        legs: {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }[];
        entrySpot: number;
        entryDTE: number;
        entryIVRank: number;
        entryTimestamp: string;
        maxProfit: number;
        maxLoss: number;
        breakevenPoint: number;
        riskRewardRatio: number;
        exitSpot: number | null;
        exitTimestamp: string | null;
        exitReason: "SL_HIT" | "TARGET_HIT" | "NEAR_EXPIRY" | "EOD_CLOSE" | "EOD_FORCED_CLOSE" | "TIME_EXIT" | "SESSION_STOP" | "MANUAL" | "DIRECTIONAL_STOP" | null;
        realizedPnL: number | null;
        dataMode: "LIVE" | "MOCK";
        entryATR?: number | null | undefined;
        premiumSource?: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" | undefined;
        requiredMargin?: number | undefined;
        marginSource?: "KITE_API" | "ESTIMATED" | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "POSITION_OPENED";
    payload: {
        status: "OPEN" | "CLOSED_SL" | "CLOSED_TARGET" | "CLOSED_EXPIRY" | "CLOSED_MANUAL";
        strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        positionId: string;
        sessionId: string;
        asset: string;
        legs: {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }[];
        entrySpot: number;
        entryDTE: number;
        entryIVRank: number;
        entryTimestamp: string;
        maxProfit: number;
        maxLoss: number;
        breakevenPoint: number;
        riskRewardRatio: number;
        exitSpot: number | null;
        exitTimestamp: string | null;
        exitReason: "SL_HIT" | "TARGET_HIT" | "NEAR_EXPIRY" | "EOD_CLOSE" | "EOD_FORCED_CLOSE" | "TIME_EXIT" | "SESSION_STOP" | "MANUAL" | "DIRECTIONAL_STOP" | null;
        realizedPnL: number | null;
        dataMode: "LIVE" | "MOCK";
        entryATR?: number | null | undefined;
        premiumSource?: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" | undefined;
        requiredMargin?: number | undefined;
        marginSource?: "KITE_API" | "ESTIMATED" | undefined;
    };
}, {
    type: "POSITION_OPENED";
    payload: {
        status: "OPEN" | "CLOSED_SL" | "CLOSED_TARGET" | "CLOSED_EXPIRY" | "CLOSED_MANUAL";
        strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        positionId: string;
        sessionId: string;
        asset: string;
        legs: {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }[];
        entrySpot: number;
        entryDTE: number;
        entryIVRank: number;
        entryTimestamp: string;
        maxProfit: number;
        maxLoss: number;
        breakevenPoint: number;
        riskRewardRatio: number;
        exitSpot: number | null;
        exitTimestamp: string | null;
        exitReason: "SL_HIT" | "TARGET_HIT" | "NEAR_EXPIRY" | "EOD_CLOSE" | "EOD_FORCED_CLOSE" | "TIME_EXIT" | "SESSION_STOP" | "MANUAL" | "DIRECTIONAL_STOP" | null;
        realizedPnL: number | null;
        dataMode: "LIVE" | "MOCK";
        entryATR?: number | null | undefined;
        premiumSource?: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" | undefined;
        requiredMargin?: number | undefined;
        marginSource?: "KITE_API" | "ESTIMATED" | undefined;
    };
}>;
export type PositionOpenedMessage = z.infer<typeof positionOpenedMessageSchema>;
export declare const positionClosedMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"POSITION_CLOSED">;
    payload: z.ZodObject<{
        positionId: z.ZodString;
        sessionId: z.ZodString;
        asset: z.ZodString;
        strategy: z.ZodEnum<["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD"]>;
        legs: z.ZodArray<z.ZodObject<{
            action: z.ZodEnum<["BUY", "SELL"]>;
            type: z.ZodEnum<["CALL", "PUT"]>;
            strike: z.ZodNumber;
            expiry: z.ZodString;
            lotSize: z.ZodNumber;
            lots: z.ZodNumber;
            entryPremium: z.ZodNumber;
            exitPremium: z.ZodNullable<z.ZodNumber>;
            legPnL: z.ZodNullable<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }, {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }>, "many">;
        entrySpot: z.ZodNumber;
        entryDTE: z.ZodNumber;
        entryIVRank: z.ZodNumber;
        entryTimestamp: z.ZodString;
        maxProfit: z.ZodNumber;
        maxLoss: z.ZodNumber;
        breakevenPoint: z.ZodNumber;
        riskRewardRatio: z.ZodNumber;
        status: z.ZodEnum<["OPEN", "CLOSED_SL", "CLOSED_TARGET", "CLOSED_EXPIRY", "CLOSED_MANUAL"]>;
        exitSpot: z.ZodNullable<z.ZodNumber>;
        exitTimestamp: z.ZodNullable<z.ZodString>;
        exitReason: z.ZodNullable<z.ZodEnum<["SL_HIT", "TARGET_HIT", "NEAR_EXPIRY", "EOD_CLOSE", "EOD_FORCED_CLOSE", "TIME_EXIT", "SESSION_STOP", "MANUAL", "DIRECTIONAL_STOP"]>>;
        realizedPnL: z.ZodNullable<z.ZodNumber>;
        entryATR: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        dataMode: z.ZodEnum<["LIVE", "MOCK"]>;
        premiumSource: z.ZodOptional<z.ZodEnum<["KITE_LTP", "BLACK_SCHOLES", "BLACK_SCHOLES_FALLBACK"]>>;
        requiredMargin: z.ZodOptional<z.ZodNumber>;
        marginSource: z.ZodOptional<z.ZodEnum<["KITE_API", "ESTIMATED"]>>;
    }, "strip", z.ZodTypeAny, {
        status: "OPEN" | "CLOSED_SL" | "CLOSED_TARGET" | "CLOSED_EXPIRY" | "CLOSED_MANUAL";
        strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        positionId: string;
        sessionId: string;
        asset: string;
        legs: {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }[];
        entrySpot: number;
        entryDTE: number;
        entryIVRank: number;
        entryTimestamp: string;
        maxProfit: number;
        maxLoss: number;
        breakevenPoint: number;
        riskRewardRatio: number;
        exitSpot: number | null;
        exitTimestamp: string | null;
        exitReason: "SL_HIT" | "TARGET_HIT" | "NEAR_EXPIRY" | "EOD_CLOSE" | "EOD_FORCED_CLOSE" | "TIME_EXIT" | "SESSION_STOP" | "MANUAL" | "DIRECTIONAL_STOP" | null;
        realizedPnL: number | null;
        dataMode: "LIVE" | "MOCK";
        entryATR?: number | null | undefined;
        premiumSource?: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" | undefined;
        requiredMargin?: number | undefined;
        marginSource?: "KITE_API" | "ESTIMATED" | undefined;
    }, {
        status: "OPEN" | "CLOSED_SL" | "CLOSED_TARGET" | "CLOSED_EXPIRY" | "CLOSED_MANUAL";
        strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        positionId: string;
        sessionId: string;
        asset: string;
        legs: {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }[];
        entrySpot: number;
        entryDTE: number;
        entryIVRank: number;
        entryTimestamp: string;
        maxProfit: number;
        maxLoss: number;
        breakevenPoint: number;
        riskRewardRatio: number;
        exitSpot: number | null;
        exitTimestamp: string | null;
        exitReason: "SL_HIT" | "TARGET_HIT" | "NEAR_EXPIRY" | "EOD_CLOSE" | "EOD_FORCED_CLOSE" | "TIME_EXIT" | "SESSION_STOP" | "MANUAL" | "DIRECTIONAL_STOP" | null;
        realizedPnL: number | null;
        dataMode: "LIVE" | "MOCK";
        entryATR?: number | null | undefined;
        premiumSource?: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" | undefined;
        requiredMargin?: number | undefined;
        marginSource?: "KITE_API" | "ESTIMATED" | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "POSITION_CLOSED";
    payload: {
        status: "OPEN" | "CLOSED_SL" | "CLOSED_TARGET" | "CLOSED_EXPIRY" | "CLOSED_MANUAL";
        strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        positionId: string;
        sessionId: string;
        asset: string;
        legs: {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }[];
        entrySpot: number;
        entryDTE: number;
        entryIVRank: number;
        entryTimestamp: string;
        maxProfit: number;
        maxLoss: number;
        breakevenPoint: number;
        riskRewardRatio: number;
        exitSpot: number | null;
        exitTimestamp: string | null;
        exitReason: "SL_HIT" | "TARGET_HIT" | "NEAR_EXPIRY" | "EOD_CLOSE" | "EOD_FORCED_CLOSE" | "TIME_EXIT" | "SESSION_STOP" | "MANUAL" | "DIRECTIONAL_STOP" | null;
        realizedPnL: number | null;
        dataMode: "LIVE" | "MOCK";
        entryATR?: number | null | undefined;
        premiumSource?: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" | undefined;
        requiredMargin?: number | undefined;
        marginSource?: "KITE_API" | "ESTIMATED" | undefined;
    };
}, {
    type: "POSITION_CLOSED";
    payload: {
        status: "OPEN" | "CLOSED_SL" | "CLOSED_TARGET" | "CLOSED_EXPIRY" | "CLOSED_MANUAL";
        strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        positionId: string;
        sessionId: string;
        asset: string;
        legs: {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }[];
        entrySpot: number;
        entryDTE: number;
        entryIVRank: number;
        entryTimestamp: string;
        maxProfit: number;
        maxLoss: number;
        breakevenPoint: number;
        riskRewardRatio: number;
        exitSpot: number | null;
        exitTimestamp: string | null;
        exitReason: "SL_HIT" | "TARGET_HIT" | "NEAR_EXPIRY" | "EOD_CLOSE" | "EOD_FORCED_CLOSE" | "TIME_EXIT" | "SESSION_STOP" | "MANUAL" | "DIRECTIONAL_STOP" | null;
        realizedPnL: number | null;
        dataMode: "LIVE" | "MOCK";
        entryATR?: number | null | undefined;
        premiumSource?: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" | undefined;
        requiredMargin?: number | undefined;
        marginSource?: "KITE_API" | "ESTIMATED" | undefined;
    };
}>;
export type PositionClosedMessage = z.infer<typeof positionClosedMessageSchema>;
export declare const positionUpdatePayloadSchema: z.ZodObject<{
    positionId: z.ZodString;
    currentPnL: z.ZodNumber;
    currentLTP: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    positionId: string;
    currentPnL: number;
    currentLTP: number;
}, {
    positionId: string;
    currentPnL: number;
    currentLTP: number;
}>;
export type PositionUpdatePayload = z.infer<typeof positionUpdatePayloadSchema>;
export declare const positionUpdateMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"POSITION_UPDATE">;
    payload: z.ZodObject<{
        positionId: z.ZodString;
        currentPnL: z.ZodNumber;
        currentLTP: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        positionId: string;
        currentPnL: number;
        currentLTP: number;
    }, {
        positionId: string;
        currentPnL: number;
        currentLTP: number;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "POSITION_UPDATE";
    payload: {
        positionId: string;
        currentPnL: number;
        currentLTP: number;
    };
}, {
    type: "POSITION_UPDATE";
    payload: {
        positionId: string;
        currentPnL: number;
        currentLTP: number;
    };
}>;
export type PositionUpdateMessage = z.infer<typeof positionUpdateMessageSchema>;
export declare const sessionStartedPayloadSchema: z.ZodObject<{
    sessionId: z.ZodString;
    asset: z.ZodString;
    paperCapital: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    sessionId: string;
    asset: string;
    paperCapital: number;
}, {
    sessionId: string;
    asset: string;
    paperCapital: number;
}>;
export type SessionStartedPayload = z.infer<typeof sessionStartedPayloadSchema>;
export declare const sessionStartedMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"SESSION_STARTED">;
    payload: z.ZodObject<{
        sessionId: z.ZodString;
        asset: z.ZodString;
        paperCapital: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        sessionId: string;
        asset: string;
        paperCapital: number;
    }, {
        sessionId: string;
        asset: string;
        paperCapital: number;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "SESSION_STARTED";
    payload: {
        sessionId: string;
        asset: string;
        paperCapital: number;
    };
}, {
    type: "SESSION_STARTED";
    payload: {
        sessionId: string;
        asset: string;
        paperCapital: number;
    };
}>;
export type SessionStartedMessage = z.infer<typeof sessionStartedMessageSchema>;
export declare const sessionStoppedPayloadSchema: z.ZodObject<{
    sessionId: z.ZodString;
    finalPnL: z.ZodNumber;
    totalTrades: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    sessionId: string;
    totalTrades: number;
    finalPnL: number;
}, {
    sessionId: string;
    totalTrades: number;
    finalPnL: number;
}>;
export type SessionStoppedPayload = z.infer<typeof sessionStoppedPayloadSchema>;
export declare const sessionStoppedMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"SESSION_STOPPED">;
    payload: z.ZodObject<{
        sessionId: z.ZodString;
        finalPnL: z.ZodNumber;
        totalTrades: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        sessionId: string;
        totalTrades: number;
        finalPnL: number;
    }, {
        sessionId: string;
        totalTrades: number;
        finalPnL: number;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "SESSION_STOPPED";
    payload: {
        sessionId: string;
        totalTrades: number;
        finalPnL: number;
    };
}, {
    type: "SESSION_STOPPED";
    payload: {
        sessionId: string;
        totalTrades: number;
        finalPnL: number;
    };
}>;
export type SessionStoppedMessage = z.infer<typeof sessionStoppedMessageSchema>;
export declare const tickSkippedMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"TICK_SKIPPED">;
    reason: z.ZodString;
    timestamp: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    type: "TICK_SKIPPED";
    timestamp: number;
    reason: string;
}, {
    type: "TICK_SKIPPED";
    timestamp: number;
    reason: string;
}>;
export type TickSkippedMessage = z.infer<typeof tickSkippedMessageSchema>;
export declare const tickErrorMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"TICK_ERROR">;
    error: z.ZodString;
    timestamp: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    type: "TICK_ERROR";
    timestamp: number;
    error: string;
}, {
    type: "TICK_ERROR";
    timestamp: number;
    error: string;
}>;
export type TickErrorMessage = z.infer<typeof tickErrorMessageSchema>;
export declare const heartbeatMessageSchema: z.ZodObject<{
    type: z.ZodLiteral<"HEARTBEAT">;
    timestamp: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    type: "HEARTBEAT";
    timestamp: number;
}, {
    type: "HEARTBEAT";
    timestamp: number;
}>;
export type HeartbeatMessage = z.infer<typeof heartbeatMessageSchema>;
/**
 * Discriminated union Zod schema for all supported WebSocket messages.
 * This is the single source of truth for real-time protocol validation.
 */
export declare const wsMessageSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"SIGNAL">;
    payload: z.ZodObject<{
        sessionId: z.ZodString;
        asset: z.ZodString;
        ltp: z.ZodNumber;
        signal: z.ZodObject<{
            direction: z.ZodEnum<["BULLISH", "BEARISH", "NEUTRAL", "HOLD"]>;
            strategy: z.ZodEnum<["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD", "HOLD"]>;
            strikeSelection: z.ZodObject<{
                rationale: z.ZodString;
                preferredDelta: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
                preferredDTE: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            }, "strip", z.ZodTypeAny, {
                rationale: string;
                preferredDelta?: number | null | undefined;
                preferredDTE?: number | null | undefined;
            }, {
                rationale: string;
                preferredDelta?: number | null | undefined;
                preferredDTE?: number | null | undefined;
            }>;
            ivContext: z.ZodEnum<["selling_cheap", "selling_fair", "selling_expensive"]>;
            confidence: z.ZodNumber;
            reasoning: z.ZodString;
            keyFactors: z.ZodArray<z.ZodString, "many">;
            riskFlags: z.ZodArray<z.ZodString, "many">;
            suggestedEntry: z.ZodNullable<z.ZodNumber>;
            suggestedSL: z.ZodNullable<z.ZodNumber>;
            suggestedTarget: z.ZodNullable<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";
            strategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            strikeSelection: {
                rationale: string;
                preferredDelta?: number | null | undefined;
                preferredDTE?: number | null | undefined;
            };
            ivContext: "selling_cheap" | "selling_fair" | "selling_expensive";
            confidence: number;
            reasoning: string;
            keyFactors: string[];
            riskFlags: string[];
            suggestedEntry: number | null;
            suggestedSL: number | null;
            suggestedTarget: number | null;
        }, {
            direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";
            strategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            strikeSelection: {
                rationale: string;
                preferredDelta?: number | null | undefined;
                preferredDTE?: number | null | undefined;
            };
            ivContext: "selling_cheap" | "selling_fair" | "selling_expensive";
            confidence: number;
            reasoning: string;
            keyFactors: string[];
            riskFlags: string[];
            suggestedEntry: number | null;
            suggestedSL: number | null;
            suggestedTarget: number | null;
        }>;
        verifierResult: z.ZodNullable<z.ZodObject<{
            verified: z.ZodBoolean;
            adjustedStrategy: z.ZodEnum<["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD", "HOLD"]>;
            adjustedConfidence: z.ZodNumber;
            auditNotes: z.ZodString;
            overruled: z.ZodBoolean;
            additionalRiskFlags: z.ZodArray<z.ZodString, "many">;
        }, "strip", z.ZodTypeAny, {
            verified: boolean;
            adjustedStrategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            adjustedConfidence: number;
            auditNotes: string;
            overruled: boolean;
            additionalRiskFlags: string[];
        }, {
            verified: boolean;
            adjustedStrategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            adjustedConfidence: number;
            auditNotes: string;
            overruled: boolean;
            additionalRiskFlags: string[];
        }>>;
        riskAction: z.ZodEnum<["SUGGEST", "BLOCK"]>;
        blockReason: z.ZodNullable<z.ZodString>;
        indicators: z.ZodObject<{
            rsi: z.ZodNumber;
            ema20: z.ZodNullable<z.ZodNumber>;
            ema50: z.ZodNullable<z.ZodNumber>;
            atr: z.ZodNullable<z.ZodNumber>;
            volumeRatio: z.ZodNumber;
            regime: z.ZodEnum<["trending", "ranging", "volatile", "INSUFFICIENT_DATA"]>;
            priceVsEma20: z.ZodEnum<["above", "below", "unknown"]>;
            priceVsEma50: z.ZodEnum<["above", "below", "unknown"]>;
            emaAlignment: z.ZodEnum<["bullish", "bearish", "mixed"]>;
            candleCount: z.ZodOptional<z.ZodNumber>;
            rsiSlope: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            candleMomentum: z.ZodOptional<z.ZodEnum<["BULLISH", "BEARISH", "NEUTRAL"]>>;
        }, "strip", z.ZodTypeAny, {
            rsi: number;
            ema20: number | null;
            ema50: number | null;
            atr: number | null;
            volumeRatio: number;
            regime: "trending" | "ranging" | "volatile" | "INSUFFICIENT_DATA";
            priceVsEma20: "unknown" | "above" | "below";
            priceVsEma50: "unknown" | "above" | "below";
            emaAlignment: "bullish" | "bearish" | "mixed";
            candleCount?: number | undefined;
            rsiSlope?: number | null | undefined;
            candleMomentum?: "BULLISH" | "BEARISH" | "NEUTRAL" | undefined;
        }, {
            rsi: number;
            ema20: number | null;
            ema50: number | null;
            atr: number | null;
            volumeRatio: number;
            regime: "trending" | "ranging" | "volatile" | "INSUFFICIENT_DATA";
            priceVsEma20: "unknown" | "above" | "below";
            priceVsEma50: "unknown" | "above" | "below";
            emaAlignment: "bullish" | "bearish" | "mixed";
            candleCount?: number | undefined;
            rsiSlope?: number | null | undefined;
            candleMomentum?: "BULLISH" | "BEARISH" | "NEUTRAL" | undefined;
        }>;
        greeksSnapshot: z.ZodNullable<z.ZodObject<{
            delta: z.ZodNumber;
            gamma: z.ZodNumber;
            theta: z.ZodNumber;
            vega: z.ZodNumber;
            currentIV: z.ZodNumber;
            ivRank: z.ZodNumber;
            ivPercentile: z.ZodNumber;
            ivTrend: z.ZodEnum<["expanding", "contracting", "stable"]>;
            pcr: z.ZodNumber;
            maxPain: z.ZodNumber;
            oiSkew: z.ZodEnum<["calls_heavy", "puts_heavy", "neutral"]>;
            nearWeekIV: z.ZodNumber;
            nextWeekIV: z.ZodNumber;
            expectedMoveUp: z.ZodNumber;
            expectedMoveDown: z.ZodNumber;
        }, "strip", z.ZodTypeAny, {
            delta: number;
            gamma: number;
            theta: number;
            vega: number;
            currentIV: number;
            ivRank: number;
            ivPercentile: number;
            ivTrend: "expanding" | "contracting" | "stable";
            pcr: number;
            maxPain: number;
            oiSkew: "calls_heavy" | "puts_heavy" | "neutral";
            nearWeekIV: number;
            nextWeekIV: number;
            expectedMoveUp: number;
            expectedMoveDown: number;
        }, {
            delta: number;
            gamma: number;
            theta: number;
            vega: number;
            currentIV: number;
            ivRank: number;
            ivPercentile: number;
            ivTrend: "expanding" | "contracting" | "stable";
            pcr: number;
            maxPain: number;
            oiSkew: "calls_heavy" | "puts_heavy" | "neutral";
            nearWeekIV: number;
            nextWeekIV: number;
            expectedMoveUp: number;
            expectedMoveDown: number;
        }>>;
        expiryContext: z.ZodObject<{
            currentDTE: z.ZodNumber;
            nextExpiryDTE: z.ZodNumber;
            nearestExpiry: z.ZodString;
            isExpiryWeek: z.ZodBoolean;
            isExpiryDay: z.ZodBoolean;
            thetaRisk: z.ZodEnum<["high", "medium", "low"]>;
        }, "strip", z.ZodTypeAny, {
            currentDTE: number;
            nextExpiryDTE: number;
            nearestExpiry: string;
            isExpiryWeek: boolean;
            isExpiryDay: boolean;
            thetaRisk: "high" | "medium" | "low";
        }, {
            currentDTE: number;
            nextExpiryDTE: number;
            nearestExpiry: string;
            isExpiryWeek: boolean;
            isExpiryDay: boolean;
            thetaRisk: "high" | "medium" | "low";
        }>;
        paperPnL: z.ZodNumber;
        openPositions: z.ZodNumber;
        dataMode: z.ZodEnum<["LIVE", "MOCK"]>;
        timestamp: z.ZodNumber;
        /** S/R context — optional, present when SR data is available for the tick */
        srContext: z.ZodOptional<z.ZodUnknown>;
        /** Breakout detection result — optional, present when breakout analysis ran */
        breakoutResult: z.ZodOptional<z.ZodUnknown>;
    }, "strip", z.ZodTypeAny, {
        sessionId: string;
        asset: string;
        dataMode: "LIVE" | "MOCK";
        paperPnL: number;
        ltp: number;
        signal: {
            direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";
            strategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            strikeSelection: {
                rationale: string;
                preferredDelta?: number | null | undefined;
                preferredDTE?: number | null | undefined;
            };
            ivContext: "selling_cheap" | "selling_fair" | "selling_expensive";
            confidence: number;
            reasoning: string;
            keyFactors: string[];
            riskFlags: string[];
            suggestedEntry: number | null;
            suggestedSL: number | null;
            suggestedTarget: number | null;
        };
        verifierResult: {
            verified: boolean;
            adjustedStrategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            adjustedConfidence: number;
            auditNotes: string;
            overruled: boolean;
            additionalRiskFlags: string[];
        } | null;
        riskAction: "SUGGEST" | "BLOCK";
        blockReason: string | null;
        indicators: {
            rsi: number;
            ema20: number | null;
            ema50: number | null;
            atr: number | null;
            volumeRatio: number;
            regime: "trending" | "ranging" | "volatile" | "INSUFFICIENT_DATA";
            priceVsEma20: "unknown" | "above" | "below";
            priceVsEma50: "unknown" | "above" | "below";
            emaAlignment: "bullish" | "bearish" | "mixed";
            candleCount?: number | undefined;
            rsiSlope?: number | null | undefined;
            candleMomentum?: "BULLISH" | "BEARISH" | "NEUTRAL" | undefined;
        };
        greeksSnapshot: {
            delta: number;
            gamma: number;
            theta: number;
            vega: number;
            currentIV: number;
            ivRank: number;
            ivPercentile: number;
            ivTrend: "expanding" | "contracting" | "stable";
            pcr: number;
            maxPain: number;
            oiSkew: "calls_heavy" | "puts_heavy" | "neutral";
            nearWeekIV: number;
            nextWeekIV: number;
            expectedMoveUp: number;
            expectedMoveDown: number;
        } | null;
        expiryContext: {
            currentDTE: number;
            nextExpiryDTE: number;
            nearestExpiry: string;
            isExpiryWeek: boolean;
            isExpiryDay: boolean;
            thetaRisk: "high" | "medium" | "low";
        };
        openPositions: number;
        timestamp: number;
        srContext?: unknown;
        breakoutResult?: unknown;
    }, {
        sessionId: string;
        asset: string;
        dataMode: "LIVE" | "MOCK";
        paperPnL: number;
        ltp: number;
        signal: {
            direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";
            strategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            strikeSelection: {
                rationale: string;
                preferredDelta?: number | null | undefined;
                preferredDTE?: number | null | undefined;
            };
            ivContext: "selling_cheap" | "selling_fair" | "selling_expensive";
            confidence: number;
            reasoning: string;
            keyFactors: string[];
            riskFlags: string[];
            suggestedEntry: number | null;
            suggestedSL: number | null;
            suggestedTarget: number | null;
        };
        verifierResult: {
            verified: boolean;
            adjustedStrategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            adjustedConfidence: number;
            auditNotes: string;
            overruled: boolean;
            additionalRiskFlags: string[];
        } | null;
        riskAction: "SUGGEST" | "BLOCK";
        blockReason: string | null;
        indicators: {
            rsi: number;
            ema20: number | null;
            ema50: number | null;
            atr: number | null;
            volumeRatio: number;
            regime: "trending" | "ranging" | "volatile" | "INSUFFICIENT_DATA";
            priceVsEma20: "unknown" | "above" | "below";
            priceVsEma50: "unknown" | "above" | "below";
            emaAlignment: "bullish" | "bearish" | "mixed";
            candleCount?: number | undefined;
            rsiSlope?: number | null | undefined;
            candleMomentum?: "BULLISH" | "BEARISH" | "NEUTRAL" | undefined;
        };
        greeksSnapshot: {
            delta: number;
            gamma: number;
            theta: number;
            vega: number;
            currentIV: number;
            ivRank: number;
            ivPercentile: number;
            ivTrend: "expanding" | "contracting" | "stable";
            pcr: number;
            maxPain: number;
            oiSkew: "calls_heavy" | "puts_heavy" | "neutral";
            nearWeekIV: number;
            nextWeekIV: number;
            expectedMoveUp: number;
            expectedMoveDown: number;
        } | null;
        expiryContext: {
            currentDTE: number;
            nextExpiryDTE: number;
            nearestExpiry: string;
            isExpiryWeek: boolean;
            isExpiryDay: boolean;
            thetaRisk: "high" | "medium" | "low";
        };
        openPositions: number;
        timestamp: number;
        srContext?: unknown;
        breakoutResult?: unknown;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "SIGNAL";
    payload: {
        sessionId: string;
        asset: string;
        dataMode: "LIVE" | "MOCK";
        paperPnL: number;
        ltp: number;
        signal: {
            direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";
            strategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            strikeSelection: {
                rationale: string;
                preferredDelta?: number | null | undefined;
                preferredDTE?: number | null | undefined;
            };
            ivContext: "selling_cheap" | "selling_fair" | "selling_expensive";
            confidence: number;
            reasoning: string;
            keyFactors: string[];
            riskFlags: string[];
            suggestedEntry: number | null;
            suggestedSL: number | null;
            suggestedTarget: number | null;
        };
        verifierResult: {
            verified: boolean;
            adjustedStrategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            adjustedConfidence: number;
            auditNotes: string;
            overruled: boolean;
            additionalRiskFlags: string[];
        } | null;
        riskAction: "SUGGEST" | "BLOCK";
        blockReason: string | null;
        indicators: {
            rsi: number;
            ema20: number | null;
            ema50: number | null;
            atr: number | null;
            volumeRatio: number;
            regime: "trending" | "ranging" | "volatile" | "INSUFFICIENT_DATA";
            priceVsEma20: "unknown" | "above" | "below";
            priceVsEma50: "unknown" | "above" | "below";
            emaAlignment: "bullish" | "bearish" | "mixed";
            candleCount?: number | undefined;
            rsiSlope?: number | null | undefined;
            candleMomentum?: "BULLISH" | "BEARISH" | "NEUTRAL" | undefined;
        };
        greeksSnapshot: {
            delta: number;
            gamma: number;
            theta: number;
            vega: number;
            currentIV: number;
            ivRank: number;
            ivPercentile: number;
            ivTrend: "expanding" | "contracting" | "stable";
            pcr: number;
            maxPain: number;
            oiSkew: "calls_heavy" | "puts_heavy" | "neutral";
            nearWeekIV: number;
            nextWeekIV: number;
            expectedMoveUp: number;
            expectedMoveDown: number;
        } | null;
        expiryContext: {
            currentDTE: number;
            nextExpiryDTE: number;
            nearestExpiry: string;
            isExpiryWeek: boolean;
            isExpiryDay: boolean;
            thetaRisk: "high" | "medium" | "low";
        };
        openPositions: number;
        timestamp: number;
        srContext?: unknown;
        breakoutResult?: unknown;
    };
}, {
    type: "SIGNAL";
    payload: {
        sessionId: string;
        asset: string;
        dataMode: "LIVE" | "MOCK";
        paperPnL: number;
        ltp: number;
        signal: {
            direction: "BULLISH" | "BEARISH" | "NEUTRAL" | "HOLD";
            strategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            strikeSelection: {
                rationale: string;
                preferredDelta?: number | null | undefined;
                preferredDTE?: number | null | undefined;
            };
            ivContext: "selling_cheap" | "selling_fair" | "selling_expensive";
            confidence: number;
            reasoning: string;
            keyFactors: string[];
            riskFlags: string[];
            suggestedEntry: number | null;
            suggestedSL: number | null;
            suggestedTarget: number | null;
        };
        verifierResult: {
            verified: boolean;
            adjustedStrategy: "HOLD" | "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
            adjustedConfidence: number;
            auditNotes: string;
            overruled: boolean;
            additionalRiskFlags: string[];
        } | null;
        riskAction: "SUGGEST" | "BLOCK";
        blockReason: string | null;
        indicators: {
            rsi: number;
            ema20: number | null;
            ema50: number | null;
            atr: number | null;
            volumeRatio: number;
            regime: "trending" | "ranging" | "volatile" | "INSUFFICIENT_DATA";
            priceVsEma20: "unknown" | "above" | "below";
            priceVsEma50: "unknown" | "above" | "below";
            emaAlignment: "bullish" | "bearish" | "mixed";
            candleCount?: number | undefined;
            rsiSlope?: number | null | undefined;
            candleMomentum?: "BULLISH" | "BEARISH" | "NEUTRAL" | undefined;
        };
        greeksSnapshot: {
            delta: number;
            gamma: number;
            theta: number;
            vega: number;
            currentIV: number;
            ivRank: number;
            ivPercentile: number;
            ivTrend: "expanding" | "contracting" | "stable";
            pcr: number;
            maxPain: number;
            oiSkew: "calls_heavy" | "puts_heavy" | "neutral";
            nearWeekIV: number;
            nextWeekIV: number;
            expectedMoveUp: number;
            expectedMoveDown: number;
        } | null;
        expiryContext: {
            currentDTE: number;
            nextExpiryDTE: number;
            nearestExpiry: string;
            isExpiryWeek: boolean;
            isExpiryDay: boolean;
            thetaRisk: "high" | "medium" | "low";
        };
        openPositions: number;
        timestamp: number;
        srContext?: unknown;
        breakoutResult?: unknown;
    };
}>, z.ZodObject<{
    type: z.ZodLiteral<"POSITION_OPENED">;
    payload: z.ZodObject<{
        positionId: z.ZodString;
        sessionId: z.ZodString;
        asset: z.ZodString;
        strategy: z.ZodEnum<["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD"]>;
        legs: z.ZodArray<z.ZodObject<{
            action: z.ZodEnum<["BUY", "SELL"]>;
            type: z.ZodEnum<["CALL", "PUT"]>;
            strike: z.ZodNumber;
            expiry: z.ZodString;
            lotSize: z.ZodNumber;
            lots: z.ZodNumber;
            entryPremium: z.ZodNumber;
            exitPremium: z.ZodNullable<z.ZodNumber>;
            legPnL: z.ZodNullable<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }, {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }>, "many">;
        entrySpot: z.ZodNumber;
        entryDTE: z.ZodNumber;
        entryIVRank: z.ZodNumber;
        entryTimestamp: z.ZodString;
        maxProfit: z.ZodNumber;
        maxLoss: z.ZodNumber;
        breakevenPoint: z.ZodNumber;
        riskRewardRatio: z.ZodNumber;
        status: z.ZodEnum<["OPEN", "CLOSED_SL", "CLOSED_TARGET", "CLOSED_EXPIRY", "CLOSED_MANUAL"]>;
        exitSpot: z.ZodNullable<z.ZodNumber>;
        exitTimestamp: z.ZodNullable<z.ZodString>;
        exitReason: z.ZodNullable<z.ZodEnum<["SL_HIT", "TARGET_HIT", "NEAR_EXPIRY", "EOD_CLOSE", "EOD_FORCED_CLOSE", "TIME_EXIT", "SESSION_STOP", "MANUAL", "DIRECTIONAL_STOP"]>>;
        realizedPnL: z.ZodNullable<z.ZodNumber>;
        entryATR: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        dataMode: z.ZodEnum<["LIVE", "MOCK"]>;
        premiumSource: z.ZodOptional<z.ZodEnum<["KITE_LTP", "BLACK_SCHOLES", "BLACK_SCHOLES_FALLBACK"]>>;
        requiredMargin: z.ZodOptional<z.ZodNumber>;
        marginSource: z.ZodOptional<z.ZodEnum<["KITE_API", "ESTIMATED"]>>;
    }, "strip", z.ZodTypeAny, {
        status: "OPEN" | "CLOSED_SL" | "CLOSED_TARGET" | "CLOSED_EXPIRY" | "CLOSED_MANUAL";
        strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        positionId: string;
        sessionId: string;
        asset: string;
        legs: {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }[];
        entrySpot: number;
        entryDTE: number;
        entryIVRank: number;
        entryTimestamp: string;
        maxProfit: number;
        maxLoss: number;
        breakevenPoint: number;
        riskRewardRatio: number;
        exitSpot: number | null;
        exitTimestamp: string | null;
        exitReason: "SL_HIT" | "TARGET_HIT" | "NEAR_EXPIRY" | "EOD_CLOSE" | "EOD_FORCED_CLOSE" | "TIME_EXIT" | "SESSION_STOP" | "MANUAL" | "DIRECTIONAL_STOP" | null;
        realizedPnL: number | null;
        dataMode: "LIVE" | "MOCK";
        entryATR?: number | null | undefined;
        premiumSource?: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" | undefined;
        requiredMargin?: number | undefined;
        marginSource?: "KITE_API" | "ESTIMATED" | undefined;
    }, {
        status: "OPEN" | "CLOSED_SL" | "CLOSED_TARGET" | "CLOSED_EXPIRY" | "CLOSED_MANUAL";
        strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        positionId: string;
        sessionId: string;
        asset: string;
        legs: {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }[];
        entrySpot: number;
        entryDTE: number;
        entryIVRank: number;
        entryTimestamp: string;
        maxProfit: number;
        maxLoss: number;
        breakevenPoint: number;
        riskRewardRatio: number;
        exitSpot: number | null;
        exitTimestamp: string | null;
        exitReason: "SL_HIT" | "TARGET_HIT" | "NEAR_EXPIRY" | "EOD_CLOSE" | "EOD_FORCED_CLOSE" | "TIME_EXIT" | "SESSION_STOP" | "MANUAL" | "DIRECTIONAL_STOP" | null;
        realizedPnL: number | null;
        dataMode: "LIVE" | "MOCK";
        entryATR?: number | null | undefined;
        premiumSource?: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" | undefined;
        requiredMargin?: number | undefined;
        marginSource?: "KITE_API" | "ESTIMATED" | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "POSITION_OPENED";
    payload: {
        status: "OPEN" | "CLOSED_SL" | "CLOSED_TARGET" | "CLOSED_EXPIRY" | "CLOSED_MANUAL";
        strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        positionId: string;
        sessionId: string;
        asset: string;
        legs: {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }[];
        entrySpot: number;
        entryDTE: number;
        entryIVRank: number;
        entryTimestamp: string;
        maxProfit: number;
        maxLoss: number;
        breakevenPoint: number;
        riskRewardRatio: number;
        exitSpot: number | null;
        exitTimestamp: string | null;
        exitReason: "SL_HIT" | "TARGET_HIT" | "NEAR_EXPIRY" | "EOD_CLOSE" | "EOD_FORCED_CLOSE" | "TIME_EXIT" | "SESSION_STOP" | "MANUAL" | "DIRECTIONAL_STOP" | null;
        realizedPnL: number | null;
        dataMode: "LIVE" | "MOCK";
        entryATR?: number | null | undefined;
        premiumSource?: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" | undefined;
        requiredMargin?: number | undefined;
        marginSource?: "KITE_API" | "ESTIMATED" | undefined;
    };
}, {
    type: "POSITION_OPENED";
    payload: {
        status: "OPEN" | "CLOSED_SL" | "CLOSED_TARGET" | "CLOSED_EXPIRY" | "CLOSED_MANUAL";
        strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        positionId: string;
        sessionId: string;
        asset: string;
        legs: {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }[];
        entrySpot: number;
        entryDTE: number;
        entryIVRank: number;
        entryTimestamp: string;
        maxProfit: number;
        maxLoss: number;
        breakevenPoint: number;
        riskRewardRatio: number;
        exitSpot: number | null;
        exitTimestamp: string | null;
        exitReason: "SL_HIT" | "TARGET_HIT" | "NEAR_EXPIRY" | "EOD_CLOSE" | "EOD_FORCED_CLOSE" | "TIME_EXIT" | "SESSION_STOP" | "MANUAL" | "DIRECTIONAL_STOP" | null;
        realizedPnL: number | null;
        dataMode: "LIVE" | "MOCK";
        entryATR?: number | null | undefined;
        premiumSource?: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" | undefined;
        requiredMargin?: number | undefined;
        marginSource?: "KITE_API" | "ESTIMATED" | undefined;
    };
}>, z.ZodObject<{
    type: z.ZodLiteral<"POSITION_CLOSED">;
    payload: z.ZodObject<{
        positionId: z.ZodString;
        sessionId: z.ZodString;
        asset: z.ZodString;
        strategy: z.ZodEnum<["BULL_PUT_SPREAD", "BEAR_CALL_SPREAD"]>;
        legs: z.ZodArray<z.ZodObject<{
            action: z.ZodEnum<["BUY", "SELL"]>;
            type: z.ZodEnum<["CALL", "PUT"]>;
            strike: z.ZodNumber;
            expiry: z.ZodString;
            lotSize: z.ZodNumber;
            lots: z.ZodNumber;
            entryPremium: z.ZodNumber;
            exitPremium: z.ZodNullable<z.ZodNumber>;
            legPnL: z.ZodNullable<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }, {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }>, "many">;
        entrySpot: z.ZodNumber;
        entryDTE: z.ZodNumber;
        entryIVRank: z.ZodNumber;
        entryTimestamp: z.ZodString;
        maxProfit: z.ZodNumber;
        maxLoss: z.ZodNumber;
        breakevenPoint: z.ZodNumber;
        riskRewardRatio: z.ZodNumber;
        status: z.ZodEnum<["OPEN", "CLOSED_SL", "CLOSED_TARGET", "CLOSED_EXPIRY", "CLOSED_MANUAL"]>;
        exitSpot: z.ZodNullable<z.ZodNumber>;
        exitTimestamp: z.ZodNullable<z.ZodString>;
        exitReason: z.ZodNullable<z.ZodEnum<["SL_HIT", "TARGET_HIT", "NEAR_EXPIRY", "EOD_CLOSE", "EOD_FORCED_CLOSE", "TIME_EXIT", "SESSION_STOP", "MANUAL", "DIRECTIONAL_STOP"]>>;
        realizedPnL: z.ZodNullable<z.ZodNumber>;
        entryATR: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
        dataMode: z.ZodEnum<["LIVE", "MOCK"]>;
        premiumSource: z.ZodOptional<z.ZodEnum<["KITE_LTP", "BLACK_SCHOLES", "BLACK_SCHOLES_FALLBACK"]>>;
        requiredMargin: z.ZodOptional<z.ZodNumber>;
        marginSource: z.ZodOptional<z.ZodEnum<["KITE_API", "ESTIMATED"]>>;
    }, "strip", z.ZodTypeAny, {
        status: "OPEN" | "CLOSED_SL" | "CLOSED_TARGET" | "CLOSED_EXPIRY" | "CLOSED_MANUAL";
        strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        positionId: string;
        sessionId: string;
        asset: string;
        legs: {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }[];
        entrySpot: number;
        entryDTE: number;
        entryIVRank: number;
        entryTimestamp: string;
        maxProfit: number;
        maxLoss: number;
        breakevenPoint: number;
        riskRewardRatio: number;
        exitSpot: number | null;
        exitTimestamp: string | null;
        exitReason: "SL_HIT" | "TARGET_HIT" | "NEAR_EXPIRY" | "EOD_CLOSE" | "EOD_FORCED_CLOSE" | "TIME_EXIT" | "SESSION_STOP" | "MANUAL" | "DIRECTIONAL_STOP" | null;
        realizedPnL: number | null;
        dataMode: "LIVE" | "MOCK";
        entryATR?: number | null | undefined;
        premiumSource?: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" | undefined;
        requiredMargin?: number | undefined;
        marginSource?: "KITE_API" | "ESTIMATED" | undefined;
    }, {
        status: "OPEN" | "CLOSED_SL" | "CLOSED_TARGET" | "CLOSED_EXPIRY" | "CLOSED_MANUAL";
        strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        positionId: string;
        sessionId: string;
        asset: string;
        legs: {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }[];
        entrySpot: number;
        entryDTE: number;
        entryIVRank: number;
        entryTimestamp: string;
        maxProfit: number;
        maxLoss: number;
        breakevenPoint: number;
        riskRewardRatio: number;
        exitSpot: number | null;
        exitTimestamp: string | null;
        exitReason: "SL_HIT" | "TARGET_HIT" | "NEAR_EXPIRY" | "EOD_CLOSE" | "EOD_FORCED_CLOSE" | "TIME_EXIT" | "SESSION_STOP" | "MANUAL" | "DIRECTIONAL_STOP" | null;
        realizedPnL: number | null;
        dataMode: "LIVE" | "MOCK";
        entryATR?: number | null | undefined;
        premiumSource?: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" | undefined;
        requiredMargin?: number | undefined;
        marginSource?: "KITE_API" | "ESTIMATED" | undefined;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "POSITION_CLOSED";
    payload: {
        status: "OPEN" | "CLOSED_SL" | "CLOSED_TARGET" | "CLOSED_EXPIRY" | "CLOSED_MANUAL";
        strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        positionId: string;
        sessionId: string;
        asset: string;
        legs: {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }[];
        entrySpot: number;
        entryDTE: number;
        entryIVRank: number;
        entryTimestamp: string;
        maxProfit: number;
        maxLoss: number;
        breakevenPoint: number;
        riskRewardRatio: number;
        exitSpot: number | null;
        exitTimestamp: string | null;
        exitReason: "SL_HIT" | "TARGET_HIT" | "NEAR_EXPIRY" | "EOD_CLOSE" | "EOD_FORCED_CLOSE" | "TIME_EXIT" | "SESSION_STOP" | "MANUAL" | "DIRECTIONAL_STOP" | null;
        realizedPnL: number | null;
        dataMode: "LIVE" | "MOCK";
        entryATR?: number | null | undefined;
        premiumSource?: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" | undefined;
        requiredMargin?: number | undefined;
        marginSource?: "KITE_API" | "ESTIMATED" | undefined;
    };
}, {
    type: "POSITION_CLOSED";
    payload: {
        status: "OPEN" | "CLOSED_SL" | "CLOSED_TARGET" | "CLOSED_EXPIRY" | "CLOSED_MANUAL";
        strategy: "BULL_PUT_SPREAD" | "BEAR_CALL_SPREAD";
        positionId: string;
        sessionId: string;
        asset: string;
        legs: {
            type: "CALL" | "PUT";
            action: "BUY" | "SELL";
            strike: number;
            expiry: string;
            lotSize: number;
            lots: number;
            entryPremium: number;
            exitPremium: number | null;
            legPnL: number | null;
        }[];
        entrySpot: number;
        entryDTE: number;
        entryIVRank: number;
        entryTimestamp: string;
        maxProfit: number;
        maxLoss: number;
        breakevenPoint: number;
        riskRewardRatio: number;
        exitSpot: number | null;
        exitTimestamp: string | null;
        exitReason: "SL_HIT" | "TARGET_HIT" | "NEAR_EXPIRY" | "EOD_CLOSE" | "EOD_FORCED_CLOSE" | "TIME_EXIT" | "SESSION_STOP" | "MANUAL" | "DIRECTIONAL_STOP" | null;
        realizedPnL: number | null;
        dataMode: "LIVE" | "MOCK";
        entryATR?: number | null | undefined;
        premiumSource?: "KITE_LTP" | "BLACK_SCHOLES" | "BLACK_SCHOLES_FALLBACK" | undefined;
        requiredMargin?: number | undefined;
        marginSource?: "KITE_API" | "ESTIMATED" | undefined;
    };
}>, z.ZodObject<{
    type: z.ZodLiteral<"POSITION_UPDATE">;
    payload: z.ZodObject<{
        positionId: z.ZodString;
        currentPnL: z.ZodNumber;
        currentLTP: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        positionId: string;
        currentPnL: number;
        currentLTP: number;
    }, {
        positionId: string;
        currentPnL: number;
        currentLTP: number;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "POSITION_UPDATE";
    payload: {
        positionId: string;
        currentPnL: number;
        currentLTP: number;
    };
}, {
    type: "POSITION_UPDATE";
    payload: {
        positionId: string;
        currentPnL: number;
        currentLTP: number;
    };
}>, z.ZodObject<{
    type: z.ZodLiteral<"SESSION_STARTED">;
    payload: z.ZodObject<{
        sessionId: z.ZodString;
        asset: z.ZodString;
        paperCapital: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        sessionId: string;
        asset: string;
        paperCapital: number;
    }, {
        sessionId: string;
        asset: string;
        paperCapital: number;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "SESSION_STARTED";
    payload: {
        sessionId: string;
        asset: string;
        paperCapital: number;
    };
}, {
    type: "SESSION_STARTED";
    payload: {
        sessionId: string;
        asset: string;
        paperCapital: number;
    };
}>, z.ZodObject<{
    type: z.ZodLiteral<"SESSION_STOPPED">;
    payload: z.ZodObject<{
        sessionId: z.ZodString;
        finalPnL: z.ZodNumber;
        totalTrades: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        sessionId: string;
        totalTrades: number;
        finalPnL: number;
    }, {
        sessionId: string;
        totalTrades: number;
        finalPnL: number;
    }>;
}, "strip", z.ZodTypeAny, {
    type: "SESSION_STOPPED";
    payload: {
        sessionId: string;
        totalTrades: number;
        finalPnL: number;
    };
}, {
    type: "SESSION_STOPPED";
    payload: {
        sessionId: string;
        totalTrades: number;
        finalPnL: number;
    };
}>, z.ZodObject<{
    type: z.ZodLiteral<"TICK_SKIPPED">;
    reason: z.ZodString;
    timestamp: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    type: "TICK_SKIPPED";
    timestamp: number;
    reason: string;
}, {
    type: "TICK_SKIPPED";
    timestamp: number;
    reason: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"TICK_ERROR">;
    error: z.ZodString;
    timestamp: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    type: "TICK_ERROR";
    timestamp: number;
    error: string;
}, {
    type: "TICK_ERROR";
    timestamp: number;
    error: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"HEARTBEAT">;
    timestamp: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    type: "HEARTBEAT";
    timestamp: number;
}, {
    type: "HEARTBEAT";
    timestamp: number;
}>]>;
export type WSMessage = z.infer<typeof wsMessageSchema>;
export type { PrimarySignal, VerifierResult, IndicatorSnapshot, GreeksSnapshot, ExpiryContext, OptionsPosition, };
//# sourceMappingURL=websocket.d.ts.map