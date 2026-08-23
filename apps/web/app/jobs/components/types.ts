export interface Detail {
  job: {
    title: string;
    company: string;
    location: string | null;
    remote: boolean;
    url: string;
    ats: string;
    postedAt: string | null;
    descriptionText: string | null;
  };
  match: {
    score: number;
    /** where the score came from: lexical keyword count or model judgment */
    scoreSource?: 'LEXICAL' | 'MODEL';
    /** What a keyword-only score is made of: the posting's words against the resume's. */
    affinity?: number;
    sharedTerms?: string[];
    missingTerms?: string[];
    deepScored: boolean;
    verdict: string | null;
    seniorityFit: string | null;
    forIt: string[];
    againstIt: string[];
    dealbreaker: string | null;
    likedTerms: string[];
    dislikedTerms: string[];
    /** optional timestamp when a model performed deep scoring */
    evaluatedAt?: string | null;
  } | null;
  lead: { id: string; status: string; rejectReason: string | null; rejectCategory: string | null } | null;
  application: {
    id: string;
    status: string;
    blockedReason: string | null;
    outcome: string;
    outcomeAt: string | null;
    outcomeNote: string | null;
    submittedAt: string | null;
    confirmation: string | null;
    notes: string | null;
    coverLetter: { present: boolean; words: number };
    resume:
      | { tailored: true; label: string; coverage: number; insertions: number; unsupported: number }
      | { tailored: false };
    fields: {
      total: number;
      fromProfile: number;
      fromMemory: number;
      written: number;
      inferred: number;
      asked: number;
      skipped: number;
      failed: number;
      needsYou: number;
    };
  } | null;
  rounds: {
    id: string;
    name: string;
    status: string;
    format: string | null;
    scheduledAt: string | null;
    completedAt: string | null;
    interviewers: string | null;
    notes: string | null;
    questions: { id: string; question: string; myAnswer: string | null; selfRating: string | null; category: string | null }[];
  }[];
  lessons: { id: string; text: string; category: string | null; roundId: string | null }[];
  nextAction: { label: string; href: string; urgent: boolean } | null;
}
