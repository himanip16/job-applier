const { PrismaClient } = require('./generated/prisma');

const prisma = new PrismaClient();

async function checkUsersWithoutProfiles() {
  try {
    const usersWithoutProfiles = await prisma.user.findMany({
      where: {
        profile: null
      },
      select: {
        id: true,
        email: true,
        createdAt: true
      }
    });

    console.log('Users without profiles:', usersWithoutProfiles.length);
    if (usersWithoutProfiles.length > 0) {
      console.log('Users:', JSON.stringify(usersWithoutProfiles, null, 2));
    }

    // Also check total users and profiles
    const totalUsers = await prisma.user.count();
    const totalProfiles = await prisma.profile.count();
    console.log(`Total users: ${totalUsers}, Total profiles: ${totalProfiles}`);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkUsersWithoutProfiles();