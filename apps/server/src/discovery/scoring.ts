// Re-export from modularized scoring components
export {
  ScorableJob,
  countable,
  jobTermWeights,
  jobTerms,
  profileVocabulary,
  buildVocabulary,
} from './featureExtraction.js';

export {
  LexicalScore,
  ScoringContext,
  scoreLexically,
} from './lexicalScoring.js';

export {
  loadSignals,
  learnFromDecision,
} from './signalLearning.js';

export {
  FitAssessment,
  assessFit,
  assessFitBatch,
} from './modelScoring.js';

export {
  loadScoringContext,
} from './scoringContext.js';

export {
  blendScores,
} from './scoreBlending.js';

export {
  buildRejectionHistory,
  buildPreferences,
  serialiseReasons,
} from './dataBuilders.js';
