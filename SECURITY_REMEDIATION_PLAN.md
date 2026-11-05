# Security Remediation Plan

## Executive Summary

This document outlines a prioritized remediation plan for critical security vulnerabilities, resource leaks, and data integrity issues identified in the job-applier system. Issues are categorized by severity and include specific implementation guidance.

---

## Priority Level Definitions

- **CRITICAL**: Immediate security risk or resource exhaustion potential. Fix within 24-48 hours.
- **HIGH**: Data integrity issues affecting core functionality. Fix within 1 week.
- **MEDIUM**: Functional reliability issues. Fix within 2 weeks.
- **LOW**: Robustness improvements. Fix within 1 month.

---

## CRITICAL Issues (Fix Immediately)

### 1. Cross-Tenant Data Exposure in Job Lead Lookup
**Severity**: CRITICAL  
**File**: `apps/server/src/outreach/generate.ts`  
**Lines**: 38-50

**Vulnerability**:
```typescript
if (input.jobLeadId) {
  const lead = await prisma.jobLead.findUnique({
    where: { id: input.jobLeadId },
    include: { company: true },
  });
```

**Impact**: Authenticated users can access any job lead by ID, exposing sensitive job application data across user accounts.

**Fix**:
```typescript
if (input.jobLeadId) {
  const lead = await prisma.jobLead.findFirst({
    where: { 
      id: input.jobLeadId,
      profileId: input.profileId, // ADD THIS LINE
    },
    include: { company: true },
  });
```

**Verification**:
- Add test case attempting to access another user's job lead
- Verify 403/404 response when accessing unauthorized job leads

---

### 2. Orphaned Browser Page Memory Leaks
**Severity**: CRITICAL  
**File**: `apps/server/src/routes/outreach.ts`  
**Lines**: 38-74

**Vulnerability**:
```typescript
if (loggedIn) {
  await prisma.profile.update({...});
  await page.close();
  return reply.send({ status: 'CONNECTED', ... });
}
// MISSING: page.close() when not logged in
return reply.send({ status: 'WAITING_FOR_SIGN_IN', ... });
```

**Impact**: Every failed login attempt leaves a Chromium tab open, causing memory exhaustion and server crashes.

**Fix**:
```typescript
app.post('/api/linkedin/connect', async (req, reply) => {
  const profile = await requireProfile(req, reply);
  if (!profile) return;
  
  let page: Page | null = null;
  try {
    await prisma.profile.update({
      where: { id: profile.id },
      data: { linkedinConnectionStatus: 'WAITING_FOR_SIGN_IN' },
    });

    page = await linkedInPage();
    await page.goto('https://www.linkedin.com', { waitUntil: 'domcontentloaded', timeout: 45_000 });

    const loggedIn = await isLoggedIn(page);
    
    if (loggedIn) {
      await prisma.profile.update({
        where: { id: profile.id },
        data: { linkedinConnectionStatus: 'CONNECTED' },
      });
      await page.close();
      return reply.send({ status: 'CONNECTED', message: 'Already logged in to LinkedIn' });
    }

    // Keep page open for user to sign in - store page reference for later cleanup
    return reply.send({ status: 'WAITING_FOR_SIGN_IN', message: 'Browser opened. Please sign in to LinkedIn.' });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Unknown error occurred';
    await prisma.profile.update({
      where: { id: profile.id },
      data: { linkedinConnectionStatus: 'NOT_CONNECTED' },
    });
    // Clean up page on error
    if (page) {
      await page.close().catch(console.error);
    }
    return reply.code(500).send({ error: 'Failed to open LinkedIn', details: error });
  }
});
```

**Additional Fix Required**: Implement page cleanup mechanism for abandoned sign-in sessions. Add a background job to close pages left open for >10 minutes.

---

### 3. Playwright Thrashing via API Polling
**Severity**: CRITICAL  
**File**: `apps/server/src/routes/outreach.ts`  
**Lines**: 76-112

