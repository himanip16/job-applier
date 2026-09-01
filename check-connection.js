const { PrismaClient } = require('./generated/prisma');

const prisma = new PrismaClient();

async function checkDatabaseConnection() {
  try {
    // Try to get database info
    const result = await prisma.$queryRaw`SELECT current_database() as database_name, current_user as current_user`;
    console.log('Database connection info:', result);
    
    // Check if this looks like a test vs dev database
    const dbName = result[0]?.database_name;
    if (dbName) {
      console.log(`Connected to database: ${dbName}`);
      if (dbName.includes('test') || dbName.includes('testing')) {
        console.log('⚠️  This appears to be a TEST database');
      } else {
        console.log('This appears to be a development/production database');
      }
    }
    
  } catch (error) {
    console.error('Error checking connection:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkDatabaseConnection();