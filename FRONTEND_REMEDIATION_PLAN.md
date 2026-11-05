# Frontend Remediation Plan - OutreachPage Component

## Executive Summary

This document outlines bugs, race conditions, stale closures, and UI flaws in the OutreachPage component (`apps/web/app/outreach/page.tsx`) with specific implementation guidance.

---

## Priority Level Definitions

- **CRITICAL**: Data loss or broken user workflows. Fix immediately.
- **HIGH**: Poor UX or functional issues. Fix within 1 week.
- **MEDIUM**: Reliability issues. Fix within 2 weeks.

---

## CRITICAL Issues (Fix Immediately)

### 1. Stale Closure Bug in ConfirmDialog / handleSkip
**Severity**: CRITICAL  
**File**: `apps/web/app/outreach/page.tsx`  
**Lines**: 245-267

**Bug**:
```typescript
const handleSkip = async (itemId: string) => {
  setConfirmDialog({
    isOpen: true,
    title: 'Skip this message',
    message: 'Add a reason for skipping (optional):',
    onConfirm: async () => {
      try {
        await api(`/api/outreach/items/${itemId}/skip`, {
          method: 'POST',
          body: JSON.stringify({ reason: confirmDialog.inputValue?.trim() }), // STALE CLOSURE
        });
```

**Impact**: The `onConfirm` callback captures the initial `confirmDialog` state (where `inputValue` is ""). When user types a reason, the callback still reads the stale empty string, so the reason is never sent to the server.

**Fix**:
```typescript
const handleSkip = async (itemId: string) => {
  setConfirmDialog({
    isOpen: true,
    title: 'Skip this message',
    message: 'Add a reason for skipping (optional):',
    showInput: true,
    inputValue: '',
    onConfirm: async (inputValue?: string) => { // PASS VALUE AS PARAMETER
      try {
        await api(`/api/outreach/items/${itemId}/skip`, {
          method: 'POST',
          body: JSON.stringify({ reason: inputValue?.trim() }),
        });
        await loadItems();
        showToast('Message skipped', 'info');
        setConfirmDialog({ isOpen: false, title: '', message: '', onConfirm: () => {} });
      } catch (err) {
        console.error('Failed to skip:', err);
        showToast('Failed to skip item.', 'error');
      }
    },
  });
};
```

**Also update ConfirmDialog component** to pass the input value to onConfirm:
```typescript
// In ConfirmDialog component, update the confirm handler:
const handleConfirm = () => {
  onConfirm(inputValue); // PASS THE CURRENT VALUE
  onClose();
};
```

---

### 2. Guaranteed 404 API Endpoint Error
**Severity**: CRITICAL  
**File**: `apps/web/app/outreach/page.tsx`  
**Lines**: 85-94

**Bug**:
```typescript
try {
  const counts = await api<Record<TabType, number>>('/api/outreach/items/counts');
  setTabCounts(counts);
} catch (countErr) {
  console.warn('Failed to load counts, using local data:', countErr);
  setTabCounts(prev => ({ ...prev, [activeTab]: data.length })); // ONLY UPDATES ACTIVE TAB
}
```

**Impact**: The `/api/outreach/items/counts` endpoint doesn't exist on the server. This fails every time, and the fallback only updates the count for the active tab, leaving other tabs with inaccurate or zero counts.

**Fix Option 1** (Backend - Add the endpoint):
```typescript
// In apps/server/src/routes/outreach.ts, add:
app.get('/api/outreach/items/counts', async (req, reply) => {
  const profile = await requireProfile(req, reply);
  if (!profile) return;
  
  const [cold, reply, followUp] = await Promise.all([
    prisma.outreachItem.count({
      where: { profileId: profile.id, type: 'COLD' },
    }),
    prisma.outreachItem.count({
      where: { profileId: profile.id, type: 'REPLY' },
    }),
    prisma.outreachItem.count({
      where: { profileId: profile.id, type: 'FOLLOW_UP' },
    }),
  ]);

  return reply.send({ COLD: cold, REPLY: reply, FOLLOW_UP: followUp });
});
```

**Fix Option 2** (Frontend - Remove the non-existent endpoint and count locally):
```typescript
const loadItems = useCallback(async () => {
  setLoading(true);
  try {
    const data = await api<OutreachItem[]>(`/api/outreach/items?type=${activeTab}`);
    setItems(data);
    
    // Update count for current tab
    setTabCounts(prev => ({ ...prev, [activeTab]: data.length }));
  } catch (err) {
    console.error('Failed to load items:', err);
  }
  setLoading(false);
}, [activeTab]);

// Add a separate function to load all tab counts
const loadAllTabCounts = useCallback(async () => {
  try {
    const [cold, reply, followUp] = await Promise.all([
      api<OutreachItem[]>('/api/outreach/items?type=COLD'),
      api<OutreachItem[]>('/api/outreach/items?type=REPLY'),
      api<OutreachItem[]>('/api/outreach/items?type=FOLLOW_UP'),
    ]);
    setTabCounts({
      COLD: cold.length,
      REPLY: reply.length,
      FOLLOW_UP: followUp.length,
    });
  } catch (err) {
    console.error('Failed to load tab counts:', err);
  }
}, []);

// Call loadAllTabCounts on initial load
useEffect(() => {
  loadAllTabCounts();
}, [loadAllTabCounts]);
```

**Recommendation**: Use Fix Option 1 (add backend endpoint) for better performance.

---

### 3. Asynchronous Race Condition on Tab Switching
**Severity**: CRITICAL  
**File**: `apps/web/app/outreach/page.tsx`  
**Lines**: 79-99, 128-133

**Bug**:
```typescript
const loadItems = useCallback(async () => {
  setLoading(true);
  try {
    const data = await api<OutreachItem[]>(`/api/outreach/items?type=${activeTab}`);
    setItems(data); // NO REQUEST CANCELLATION
```

**Impact**: Rapid tab switching dispatches multiple requests. If responses arrive out of order, slower responses overwrite state with incorrect data.

**Fix**:
```typescript
import { useCallback, useEffect, useState, useRef } from 'react';

export default function OutreachPage() {
  // ... existing state ...
  
  // Add ref to track active request
  const activeTabRef = useRef<TabType>('COLD');
  const abortControllerRef = useRef<AbortController | null>(null);

  const loadItems = useCallback(async () => {
    // Cancel any in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    
    // Create new abort controller for this request
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    
    // Track which tab this request is for
    const requestedTab = activeTab;
    activeTabRef.current = requestedTab;
    
    setLoading(true);
    try {
      const data = await api<OutreachItem[]>(
        `/api/outreach/items?type=${activeTab}`,
        { signal: abortController.signal } // PASS ABORT SIGNAL
      );
      
      // Only update state if this is still the active tab
      if (activeTabRef.current === requestedTab) {
        setItems(data);
        setTabCounts(prev => ({ ...prev, [activeTab]: data.length }));
      }
    } catch (err) {
      // Ignore aborted requests
      if (err instanceof Error && err.name === 'AbortError') {
        return;
      }
      console.error('Failed to load items:', err);
    } finally {
      if (activeTabRef.current === requestedTab) {
        setLoading(false);
      }
      abortControllerRef.current = null;
    }
  }, [activeTab]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);
```

**Also update the api function** to support abort signals:
```typescript
// In apps/web/lib/api.ts, update the api function:
export async function api<T>(
  url: string,
  options: RequestInit & { signal?: AbortSignal } = {}
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }
  return response.json();
}
```

---

### 4. Premature Selection Wipe on Batch Generation Errors
**Severity**: CRITICAL  
**File**: `apps/web/app/outreach/page.tsx`  
**Lines**: 177-199

**Bug**:
```typescript
const handleGenerateCold = async () => {
  // ...
  const result = await api<...>('/api/outreach/cold/generate', { ... });
  setSelectedTargets(new Set()); // CLEARED BEFORE CHECKING ERRORS
  await loadItems();
  await loadColdTargets();
  if (result.errors.length > 0) { // TOO LATE - SELECTION ALREADY CLEARED
    showToast(`Generated ${result.created.length} items. ${result.errors.length} failed.`, 'error');
  }
```

**Impact**: If generation fails for some contacts, the user's selection is cleared before they can see which ones failed, forcing manual re-selection.

**Fix**:
```typescript
const handleGenerateCold = async () => {
  if (selectedTargets.size === 0) {
    showToast('Select at least one contact to generate outreach for.', 'error');
    return;
  }
  
  const selectedBefore = Array.from(selectedTargets); // PRESERVE SELECTION
  try {
    const result = await api<{ created: Array<{ id: string; contactId: string }>; errors: Array<{ contactId: string; error: string }> }>('/api/outreach/cold/generate', {
      method: 'POST',
      body: JSON.stringify({ contactIds: selectedBefore }),
    });
    
    // Only clear selection if there were no errors
    if (result.errors.length === 0) {
      setSelectedTargets(new Set());
      showToast(`Generated ${result.created.length} messages successfully`, 'success');
    } else {
      // Keep only the failed contacts selected for retry
      const failedContactIds = new Set(result.errors.map(e => e.contactId));
      setSelectedTargets(failedContactIds);
      showToast(`Generated ${result.created.length} items. ${result.errors.length} failed. Failed contacts remain selected for retry.`, 'error');
    }
    
    await loadItems();
    await loadColdTargets();
  } catch (err) {
    console.error('Failed to generate outreach:', err);
    showToast('Failed to generate outreach. Check console for details.', 'error');
    // Don't clear selection on error - let user retry
  }
};
```

---

## HIGH Priority Issues (Fix Within 1 Week)

### 5. Unguarded Clipboard Access (handleCopy)
**Severity**: HIGH  
**File**: `apps/web/app/outreach/page.tsx`  
**Lines**: 226-228

**Bug**:
```typescript
const handleCopy = (text: string) => {
  navigator.clipboard.writeText(text); // NO ERROR HANDLING
};
```

**Impact**: Throws uncaught TypeError in non-secure contexts (HTTP, embedded webviews). No visual feedback on success/failure.

**Fix**:
```typescript
const handleCopy = async (text: string) => {
  try {
    // Check if clipboard API is available
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      // Fallback for older browsers or non-secure contexts
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand('copy');
        showToast('Copied to clipboard', 'success');
      } catch (fallbackErr) {
        showToast('Failed to copy to clipboard', 'error');
      }
      document.body.removeChild(textArea);
      return;
    }
    
    // Use modern clipboard API
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard', 'success');
  } catch (err) {
    console.error('Failed to copy:', err);
    showToast('Failed to copy to clipboard', 'error');
  }
};
```

---

### 6. Missing Dynamic Character Limit Warning During Edits
**Severity**: HIGH  
**File**: `apps/web/app/outreach/page.tsx`  
**Lines**: 556-567, 533-535

**Bug**:
```typescript
{isEditing ? (
  <div style={{ marginBottom: '0.5rem' }}>
    <textarea
      value={editText}
      onChange={(e) => onEditChange(e.target.value)}
      style={{ width: '100%', minHeight: '100px', fontFamily: 'monospace' }}
    />
    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
      <button onClick={onEditSave}>Save</button>
      <button onClick={onEditCancel}>Cancel</button>
    </div>
  </div>
) : (
  // ... character count shown here, but not during editing
```

**Impact**: While editing, user can't see live character count or over-limit warning until after saving.

**Fix**:
```typescript
{isEditing ? (
  <div style={{ marginBottom: '0.5rem' }}>
    <textarea
      value={editText}
      onChange={(e) => onEditChange(e.target.value)}
      style={{ width: '100%', minHeight: '100px', fontFamily: 'monospace' }}
    />
    <div className="small muted" style={{ marginTop: '0.25rem' }}>
      {editText.length} / {item.charLimit} characters
      {editText.length > item.charLimit && (
        <span style={{ color: 'var(--bad)', marginLeft: '0.5rem' }}>OVER LIMIT</span>
      )}
    </div>
    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
      <button 
        onClick={onEditSave}
        disabled={editText.length > item.charLimit} // DISABLE SAVE IF OVER LIMIT
      >
        Save
      </button>
      <button onClick={onEditCancel}>Cancel</button>
    </div>
  </div>
) : (
```

---

## MEDIUM Priority Issues (Fix Within 2 Weeks)

### 7. Infinite Polling on Server Failures
**Severity**: MEDIUM  
**File**: `apps/web/app/outreach/page.tsx`  
**Lines**: 141-148