**Vulnerability**:
```typescript
if (profileData.linkedinConnectionStatus === 'WAITING_FOR_SIGN_IN') {
  const page = await linkedInPage(); // CREATES NEW PAGE ON EVERY POLL
  const loggedIn = await isLoggedIn(page);
  await page.close();
```

**Impact**: Frontend polling (typically every 2-5 seconds) launches dozens of browser instances per minute, causing CPU starvation.

**Fix**:
```typescript
// Replace page-based check with cookie-only check
if (profileData.linkedinConnectionStatus === 'WAITING_FOR_SIGN_IN') {
  try {
    const hasSession = await hasLinkedInSession(); // Cookie check only - no page creation
    if (hasSession) {
      // Only verify with page if we have a session cookie
      const page = await linkedInPage();
      const loggedIn = await isLoggedIn(page);
      await page.close();

      if (loggedIn) {
        await prisma.profile.update({
          where: { id: profile.id },
          data: { linkedinConnectionStatus: 'CONNECTED' },
        });
        return reply.send({ status: 'CONNECTED' });
      }
    }
  } catch (err) {
    // If we can't check, return current status
  }
}
```

**Alternative Better Fix**: Implement WebSocket or Server-Sent Events for real-time status updates instead of polling.

---

## HIGH Priority Issues (Fix Within 1 Week)

### 4. Duplicate Draft Accumulation
**Severity**: HIGH  
**File**: `apps/server/src/outreach/generate.ts`  
**Lines**: 86-101

**Vulnerability**:
```typescript
const item = await prisma.outreachItem.create({
  data: {
    profileId: input.profileId,
    contactId: input.contactId,
    // ...
    status: 'DRAFT',
  },
});
```

**Impact**: Multiple duplicate drafts accumulate for the same contact when users regenerate outreach.

**Fix**:
```typescript
// Check for existing DRAFT or APPROVED outreach for this contact
const existing = await prisma.outreachItem.findFirst({
  where: {
    profileId: input.profileId,
    contactId: input.contactId,
    status: { in: ['DRAFT', 'APPROVED'] },
  },
});

if (existing) {
  throw new Error(`Outreach already exists for this contact (ID: ${existing.id}). Use the existing draft or skip it first.`);
}

// Create OutreachItem
const item = await prisma.outreachItem.create({
  data: {
    profileId: input.profileId,
    contactId: input.contactId,
    type: 'COLD',
    leadId: input.jobLeadId,
    jobTitle,
    jobUrl,
    companyName,
    channel,
    draftBody: draft.body,
    charLimit,
    status: 'DRAFT',
  },
});
```

---

### 5. Missing Target Exclusion Filter
**Severity**: HIGH  
**File**: `apps/server/src/outreach/classify.ts`  
**Lines**: 31-39

**Vulnerability**:
```typescript
const contacts = await prisma.contact.findMany({
  where: {
    profileId,
    isConnection: true,
    role: { in: ['TALENT', 'ENGINEERING'] },
    conversations: { none: {} }, // Only checks conversations, not outreach items
  },
```

**Impact**: Contacts with existing DRAFT/APPROVED outreach continue to appear in target list.

**Fix**:
```typescript
const contacts = await prisma.contact.findMany({
  where: {
    profileId,
    isConnection: true,
    role: { in: ['TALENT', 'ENGINEERING'] },
    conversations: { none: {} },
    outreachItems: { none: {} }, // ADD: Exclude contacts with any outreach items
  },
  select: {
    id: true,
    fullName: true,
    headline: true,
    companyName: true,
    profileUrl: true,
    role: true,
    degree: true,
  },
  orderBy: [
    { discoveredAt: 'asc' },
  ],
});
```

**Note**: Also update `countColdTargetsByRole` function with the same filter.

---

### 6. Non-Deterministic Queue Ordering
**Severity**: HIGH  
**File**: `apps/server/src/outreach/classify.ts` (lines 49-51) and `apps/server/src/linkedin/sync.ts` (lines 219-236)

