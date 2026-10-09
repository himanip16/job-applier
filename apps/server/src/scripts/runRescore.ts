import 'dotenv/config';
import { prisma } from '../lib/db.js';
import { rescoreLexically } from '../discovery/rescoreLeads.js';

async function main() {
  const profile = await prisma.profile.findFirst();
  if (!profile) {
    console.error('No profile found in the database.');
    process.exit(1);
  }
  const profileId = profile.id;
  console.log('[runRescore] profileId:', profileId);

  try {
    const updated = await rescoreLexically(profileId);
    console.log('[runRescore] leads updated lexically:', updated);
  } catch (err) {
    console.error('[runRescore] failed:', (err as Error).message);
    process.exit(2);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main();
