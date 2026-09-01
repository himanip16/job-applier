const { PrismaClient } = require('./generated/prisma');

const prisma = new PrismaClient();

async function deleteUser() {
  try {
    // Delete the user without a profile
    const result = await prisma.user.deleteMany({
      where: {
        email: 'h.nprasad016@gmail.com'
      }
    });

    console.log(`Deleted ${result.count} user(s)`);

    // Verify deletion
    const remainingUsers = await prisma.user.count();
    console.log(`Remaining users: ${remainingUsers}`);

  } catch (error) {
    console.error('Error deleting user:', error);
  } finally {
    await prisma.$disconnect();
  }
}

deleteUser();