**Vulnerability**:
- `classify.ts` sorts by `discoveredAt: 'asc'`
- `sync.ts` upserts contacts without explicitly setting `discoveredAt`
- Result: All contacts in same sync batch have identical timestamps

**Impact**: Targets randomly reshuffle on every page reload.

**Fix Part 1** (sync.ts):
```typescript
await prisma.contact.upsert({
  where: { profileId_profileUrl: { profileId, profileUrl: conn.profileUrl } },
  update: updateData,
  create: {
    profileId,
    fullName: conn.fullName,
    headline: conn.headline,
    companyName: conn.companyName ?? 'Unknown',
    companyKey,
    location: conn.location,
    profileUrl: conn.profileUrl,
    role,
    roleReason: roleVerdict.reason,
    degree: conn.degree,
    isConnection: true,
    lastSyncedAt: new Date(),
    discoveredAt: new Date(), // ADD: Explicitly set on create
  },
});
```

**Fix Part 2** (classify.ts):
```typescript
orderBy: [
  { discoveredAt: 'asc' },
  { id: 'asc' }, // ADD: Secondary sort by ID for deterministic ordering
],
```

---

## MEDIUM Priority Issues (Fix Within 2 Weeks)

### 7. Fragile Regex Pollutes Company Names
**Severity**: MEDIUM  
**File**: `apps/server/src/linkedin/sync.ts`  
**Lines**: 109-116

**Vulnerability**:
```typescript
const companyMatch = headline.match(/(?:at|@)\s+([^|,\n]*(?:Inc|...|Engineering|Design|Services)...)/i);
```

**Impact**: Extracts garbage company names like "scale building Cloud" from "Software Engineer at scale building Cloud Services".

**Fix**:
```typescript
// Improved company extraction with stricter matching
function extractCompanyName(headline: string): string | undefined {
  // Look for "at CompanyName" or "@ CompanyName" patterns
  // Company name should end before common sentence structures
  const patterns = [
    /(?:at|@)\s+([A-Z][A-Za-z0-9\s&]*(?:Inc|Corp|LLC|Ltd|GmbH|Technologies|Solutions|Company|Group|Labs|Studios|Systems|Networks|Platform|AI|Software|Digital|Global|International))(?:\s|\||,|$)/i,
    /(?:at|@)\s+([A-Z][A-Za-z0-9\s&]{2,30})(?:\s(?:-|–|—|building|creating|developing|designing|engineering|scaling|growing|founding|leading|managing))/i,
  ];

  for (const pattern of patterns) {
    const match = headline.match(pattern);
    if (match && match[1]) {
      let companyName = match[1].trim();
      // Clean up
      companyName = companyName
        .replace(/\s*\|\s*.*$/, '')
        .replace(/\s*,\s*.*$/, '')
        .replace(/\s+(?:Ex-|Former|Previous|Past)\s+.*$/i, '')
        .replace(/\s+(?:building|creating|developing|designing|engineering|scaling|growing)\s+.*$/i, '')
        .trim();
      
      // Validate: must be reasonable length and not contain action verbs
      if (companyName.length >= 2 && companyName.length <= 50 && 
          !/^(building|creating|developing|designing|engineering|scaling|growing|at|@)$/i.test(companyName)) {
        return companyName;
      }
    }
  }
  return undefined;
}

// Replace the existing match with function call
const companyName = extractCompanyName(headline);
```

---

### 8. Silent Scraping Truncation
**Severity**: MEDIUM  
**File**: `apps/server/src/linkedin/sync.ts`  
**Lines**: 136-138

**Vulnerability**:
```typescript
await page.mouse.wheel(0, 2200);
await page.waitForTimeout(800);
```

**Impact**: Scroll may not work if cursor not positioned correctly; 20 passes only covers 100-200 connections of 1000+.

