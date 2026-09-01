const { PrismaClient } = require('./generated/prisma');

const prisma = new PrismaClient();

async function checkOrphanProfiles() {
  try {
    const orphanProfiles = await prisma.profile.findMany({
      where: {
        userId: null
      },
      select: {
        id: true,
        fullName: true,
        createdAt: true
      }
    });

    console.log('Orphan profiles (userId=null):', orphanProfiles.length);
    if (orphanProfiles.length > 0) {
      console.log('Orphans:', JSON.stringify(orphanProfiles, null, 2));
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkOrphanProfiles();