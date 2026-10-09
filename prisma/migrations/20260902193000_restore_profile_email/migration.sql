-- Restore the candidate contact email expected by the Profile model.
-- Authentication email remains on users; existing profiles inherit it.
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "email" TEXT;

UPDATE "profiles" AS p
SET "email" = u."email"
FROM "users" AS u
WHERE p."userId" = u."id"
  AND p."email" IS NULL;

-- Legacy/unowned profiles cannot be backfilled from users. Give them a stable,
-- unique local value so the NOT NULL constraint can be restored without data loss.
UPDATE "profiles"
SET "email" = 'profile-' || "id" || '@local.invalid'
WHERE "email" IS NULL;

ALTER TABLE "profiles" ALTER COLUMN "email" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "profiles_email_key" ON "profiles"("email");
