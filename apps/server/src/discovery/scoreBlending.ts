import type { LexicalScore } from './lexicalScoring.js';
import type { FitAssessment } from './modelScoring.js';

/**
 * Put a model's read and the cheap pass on one number.
 *
 * The cheap pass only gets a vote in proportion to what it actually knows.
 * When it was scoring everything at 50 it still took a flat 30% of every
 * blend, which dragged a model's 90 down to 78 and its 20 up to 29 - the whole
 * range squeezed toward the middle by a number carrying no information.
 */
export function blendScores(fit: FitAssessment, lexical: LexicalScore): number {
  if (fit.dealbreaker) return Math.min(fit.score, 15);
  const weight = 0.3 * lexical.confidence;
  return (1 - weight) * fit.score + weight * lexical.score;
}
