import { beforeEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';

const { requireTestDatabase } = await import('./testDb.js');
requireTestDatabase();

const { prisma } = await import('../src/lib/db.js');
const { registerResumeUploadRoutes } = await import('../src/routes/resumeUpload.js');
const { hashPassword } = await import('../src/auth/passwords.js');
const { createSession, SESSION_COOKIE } = await import('../src/auth/sessions.js');
const Fastify = (await import('fastify')).default;

let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  await prisma.resumeFile.deleteMany({});
  await prisma.profile.deleteMany({});
  await prisma.user.deleteMany({});
  app = Fastify();
  registerResumeUploadRoutes(app, await app);
  await app.ready();
});

async function createAuthenticatedUser(email: string) {
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword('a good long password') },
  });
  const { token } = await createSession(user.id, 'test-agent');
  return { user, cookie: `${SESSION_COOKIE}=${token}` };
}

async function createProfileForUser(userId: string) {
  return prisma.profile.create({
    data: {
      userId,
      email: 'profile@example.com',
      fullName: 'Profile User',
      firstName: 'Profile',
      lastName: 'User',
    },
  });
}

function createMultipartFile(filename: string, mimetype: string, content: Buffer, label?: string) {
  const fileBuffer = content;
  const file = {
    filename,
    mimetype,
    toBuffer: async () => fileBuffer,
    file: Readable.from(fileBuffer),
    fields: label ? { label: { value: label } } : {},
  };
  return file;
}

describe('resume upload routes', () => {
  it('accepts valid PDF file', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');
    await createProfileForUser(user.id);

    const file = createMultipartFile('resume.pdf', 'application/pdf', Buffer.from('fake pdf content'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/resume',
      payload: file,
      headers: { cookie, 'content-type': 'multipart/form-data' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('accepts valid DOC file', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');
    await createProfileForUser(user.id);

    const file = createMultipartFile('resume.doc', 'application/msword', Buffer.from('fake doc content'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/resume',
      payload: file,
      headers: { cookie, 'content-type': 'multipart/form-data' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('accepts valid DOCX file', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');
    await createProfileForUser(user.id);

    const file = createMultipartFile(
      'resume.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      Buffer.from('fake docx content'),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/resume',
      payload: file,
      headers: { cookie, 'content-type': 'multipart/form-data' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('rejects invalid MIME type with 400', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');
    await createProfileForUser(user.id);

    const file = createMultipartFile('resume.txt', 'text/plain', Buffer.from('text content'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/resume',
      payload: file,
      headers: { cookie, 'content-type': 'multipart/form-data' },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('Invalid file type');
  });

  it('rejects invalid file extension with 400', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');
    await createProfileForUser(user.id);

    const file = createMultipartFile('resume.txt', 'application/pdf', Buffer.from('fake pdf content'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/resume',
      payload: file,
      headers: { cookie, 'content-type': 'multipart/form-data' },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('Invalid file extension');
  });

  it('rejects label exceeding max length with 400', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');
    await createProfileForUser(user.id);

    const file = createMultipartFile(
      'resume.pdf',
      'application/pdf',
      Buffer.from('fake pdf content'),
      'a'.repeat(101),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/resume',
      payload: file,
      headers: { cookie, 'content-type': 'multipart/form-data' },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain('Label must be');
  });

  it('accepts label at max length', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');
    await createProfileForUser(user.id);

    const file = createMultipartFile(
      'resume.pdf',
      'application/pdf',
      Buffer.from('fake pdf content'),
      'a'.repeat(100),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/resume',
      payload: file,
      headers: { cookie, 'content-type': 'multipart/form-data' },
    });

    expect(res.statusCode).toBe(200);
  });

  it('hides resume text from response', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');
    await createProfileForUser(user.id);

    const file = createMultipartFile('resume.pdf', 'application/pdf', Buffer.from('resume text content'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/resume',
      payload: file,
      headers: { cookie, 'content-type': 'multipart/form-data' },
    });

    expect(res.statusCode).toBe(200);

    const data = res.json() as { resume: { text?: string } };
    expect(data.resume.text).toBeUndefined();
  });

  it('returns 401 for unauthenticated upload requests', async () => {
    const file = createMultipartFile('resume.pdf', 'application/pdf', Buffer.from('fake pdf content'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/resume',
      payload: file,
      headers: { 'content-type': 'multipart/form-data' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('sets default resume with ownership check', async () => {
    const { user: user1, cookie: cookie1 } = await createAuthenticatedUser('user1@example.com');
    const { user: user2, cookie: cookie2 } = await createAuthenticatedUser('user2@example.com');

    const profile1 = await createProfileForUser(user1.id);
    const profile2 = await createProfileForUser(user2.id);

    const file = createMultipartFile('resume.pdf', 'application/pdf', Buffer.from('fake pdf content'));

    const uploadRes = await app.inject({
      method: 'POST',
      url: '/api/resume',
      payload: file,
      headers: { cookie: cookie1, 'content-type': 'multipart/form-data' },
    });

    const resumeId = (uploadRes.json() as { resume: { id: string } }).resume.id;

    // User1 can set their own resume as default
    const setRes1 = await app.inject({
      method: 'POST',
      url: `/api/resume/${resumeId}/default`,
      headers: { cookie: cookie1 },
    });

    expect(setRes1.statusCode).toBe(200);

    // User2 cannot set user1's resume as default
    const setRes2 = await app.inject({
      method: 'POST',
      url: `/api/resume/${resumeId}/default`,
      headers: { cookie: cookie2 },
    });

    expect(setRes2.statusCode).toBe(404);
  });

  it('returns 401 for unauthenticated set default requests', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/resume/some-id/default',
    });

    expect(res.statusCode).toBe(401);
  });

  it('handles upload errors gracefully with 500', async () => {
    const { user, cookie } = await createAuthenticatedUser('test@example.com');
    await createProfileForUser(user.id);

    // Create a file that will cause an error (e.g., invalid buffer)
    const file = {
      filename: 'resume.pdf',
      mimetype: 'application/pdf',
      toBuffer: async () => {
        throw new Error('Disk write failed');
      },
      fields: {},
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/resume',
      payload: file,
      headers: { cookie, 'content-type': 'multipart/form-data' },
    });

    expect(res.statusCode).toBe(500);
  });
});
