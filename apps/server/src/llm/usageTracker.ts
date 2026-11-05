import { prisma } from '../lib/db.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

/**
 * LLM usage tracking.
 *
 * Tracks token consumption and estimated costs for all LLM API calls.
 * Enables cost monitoring and budgeting for AI usage.
 */

export interface UsageContext {
  profileId?: string;
  applicationId?: string;
  leadId?: string;
  operation: string;
}

/**
 * Estimate cost based on provider, model, and token counts.
 *
 * Prices are approximate and should be updated periodically.
 * Returns cost in USD.
 */
export function estimateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  // Approximate pricing (USD per 1M tokens)
  const pricing: Record<string, Record<string, { input: number; output: number }>> = {
    anthropic: {
      'claude-opus-5': { input: 15, output: 75 },
      'claude-haiku-4-5': { input: 0.25, output: 1.25 },
      'claude-3-5-sonnet': { input: 3, output: 15 },
      'claude-3-opus': { input: 15, output: 75 },
      'claude-3-sonnet': { input: 3, output: 15 },
      'claude-3-haiku': { input: 0.25, output: 1.25 },
    },
    gemini: {
      'gemini-3.5-flash': { input: 0.075, output: 0.3 },
      'gemini-2.5-pro': { input: 1.25, output: 5 },
      'gemini-2.0-flash': { input: 0.075, output: 0.3 },
      'gemini-1.5-pro': { input: 0.5, output: 1.5 },
      'gemini-1.5-flash': { input: 0.075, output: 0.3 },
    },
  };

  const providerPricing = pricing[provider];
  if (!providerPricing) {
    // Unknown provider - use a conservative estimate
    return (inputTokens + outputTokens) * 0.000001; // $1 per 1M tokens
  }

  const modelPricing = providerPricing[model];
  if (!modelPricing) {
    // Unknown model - use a conservative estimate for the provider
    return (inputTokens + outputTokens) * 0.000001;
  }

  const inputCost = (inputTokens / 1_000_000) * modelPricing.input;
  const outputCost = (outputTokens / 1_000_000) * modelPricing.output;

  return inputCost + outputCost;
}

/**
 * Record LLM usage in the database.
 *
 * Called after each LLM API call to track token usage and costs.
 */
export async function recordLLMUsage(
  provider: string,
  model: string,
  operation: string,
  inputTokens: number,
  outputTokens: number,
  context: UsageContext,
  requestId?: string,
): Promise<void> {
  if (!config.trackLLMCosts) {
    return;
  }

  const totalTokens = inputTokens + outputTokens;
  const estimatedCost = estimateCost(provider, model, inputTokens, outputTokens);

  try {
    await prisma.lLMUsage.create({
      data: {
        profileId: context.profileId,
        provider,
        model,
        operation,
        applicationId: context.applicationId,
        leadId: context.leadId,
        inputTokens,
        outputTokens,
        totalTokens,
        estimatedCost,
        requestId,
      },
    });

    logger.debug(
      {
        provider,
        model,
        operation,
        inputTokens,
        outputTokens,
        totalTokens,
        estimatedCost,
      },
      '[llm-usage] Recorded usage',
    );
  } catch (err) {
    // Don't fail the application if usage tracking fails
    logger.error({ err }, '[llm-usage] Failed to record usage');
  }
}

/**
 * Get LLM usage statistics for a profile.
 */
export async function getLLMUsageStats(profileId: string, since?: Date) {
  const where: any = { profileId };
  if (since) {
    where.createdAt = { gte: since };
  }

  const usage = await prisma.lLMUsage.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 1000,
  });

  const totalTokens = usage.reduce((sum, u) => sum + u.totalTokens, 0);
  const totalCost = usage.reduce((sum, u) => sum + u.estimatedCost, 0);
  const byOperation = usage.reduce((acc, u) => {
    acc[u.operation] = (acc[u.operation] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const byModel = usage.reduce((acc, u) => {
    acc[u.model] = (acc[u.model] || { tokens: 0, cost: 0 });
    acc[u.model].tokens += u.totalTokens;
    acc[u.model].cost += u.estimatedCost;
    return acc;
  }, {} as Record<string, { tokens: number; cost: number }>);

  return {
    totalCalls: usage.length,
    totalTokens,
    totalCost,
    byOperation,
    byModel,
    recent: usage.slice(0, 50),
  };
}