**Fix**:
```typescript
// Replace mouse.wheel with scrollToLoad function (already imported)
await scrollToLoad(page, 2200, 800);

// Increase max passes and add progress logging
const maxPasses = 50; // Increased from 20
const maxConnections = 2000; // Safety limit to prevent infinite loops

for (let pass = 0; pass < maxPasses && connections.length < maxConnections; pass++) {
  // ... existing scraping logic ...
  
  // Log progress periodically
  if (pass % 5 === 0) {
    console.log(`Sync progress: pass ${pass}, ${connections.length} connections scraped`);
  }
  
  // Scroll using the scrollToLoad helper which handles virtualization better
  await scrollToLoad(page, 2200, 800);
}

// Add warning if we hit the limit
if (connections.length >= maxConnections) {
  console.warn(`Reached connection limit (${maxConnections}). Some connections may not have been synced.`);
}
```

---

## LOW Priority Issues (Fix Within 1 Month)

### 9. Unsanitized State Transitions
**Severity**: LOW  
**File**: `apps/server/src/routes/outreach.ts`  
**Lines**: 223-257, 259-290, 328-353

**Vulnerability**:
- `PUT /api/outreach/items/:id`: Allows updating `finalBody` regardless of status
- `POST /api/outreach/items/:id/mark-sent`: Allows marking any item as SENT
- `POST /api/outreach/items/:id/approve`: Overwrites `finalBody` without checking status

**Fix**:
```typescript
// PUT /api/outreach/items/:id - Only allow edits on DRAFT items
app.put('/api/outreach/items/:id', async (req, reply) => {
  const profile = await requireProfile(req, reply);
  if (!profile) return;
  const { id } = req.params as { id: string };

  const schema = z.object({
    finalBody: z.string().trim().min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'Body text is required' });
  }

  // Check current status first
  const existing = await prisma.outreachItem.findUnique({
    where: { id },
    select: { status: true, profileId: true },
  });

  if (!existing) return reply.code(404).send({ error: 'Not found' });
  if (existing.profileId !== profile.id) return reply.code(403).send({ error: NOT_YOURS });
  
  // Only allow editing DRAFT items
  if (existing.status !== 'DRAFT') {
    return reply.code(400).send({ 
      error: 'Can only edit items in DRAFT status. Current status: ' + existing.status 
    });
  }

  const result = await prisma.outreachItem.updateMany({
    where: {
      id,
      profileId: profile.id,
      status: 'DRAFT', // Double-check in query
    },
    data: {
      finalBody: parsed.data.finalBody,
      editedAt: new Date(),
    },
  });

  if (result.count === 0) {
    return reply.code(404).send({ error: 'Not found or invalid status' });
  }

  const updated = await prisma.outreachItem.findUnique({ where: { id } });
  return reply.send(updated);
});

// POST /api/outreach/items/:id/mark-sent - Only allow from APPROVED status
app.post('/api/outreach/items/:id/mark-sent', async (req, reply) => {
  const profile = await requireProfile(req, reply);
  if (!profile) return;
  const { id } = req.params as { id: string };

  // Check current status
  const existing = await prisma.outreachItem.findUnique({
    where: { id },
    select: { status: true, profileId: true },
  });

  if (!existing) return reply.code(404).send({ error: 'Not found' });
  if (existing.profileId !== profile.id) return reply.code(403).send({ error: NOT_YOURS });
  
  // Only allow marking APPROVED items as SENT
  if (existing.status !== 'APPROVED') {
    return reply.code(400).send({ 
      error: 'Can only mark APPROVED items as SENT. Current status: ' + existing.status 
    });
  }

  const result = await prisma.outreachItem.updateMany({
    where: {
      id,
      profileId: profile.id,
      status: 'APPROVED',
    },
    data: {
      status: 'SENT',
      sentAt: new Date(),
    },
  });

  if (result.count === 0) {
    return reply.code(404).send({ error: 'Not found or invalid status' });
  }

  const updated = await prisma.outreachItem.findUnique({ where: { id } });
  return reply.send(updated);
});

// POST /api/outreach/items/:id/approve - Only allow from DRAFT status
app.post('/api/outreach/items/:id/approve', async (req, reply) => {
  const profile = await requireProfile(req, reply);
  if (!profile) return;
  const { id } = req.params as { id: string };

  const item = await prisma.outreachItem.findUnique({ where: { id } });
  if (!item) return reply.code(404).send({ error: 'Not found' });
  if (item.profileId !== profile.id) return reply.code(403).send({ error: NOT_YOURS });

  // Only allow approving DRAFT items
  if (item.status !== 'DRAFT') {
    return reply.code(400).send({ 
      error: 'Can only approve items in DRAFT status. Current status: ' + item.status 
    });
  }

  const result = await prisma.outreachItem.updateMany({
    where: {
      id,
      profileId: profile.id,
      status: 'DRAFT',
    },
    data: {
      status: 'APPROVED',
      approvedAt: new Date(),
      finalBody: item.finalBody || item.draftBody,
    },
  });

  if (result.count === 0) {
    return reply.code(404).send({ error: 'Not found or invalid status' });
  }

  const updated = await prisma.outreachItem.findUnique({ where: { id } });
  return reply.send(updated);
});
```

