import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

const { requireTestDatabase } = await import('./testDb.js');
requireTestDatabase();

const { prisma } = await import('../src/lib/db.js');
const { uploadResume, setDefaultResume } = await import('../src/services/resumeService.js');

describe('resume service', () => {
  beforeEach(async () => {
    await prisma.resumeFile.deleteMany({});
    await prisma.profile.deleteMany({});
  });

  it('generates secure filename instead of trusting user filename', async () => {
    const profile = await prisma.profile.create({
      data: {
        email: 'test@example.com',
        fullName: 'Test User',
        firstName: 'Test',
        lastName: 'User',
      },
    });

    const file = {
      filename: '../../../etc/passwd',
      mimetype: 'application/pdf',
      toBuffer: async () => Buffer.from('fake pdf content'),
    };

    const result = await uploadResume(profile.id, file, 'Test Resume');

    // Path should contain a secure random filename, not the user's filename
    expect(result.resume.path).not.toContain('../../../etc/passwd');
    expect(result.resume.path).toMatch(/[a-f0-9]{32}\.pdf$/);
    
    // Stored filename should still be the original for display purposes
    expect(result.resume.filename).toBe('../../../etc/passwd');
  });

  it('uses file extension from original filename', async () => {
    const profile = await prisma.profile.create({
      data: {
        email: 'test@example.com',
        fullName: 'Test User',
        firstName: 'Test',
        lastName: 'User',
      },
    });

    const file = {
      filename: 'resume.docx',
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      toBuffer: async () => Buffer.from('fake docx content'),
    };

    const result = await uploadResume(profile.id, file, 'Test Resume');

    expect(result.resume.path).toMatch(/[a-f0-9]{32}\.docx$/);
  });

  it('defaults to .pdf if no extension', async () => {
    const profile = await prisma.profile.create({
      data: {
        email: 'test@example.com',
        fullName: 'Test User',
        firstName: 'Test',
        lastName: 'User',
      },
    });

    const file = {
      filename: 'resume',
      mimetype: 'application/pdf',
      toBuffer: async () => Buffer.from('fake pdf content'),
    };

    const result = await uploadResume(profile.id, file, 'Test Resume');

    expect(result.resume.path).toMatch(/[a-f0-9]{32}\.pdf$/);
  });

  it('sets first resume as default within transaction', async () => {
    const profile = await prisma.profile.create({
      data: {
        email: 'test@example.com',
        fullName: 'Test User',
        firstName: 'Test',
        lastName: 'User',
      },
    });

    const file = {
      filename: 'resume.pdf',
      mimetype: 'application/pdf',
      toBuffer: async () => Buffer.from('fake pdf content'),
    };

    const result = await uploadResume(profile.id, file, 'First Resume');

    expect(result.resume.isDefault).toBe(true);
  });

  it('does not set subsequent resumes as default', async () => {
    const profile = await prisma.profile.create({
      data: {
        email: 'test@example.com',
        fullName: 'Test User',
        firstName: 'Test',
        lastName: 'User',
      },
    });

    const file1 = {
      filename: 'resume1.pdf',
      mimetype: 'application/pdf',
      toBuffer: async () => Buffer.from('fake pdf content'),
    };

    const file2 = {
      filename: 'resume2.pdf',
      mimetype: 'application/pdf',
      toBuffer: async () => Buffer.from('fake pdf content'),
    };

    await uploadResume(profile.id, file1, 'First Resume');
    const result2 = await uploadResume(profile.id, file2, 'Second Resume');

    expect(result2.resume.isDefault).toBe(false);
  });

  it('updates profile resumeText for first resume within transaction', async () => {
    const profile = await prisma.profile.create({
      data: {
        email: 'test@example.com',
        fullName: 'Test User',
        firstName: 'Test',
        lastName: 'User',
      },
    });

    const file = {
      filename: 'resume.pdf',
      mimetype: 'application/pdf',
      toBuffer: async () => Buffer.from('fake pdf content'),
    };

    await uploadResume(profile.id, file, 'Test Resume');

    const updatedProfile = await prisma.profile.findUnique({ where: { id: profile.id } });
    expect(updatedProfile?.resumeText).toBe('fake pdf content');
  });

  it('verifies profile ownership before setting default resume', async () => {
    const profile1 = await prisma.profile.create({
      data: {
        email: 'user1@example.com',
        fullName: 'User One',
        firstName: 'User',
        lastName: 'One',
      },
    });

    const profile2 = await prisma.profile.create({
      data: {
        email: 'user2@example.com',
        fullName: 'User Two',
        firstName: 'User',
        lastName: 'Two',
      },
    });

    const file = {
      filename: 'resume.pdf',
      mimetype: 'application/pdf',
      toBuffer: async () => Buffer.from('fake pdf content'),
    };

    const result = await uploadResume(profile1.id, file, 'User One Resume');

    // Try to set profile1's resume as default for profile2
    await expect(setDefaultResume(profile2.id, result.resume.id)).rejects.toThrow();
  });

  it('clears other defaults and sets new default in transaction', async () => {
    const profile = await prisma.profile.create({
      data: {
        email: 'test@example.com',
        fullName: 'Test User',
        firstName: 'Test',
        lastName: 'User',
      },
    });

    const file1 = {
      filename: 'resume1.pdf',
      mimetype: 'application/pdf',
      toBuffer: async () => Buffer.from('fake pdf content'),
    };

    const file2 = {
      filename: 'resume2.pdf',
      mimetype: 'application/pdf',
      toBuffer: async () => Buffer.from('fake pdf content'),
    };

    const result1 = await uploadResume(profile.id, file1, 'First Resume');
    const result2 = await uploadResume(profile.id, file2, 'Second Resume');

    // Set second as default
    await setDefaultResume(profile.id, result2.resume.id);

    const resumes = await prisma.resumeFile.findMany({ where: { profileId: profile.id } });
    const firstResume = resumes.find(r => r.id === result1.resume.id);
    const secondResume = resumes.find(r => r.id === result2.resume.id);

    expect(firstResume?.isDefault).toBe(false);
    expect(secondResume?.isDefault).toBe(true);
  });

  it('updates profile resumeText when setting default', async () => {
    const profile = await prisma.profile.create({
      data: {
        email: 'test@example.com',
        fullName: 'Test User',
        firstName: 'Test',
        lastName: 'User',
      },
    });

    const file1 = {
      filename: 'resume1.pdf',
      mimetype: 'application/pdf',
      toBuffer: async () => Buffer.from('content1'),
    };

    const file2 = {
      filename: 'resume2.pdf',
      mimetype: 'application/pdf',
      toBuffer: async () => Buffer.from('content2'),
    };

    const result1 = await uploadResume(profile.id, file1, 'First Resume');
    const result2 = await uploadResume(profile.id, file2, 'Second Resume');

    await setDefaultResume(profile.id, result2.resume.id);

    const updatedProfile = await prisma.profile.findUnique({ where: { id: profile.id } });
    expect(updatedProfile?.resumeText).toBe('content2');
  });

  it('handles concurrent resume uploads with transaction', async () => {
    const profile = await prisma.profile.create({
      data: {
        email: 'test@example.com',
        fullName: 'Test User',
        firstName: 'Test',
        lastName: 'User',
      },
    });

    const file = {
      filename: 'resume.pdf',
      mimetype: 'application/pdf',
      toBuffer: async () => Buffer.from('fake pdf content'),
    };

    // Simulate concurrent uploads
    const [result1, result2] = await Promise.all([
      uploadResume(profile.id, file, 'Resume 1'),
      uploadResume(profile.id, file, 'Resume 2'),
    ]);

    // Both should succeed without error
    expect(result1.resume).toBeDefined();
    expect(result2.resume).toBeDefined();

    // Only one should be default (the first one created)
    const resumes = await prisma.resumeFile.findMany({ where: { profileId: profile.id } });
    const defaultCount = resumes.filter(r => r.isDefault).length;
    expect(defaultCount).toBe(1);
  });
});
