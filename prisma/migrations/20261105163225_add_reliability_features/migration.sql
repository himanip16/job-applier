-- CreateEnum
CREATE TYPE "LinkedInConnectionStatus" AS ENUM ('NOT_CONNECTED', 'WAITING_FOR_SIGN_IN', 'CONNECTED', 'CHALLENGE_REQUIRED', 'REAUTH_REQUIRED');

-- AlterEnum
ALTER TYPE "SyncStatus" ADD VALUE 'TIMEOUT';

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "deadLetterReason" TEXT,
ADD COLUMN     "deadLettered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastRetryAt" TIMESTAMP(3),
ADD COLUMN     "nextRetryAt" TIMESTAMP(3),
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "job_leads" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "linkedin_sync" ADD COLUMN     "heartbeatAt" TIMESTAMP(3),
ADD COLUMN     "startedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "outreach_items" ALTER COLUMN "jobUrl" SET DEFAULT '';

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "linkedinConnectionStatus" "LinkedInConnectionStatus" NOT NULL DEFAULT 'NOT_CONNECTED',
ADD COLUMN     "resumeKeywords" JSONB;

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_exclusions" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "companyKey" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_exclusions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbox_events_deliveredAt_createdAt_idx" ON "outbox_events"("deliveredAt", "createdAt");

-- CreateIndex
CREATE INDEX "outbox_events_entityId_entityType_idx" ON "outbox_events"("entityId", "entityType");

-- CreateIndex
CREATE INDEX "company_exclusions_profileId_companyKey_idx" ON "company_exclusions"("profileId", "companyKey");

-- CreateIndex
CREATE UNIQUE INDEX "company_exclusions_profileId_companyKey_key" ON "company_exclusions"("profileId", "companyKey");

-- CreateIndex
CREATE INDEX "job_leads_profileId_status_expiresAt_idx" ON "job_leads"("profileId", "status", "expiresAt");

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_tailoredResumeId_fkey" FOREIGN KEY ("tailoredResumeId") REFERENCES "tailored_resumes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tailored_resumes" ADD CONSTRAINT "tailored_resumes_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tailored_resumes" ADD CONSTRAINT "tailored_resumes_baseResumeId_fkey" FOREIGN KEY ("baseResumeId") REFERENCES "resume_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_exclusions" ADD CONSTRAINT "company_exclusions_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