---

## Implementation Timeline

### Week 1 (Days 1-7)
- [ ] Fix CRITICAL #1: Cross-tenant data exposure (2 hours)
- [ ] Fix CRITICAL #2: Orphaned browser page leaks (4 hours)
- [ ] Fix CRITICAL #3: Playwright thrashing (3 hours)
- [ ] Add integration tests for security fixes (4 hours)
- [ ] Deploy and monitor for resource leaks (2 hours)

### Week 2 (Days 8-14)
- [ ] Fix HIGH #4: Duplicate draft accumulation (2 hours)
- [ ] Fix HIGH #5: Missing target exclusion filter (2 hours)
- [ ] Fix HIGH #6: Non-deterministic ordering (3 hours)
- [ ] Add data cleanup script for existing duplicates (2 hours)
- [ ] Deploy and verify data integrity (2 hours)

### Week 3-4 (Days 15-28)
- [ ] Fix MEDIUM #7: Fragile regex company extraction (4 hours)
- [ ] Fix MEDIUM #8: Silent scraping truncation (4 hours)
- [ ] Test scraping with large networks (3 hours)
- [ ] Fix LOW #9: State machine violations (3 hours)
- [ ] Add state transition tests (2 hours)
- [ ] Final testing and deployment (4 hours)

---

## Testing Strategy

### Security Tests
- Cross-tenant access attempts for job leads
- Resource leak monitoring during load testing
- Page lifecycle verification during login flows

### Data Integrity Tests
- Duplicate prevention on re-generation
- Target list exclusion verification
- Deterministic ordering with same timestamps

### Functional Tests
- Company name extraction accuracy (edge cases)
- Large network sync completion (>500 connections)
- State transition validation matrix

---

## Monitoring & Alerts

### Add Metrics
- Playwright page count (Gauge)
- Memory usage (Gauge)
- API endpoint response times (Histogram)
- Duplicate outreach item count (Gauge)

### Add Alerts
- Memory usage > 80%
- Playwright page count > 10
- API endpoint latency > 5s (p95)
- Duplicate outreach item creation rate spike

---

## Rollback Plan

For each fix, maintain a copy of the original code. If issues arise:

1. Revert the specific file change
2. Run database migration rollback if needed
3. Restart server
4. Monitor for original issue symptoms

All fixes are backward-compatible except #5 (target exclusion filter), which may affect existing user workflows. Consider adding a feature flag for gradual rollout.

---

## Notes

- All CRITICAL fixes should be reviewed by a second developer before deployment
- Consider implementing a security code review process for future changes
- Add automated security scanning to CI/CD pipeline
- Document security best practices for the team
