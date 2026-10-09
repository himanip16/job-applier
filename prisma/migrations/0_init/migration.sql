-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "FactKind" AS ENUM ('TEXT', 'BOOLEAN', 'NUMBER', 'DATE', 'ENUM', 'LIST');

-- CreateEnum
CREATE TYPE "AnswerSource" AS ENUM ('USER', 'PROFILE', 'INFERRED');

-- CreateEnum
CREATE TYPE "AnswerScope" AS ENUM ('GLOBAL', 'PER_COMPANY');

-- CreateEnum
CREATE TYPE "FieldKind" AS ENUM ('TEXT', 'TEXTAREA', 'EMAIL', 'PHONE', 'URL', 'NUMBER', 'DATE', 'SELECT', 'MULTISELECT', 'RADIO', 'CHECKBOX', 'CHECKBOX_GROUP', 'FILE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AppStatus" AS ENUM ('QUEUED', 'PREPARING', 'FILLING', 'NEEDS_INPUT', 'NEEDS_HUMAN', 'REVIEW', 'SUBMITTING', 'SUBMITTED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'SHORTLISTED', 'REJECTED', 'APPLIED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "Outcome" AS ENUM ('IN_PROGRESS', 'REJECTED', 'GHOSTED', 'WITHDRAWN', 'OFFER', 'ACCEPTED', 'DECLINED');

-- CreateTable
CREATE TABLE "profiles" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "city" TEXT,
    "region" TEXT,
    "country" TEXT,
    "countryCode" TEXT,
    "linkedin" TEXT,
    "github" TEXT,
    "website" TEXT,
    "portfolio" TEXT,
    "summary" TEXT,
    "resumeText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profile_facts" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "kind" "FactKind" NOT NULL DEFAULT 'TEXT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profile_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resume_files" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "text" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resume_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "answers" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "canonicalKey" TEXT,
    "normalizedLabel" TEXT NOT NULL,
    "rawLabel" TEXT NOT NULL,
    "vector" JSONB NOT NULL,
    "value" JSONB NOT NULL,
    "displayValue" TEXT NOT NULL,
    "fieldKind" "FieldKind" NOT NULL,
    "options" JSONB,
    "source" "AnswerSource" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "scope" "AnswerScope" NOT NULL DEFAULT 'GLOBAL',
    "companyKey" TEXT,
    "timesUsed" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "ats" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "descriptionText" TEXT,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "status" "AppStatus" NOT NULL DEFAULT 'QUEUED',
    "blockedReason" TEXT,
    "fieldPlan" JSONB,
    "coverLetter" TEXT,
    "resumeFileId" TEXT,
    "requiresReview" BOOLEAN NOT NULL DEFAULT true,
    "submittedAt" TIMESTAMP(3),
    "confirmation" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "outcome" "Outcome" NOT NULL DEFAULT 'IN_PROGRESS',
    "outcomeAt" TIMESTAMP(3),
    "outcomeNote" TEXT,
    "tailoredResumeId" TEXT,
    "notes" TEXT,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_questions" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "fieldSelector" TEXT NOT NULL,
    "rawLabel" TEXT NOT NULL,
    "helpText" TEXT,
    "fieldKind" "FieldKind" NOT NULL,
    "options" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT NOT NULL,
    "suggestion" JSONB,
    "suggestionRationale" TEXT,
    "answeredAt" TIMESTAMP(3),
    "answerValue" JSONB,
    "remember" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_events" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifacts" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastCrawledAt" TIMESTAMP(3),
    "lastCrawlNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_leads" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "companyId" TEXT,
    "url" TEXT NOT NULL,
    "ats" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "location" TEXT,
    "remote" BOOLEAN NOT NULL DEFAULT false,
    "descriptionText" TEXT,
    "postedAt" TIMESTAMP(3),
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "scoreReasons" JSONB,
    "scoredAt" TIMESTAMP(3),
    "deepScored" BOOLEAN NOT NULL DEFAULT false,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "rejectReason" TEXT,
    "rejectCategory" TEXT,
    "decidedAt" TIMESTAMP(3),
    "applicationId" TEXT,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preference_signals" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'LEXICAL',
    "evidence" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "preference_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tailored_resumes" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "jobId" TEXT,
    "baseResumeId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "txtPath" TEXT,
    "docxPath" TEXT,
    "insertions" JSONB NOT NULL,
    "unsupported" JSONB NOT NULL,
    "covered" JSONB NOT NULL,
    "coverage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tailored_resumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_rounds" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "scheduledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "interviewers" TEXT,
    "format" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interview_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_questions" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "myAnswer" TEXT,
    "selfRating" TEXT,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lessons" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "roundId" TEXT,
    "text" TEXT NOT NULL,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "profiles_email_key" ON "profiles"("email");

-- CreateIndex
CREATE UNIQUE INDEX "profile_facts_profileId_key_key" ON "profile_facts"("profileId", "key");

-- CreateIndex
CREATE INDEX "answers_profileId_canonicalKey_idx" ON "answers"("profileId", "canonicalKey");

-- CreateIndex
CREATE INDEX "answers_profileId_normalizedLabel_idx" ON "answers"("profileId", "normalizedLabel");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_url_key" ON "jobs"("url");

-- CreateIndex
CREATE INDEX "applications_status_idx" ON "applications"("status");

-- CreateIndex
CREATE UNIQUE INDEX "applications_profileId_jobId_key" ON "applications"("profileId", "jobId");

-- CreateIndex
CREATE INDEX "pending_questions_applicationId_answeredAt_idx" ON "pending_questions"("applicationId", "answeredAt");

-- CreateIndex
CREATE INDEX "application_events_applicationId_createdAt_idx" ON "application_events"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "artifacts_applicationId_createdAt_idx" ON "artifacts"("applicationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "companies_source_handle_key" ON "companies"("source", "handle");

-- CreateIndex
CREATE INDEX "job_leads_profileId_status_score_idx" ON "job_leads"("profileId", "status", "score");

-- CreateIndex
CREATE UNIQUE INDEX "job_leads_profileId_url_key" ON "job_leads"("profileId", "url");

-- CreateIndex
CREATE INDEX "preference_signals_profileId_weight_idx" ON "preference_signals"("profileId", "weight");

-- CreateIndex
CREATE UNIQUE INDEX "preference_signals_profileId_term_key" ON "preference_signals"("profileId", "term");

-- CreateIndex
CREATE INDEX "tailored_resumes_profileId_createdAt_idx" ON "tailored_resumes"("profileId", "createdAt");

-- CreateIndex
CREATE INDEX "interview_rounds_applicationId_sequence_idx" ON "interview_rounds"("applicationId", "sequence");

-- CreateIndex
CREATE INDEX "interview_questions_roundId_idx" ON "interview_questions"("roundId");

-- CreateIndex
CREATE INDEX "lessons_applicationId_idx" ON "lessons"("applicationId");

-- AddForeignKey
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_files" ADD CONSTRAINT "resume_files_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answers" ADD CONSTRAINT "answers_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_questions" ADD CONSTRAINT "pending_questions_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_leads" ADD CONSTRAINT "job_leads_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_rounds" ADD CONSTRAINT "interview_rounds_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_questions" ADD CONSTRAINT "interview_questions_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "interview_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "interview_rounds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

