-- CreateEnum
CREATE TYPE "ContactRole" AS ENUM ('TALENT', 'ENGINEERING', 'OTHER');

-- CreateEnum
CREATE TYPE "OutreachChannel" AS ENUM ('CONNECTION_NOTE', 'DIRECT_MESSAGE', 'INMAIL');

-- CreateEnum
CREATE TYPE "OutreachStatus" AS ENUM ('DRAFT', 'APPROVED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "SyncType" AS ENUM ('CONNECTIONS', 'MESSAGES');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "OutreachType" AS ENUM ('COLD', 'REPLY', 'FOLLOW_UP');

-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "citizenship" TEXT,
ADD COLUMN     "expectedCTC" TEXT;

-- CreateTable
CREATE TABLE "password_resets" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "headline" TEXT,
    "companyName" TEXT NOT NULL,
    "companyKey" TEXT NOT NULL,
    "location" TEXT,
    "profileUrl" TEXT NOT NULL,
    "role" "ContactRole" NOT NULL,
    "roleReason" TEXT,
    "degree" TEXT,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isConnection" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_messages" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "leadId" TEXT,
    "jobTitle" TEXT NOT NULL,
    "jobUrl" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "channel" "OutreachChannel" NOT NULL,
    "draftBody" TEXT NOT NULL,
    "finalBody" TEXT,
    "charLimit" INTEGER NOT NULL,
    "status" "OutreachStatus" NOT NULL DEFAULT 'DRAFT',
    "statusReason" TEXT,
    "alsoApply" BOOLEAN NOT NULL DEFAULT true,
    "applicationId" TEXT,
    "editedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreach_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linkedin_sync" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "syncType" "SyncType" NOT NULL,
    "lastSyncAt" TIMESTAMP(3),
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "linkedin_sync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linkedin_conversations" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "linkedinConversationId" TEXT NOT NULL,
    "linkedinProfileUrl" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "linkedin_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linkedin_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "linkedinMessageId" TEXT NOT NULL,
    "senderProfileUrl" TEXT NOT NULL,
    "isFromMe" BOOLEAN NOT NULL,
    "body" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "linkedin_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_items" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "type" "OutreachType" NOT NULL,
    "leadId" TEXT,
    "jobTitle" TEXT,
    "jobUrl" TEXT,
    "companyName" TEXT,
    "channel" "OutreachChannel" NOT NULL,
    "draftBody" TEXT NOT NULL,
    "finalBody" TEXT,
    "charLimit" INTEGER NOT NULL,
    "status" "OutreachStatus" NOT NULL DEFAULT 'DRAFT',
    "statusReason" TEXT,
    "conversationId" TEXT,
    "lastMessages" JSONB,
    "editedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreach_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "password_resets_tokenHash_key" ON "password_resets"("tokenHash");

-- CreateIndex
CREATE INDEX "password_resets_userId_idx" ON "password_resets"("userId");

-- CreateIndex
CREATE INDEX "password_resets_tokenHash_idx" ON "password_resets"("tokenHash");

-- CreateIndex
CREATE INDEX "contacts_profileId_companyKey_idx" ON "contacts"("profileId", "companyKey");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_profileId_profileUrl_key" ON "contacts"("profileId", "profileUrl");

-- CreateIndex
CREATE INDEX "outreach_messages_profileId_status_createdAt_idx" ON "outreach_messages"("profileId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_messages_profileId_contactId_jobUrl_key" ON "outreach_messages"("profileId", "contactId", "jobUrl");

-- CreateIndex
CREATE UNIQUE INDEX "linkedin_sync_profileId_syncType_key" ON "linkedin_sync"("profileId", "syncType");

-- CreateIndex
CREATE INDEX "linkedin_conversations_profileId_lastMessageAt_idx" ON "linkedin_conversations"("profileId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "linkedin_conversations_contactId_idx" ON "linkedin_conversations"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "linkedin_conversations_profileId_linkedinConversationId_key" ON "linkedin_conversations"("profileId", "linkedinConversationId");

-- CreateIndex
CREATE INDEX "linkedin_messages_conversationId_sentAt_idx" ON "linkedin_messages"("conversationId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "linkedin_messages_conversationId_linkedinMessageId_key" ON "linkedin_messages"("conversationId", "linkedinMessageId");

-- CreateIndex
CREATE INDEX "outreach_items_profileId_status_type_createdAt_idx" ON "outreach_items"("profileId", "status", "type", "createdAt");

-- CreateIndex
CREATE INDEX "outreach_items_contactId_idx" ON "outreach_items"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_items_profileId_contactId_type_jobUrl_key" ON "outreach_items"("profileId", "contactId", "type", "jobUrl");

-- AddForeignKey
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_messages" ADD CONSTRAINT "outreach_messages_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linkedin_sync" ADD CONSTRAINT "linkedin_sync_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linkedin_conversations" ADD CONSTRAINT "linkedin_conversations_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linkedin_conversations" ADD CONSTRAINT "linkedin_conversations_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "linkedin_messages" ADD CONSTRAINT "linkedin_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "linkedin_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_items" ADD CONSTRAINT "outreach_items_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_items" ADD CONSTRAINT "outreach_items_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_items" ADD CONSTRAINT "outreach_items_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "linkedin_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