**Bug**:
```typescript
useEffect(() => {
  if (connectionStatus === 'WAITING_FOR_SIGN_IN') {
    const interval = setInterval(() => {
      loadConnectionStatus(); // NO ERROR HANDLING IN POLLING
    }, 2000);
    return () => clearInterval(interval);
  }
}, [connectionStatus, loadConnectionStatus]);
```

**Impact**: If server returns 500 or network timeout, polling continues indefinitely, spamming the failing server.

**Fix**:
```typescript
const [pollErrorCount, setPollErrorCount] = useState(0);
const MAX_POLL_ERRORS = 5; // Stop after 5 consecutive errors

const loadConnectionStatus = useCallback(async () => {
  try {
    const data = await api<{ status: string }>('/api/linkedin/connection-status');
    setConnectionStatus(data.status);
    setPollErrorCount(0); // Reset error count on success
  } catch (err) {
    console.error('Failed to load connection status:', err);
    setPollErrorCount(prev => prev + 1);
    
    // Stop polling after too many errors
    if (pollErrorCount >= MAX_POLL_ERRORS - 1) {
      setConnectionStatus('ERROR');
      showToast('Connection check failed repeatedly. Please refresh the page.', 'error');
    }
  }
}, [pollErrorCount]);

useEffect(() => {
  if (connectionStatus === 'WAITING_FOR_SIGN_IN') {
    const interval = setInterval(() => {
      // Don't poll if we've hit the error limit
      if (pollErrorCount < MAX_POLL_ERRORS) {
        loadConnectionStatus();
      }
    }, 2000);
    return () => clearInterval(interval);
  }
}, [connectionStatus, loadConnectionStatus, pollErrorCount]);
```

**Additional enhancement**: Add exponential backoff:
```typescript
const [pollInterval, setPollInterval] = useState(2000);

useEffect(() => {
  if (connectionStatus === 'WAITING_FOR_SIGN_IN' && pollErrorCount < MAX_POLL_ERRORS) {
    // Exponential backoff: 2s, 4s, 8s, 16s, 32s
    const backoffInterval = Math.min(2000 * Math.pow(2, pollErrorCount), 32000);
    
    const interval = setInterval(() => {
      loadConnectionStatus();
    }, backoffInterval);
    
    return () => clearInterval(interval);
  }
}, [connectionStatus, loadConnectionStatus, pollErrorCount]);
```

---

## Implementation Timeline

### Day 1 (4 hours)
- [ ] Fix CRITICAL #1: Stale closure in handleSkip (1 hour)
- [ ] Fix CRITICAL #2: Add backend counts endpoint (1 hour)
- [ ] Fix CRITICAL #3: Add AbortController for race conditions (1.5 hours)
- [ ] Fix CRITICAL #4: Preserve selection on errors (0.5 hours)

### Day 2 (2 hours)
- [ ] Fix HIGH #5: Guard clipboard access (1 hour)
- [ ] Fix HIGH #6: Add live character count during edits (1 hour)

### Day 3 (1 hour)
- [ ] Fix MEDIUM #7: Add polling error handling with backoff (1 hour)

### Day 4 (2 hours)
- [ ] Comprehensive testing of all fixes
- [ ] Verify no regressions
- [ ] Deploy to staging for user testing

---

## Testing Strategy

### Manual Testing
- **Stale closure**: Type a skip reason, confirm it's sent to server
- **Counts endpoint**: Verify all tab badges show correct numbers
- **Race condition**: Rapidly switch tabs, verify correct data displays
- **Selection preservation**: Generate with errors, verify failed contacts remain selected
- **Clipboard**: Test copy in HTTP and HTTPS contexts
- **Character count**: Edit message, verify live count updates
- **Polling**: Simulate server failure, verify polling stops

### Automated Tests
- Add unit tests for handleSkip with mock confirmDialog
- Add integration tests for tab switching race conditions
- Add E2E tests for batch generation error handling

---

## Rollback Plan

Each fix is self-contained and can be reverted independently:
1. Revert the specific file change
2. Restart the development server
3. Verify the original issue is the only side effect

All fixes are backward-compatible with existing data.
