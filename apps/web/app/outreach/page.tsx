'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
import { api } from '../../lib/api';
import { showToast } from '../../components/Toast';
import { ConfirmDialog } from '../../components/ConfirmDialog';

interface Contact {
  id: string;
  fullName: string;
  headline: string | null;
  companyName: string;
  profileUrl: string;
  role: string;
  degree: string | null;
}

interface OutreachItem {
  id: string;
  type: 'COLD' | 'REPLY' | 'FOLLOW_UP';
  status: 'DRAFT' | 'APPROVED' | 'SENT' | 'SKIPPED';
  draftBody: string;
  finalBody: string | null;
  charLimit: number;
  contact: Contact;
  jobTitle: string | null;
  companyName: string | null;
  jobUrl: string | null;
  createdAt: string;
  editedAt: string | null;
  approvedAt: string | null;
  sentAt: string | null;
}

interface TabConfig {
  type: TabType;
  label: string;
  count: number;
}

interface ColdTarget {
  id: string;
  fullName: string;
  headline: string | null;
  companyName: string;
  profileUrl: string;
  role: string;
  degree: string | null;
  hasConversation: boolean;
}

type TabType = 'COLD' | 'REPLY' | 'FOLLOW_UP';

export default function OutreachPage() {
  const [activeTab, setActiveTab] = useState<TabType>('COLD');
  const [items, setItems] = useState<OutreachItem[]>([]);
  const [coldTargets, setColdTargets] = useState<ColdTarget[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState<{ connections: any } | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<'NOT_CONNECTED' | 'WAITING_FOR_SIGN_IN' | 'CONNECTED' | 'ERROR'>('NOT_CONNECTED');
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [tabCounts, setTabCounts] = useState<Record<TabType, number>>({ COLD: 0, REPLY: 0, FOLLOW_UP: 0 });
  const [pollErrorCount, setPollErrorCount] = useState(0);
  
  // Refs for race condition prevention
  const activeTabRef = useRef<TabType>('COLD');
  const abortControllerRef = useRef<AbortController | null>(null);
  const MAX_POLL_ERRORS = 5; // Stop after 5 consecutive errors
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: (inputValue?: string) => void;
    showInput?: boolean;
    inputValue?: string;
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
  });

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
        { signal: abortController.signal }
      );
      
      // Only update state if this is still the active tab
      if (activeTabRef.current === requestedTab) {
        setItems(data);

        // Load counts for all tabs
        try {
          const counts = await api<Record<TabType, number>>('/api/outreach/items/counts');
          setTabCounts(counts);
        } catch (countErr) {
          console.error('Failed to load counts:', countErr);
          // Fallback: update count for current tab only
          setTabCounts(prev => ({ ...prev, [activeTab]: data.length }));
        }
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

  const loadColdTargets = useCallback(async () => {
    try {
      const data = await api<ColdTarget[]>('/api/outreach/cold/targets');
      setColdTargets(data);
    } catch (err) {
      console.error('Failed to load cold targets:', err);
    }
  }, []);

  const loadSyncStatus = useCallback(async () => {
    try {
      const data = await api<{ connections: any }>('/api/linkedin/sync/status');
      setSyncStatus(data);
    } catch (err) {
      console.error('Failed to load sync status:', err);
    }
  }, []);

  const loadConnectionStatus = useCallback(async () => {
    try {
      const data = await api<{ status: string }>('/api/linkedin/connection-status');
      setConnectionStatus(data.status as 'NOT_CONNECTED' | 'WAITING_FOR_SIGN_IN' | 'CONNECTED' | 'ERROR');
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
    loadItems();
    if (activeTab === 'COLD') {
      loadColdTargets();
    }
  }, [loadItems, loadColdTargets, activeTab]);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  useEffect(() => {
    loadSyncStatus();
    loadConnectionStatus();
  }, [loadSyncStatus, loadConnectionStatus]);

  // Poll connection status when waiting for sign-in
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

  const handleConnectLinkedIn = async () => {
    try {
      const result = await api<{ status: string; message: string }>('/api/linkedin/connect', { method: 'POST' });
      setConnectionStatus(result.status as 'NOT_CONNECTED' | 'WAITING_FOR_SIGN_IN' | 'CONNECTED' | 'ERROR');
      if (result.status === 'CONNECTED') {
        await loadSyncStatus();
        await loadColdTargets();
        showToast('LinkedIn connected successfully', 'success');
      }
    } catch (err) {
      console.error('Failed to connect LinkedIn:', err);
      showToast('Failed to open LinkedIn. Check console for details.', 'error');
    }
  };

  const handleSyncConnections = async () => {
    try {
      await api('/api/linkedin/sync/connections', { method: 'POST' });
      await loadSyncStatus();
      await loadColdTargets();
      showToast('Connections synced successfully', 'success');
    } catch (err) {
      console.error('Failed to sync connections:', err);
      showToast('Failed to sync connections. Check console for details.', 'error');
    }
  };

  const handleGenerateCold = async () => {
    // No selection means all eligible contacts, which is the common outreach flow.
    const selectedBefore = selectedTargets.size > 0
      ? Array.from(selectedTargets)
      : coldTargets.map(target => target.id);
    if (selectedBefore.length === 0) return;
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

  const handleEdit = (item: OutreachItem) => {
    setEditingItem(item.id);
    setEditText(item.finalBody || item.draftBody);
  };

  const handleSaveEdit = async (itemId: string) => {
    try {
      await api(`/api/outreach/items/${itemId}`, {
        method: 'PUT',
        body: JSON.stringify({ finalBody: editText }),
      });
      setEditingItem(null);
      await loadItems();
      showToast('Message saved successfully', 'success');
    } catch (err) {
      console.error('Failed to save edit:', err);
      showToast('Failed to save edit.', 'error');
    }
  };

  const handleCancelEdit = () => {
    setEditingItem(null);
    setEditText('');
  };

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

  const handleOpenLinkedIn = (profileUrl: string) => {
    window.open(profileUrl, '_blank');
  };

  const handleApprove = async (itemId: string) => {
    try {
      await api(`/api/outreach/items/${itemId}/approve`, { method: 'POST' });
      await loadItems();
      showToast('Message approved', 'success');
    } catch (err) {
      console.error('Failed to approve:', err);
      showToast('Failed to approve item.', 'error');
    }
  };

  const handleSkip = async (itemId: string) => {
    setConfirmDialog({
      isOpen: true,
      title: 'Skip this message',
      message: 'Add a reason for skipping (optional):',
      onConfirm: async (inputValue?: string) => {
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
      showInput: true,
      inputValue: '',
    });
  };

  const handleMarkSent = async (itemId: string) => {
    try {
      await api(`/api/outreach/items/${itemId}/mark-sent`, { method: 'POST' });
      await loadItems();
      showToast('Message sent on LinkedIn', 'success');
    } catch (err) {
      console.error('Failed to mark as sent:', err);
      showToast('Failed to mark as sent.', 'error');
    }
  };

  const toggleTargetSelection = (targetId: string) => {
    setSelectedTargets((prev) => {
      const next = new Set(prev);
      if (next.has(targetId)) {
        next.delete(targetId);
      } else {
        next.add(targetId);
      }
      return next;
    });
  };

  const currentBody = (item: OutreachItem) => item.finalBody || item.draftBody;
  const isOverLimit = (item: OutreachItem) => currentBody(item).length > item.charLimit;

  return (
    <div className="panel">
      <h1>Outreach Queue</h1>

      <Tabs activeTab={activeTab} onTabChange={setActiveTab} tabCounts={tabCounts} />
      
      <ConfirmDialog
        isOpen={confirmDialog.isOpen}
        title={confirmDialog.title}
        message={confirmDialog.message}
        showInput={confirmDialog.showInput}
        inputValue={confirmDialog.inputValue}
        onInputChange={(value) => setConfirmDialog(prev => ({ ...prev, inputValue: value }))}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog({ isOpen: false, title: '', message: '', onConfirm: () => {} })}
      />

      {activeTab === 'COLD' && (
        <div style={{ marginTop: '1rem' }}>
          {connectionStatus === 'WAITING_FOR_SIGN_IN' && (
            <div style={{ 
              padding: '0.75rem', 
              background: 'var(--warn-soft)', 
              border: '1px solid var(--warn-border)', 
              borderRadius: 'var(--radius)', 
              marginBottom: '1rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}>
              <span style={{ fontSize: '1.2rem' }}>🔗</span>
              <div>
                <strong>LinkedIn sign-in window opened</strong> — Sign in there to connect your account.
              </div>
            </div>
          )}
          
          {connectionStatus === 'ERROR' && (
            <div style={{ 
              padding: '0.75rem', 
              background: 'var(--bad-soft)', 
              border: '1px solid var(--bad-border)', 
              borderRadius: 'var(--radius)', 
              marginBottom: '1rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}>
              <span style={{ fontSize: '1.2rem' }}>⚠️</span>
              <div>
                <strong>Connection check failed</strong> — Please refresh the page to try again.
              </div>
            </div>
          )}
          
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', alignItems: 'center' }}>
            {connectionStatus === 'NOT_CONNECTED' && (
              <button className="primary" onClick={handleConnectLinkedIn}>
                Connect LinkedIn
              </button>
            )}
            {connectionStatus === 'CONNECTED' && (
              <>
                <button onClick={handleSyncConnections}>
                  Sync Connections
                </button>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ color: 'var(--good)', fontSize: '1.2rem' }}>✓</span>
                  <span className="small muted" style={{ color: 'var(--good)' }}>
                    LinkedIn connected
                  </span>
                </div>
                {syncStatus?.connections && (
                  <span className="small muted">
                    Last synced: {syncStatus.connections.lastSyncAt 
                      ? new Date(syncStatus.connections.lastSyncAt).toLocaleString()
                      : 'Never'}
                  </span>
                )}
              </>
            )}
          </div>

          {coldTargets.length > 0 && (
            <div style={{ marginBottom: '1rem', padding: '1rem', background: 'var(--panel-2)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
              <div style={{ marginBottom: '0.75rem' }}>
                <strong style={{ fontSize: '1rem' }}>{coldTargets.length} contacts found</strong>
                <div className="small muted" style={{ marginTop: '0.25rem' }}>
                  Select people → Generate messages → Review messages
                </div>
              </div>
              
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <button 
                  onClick={() => setSelectedTargets(new Set(coldTargets.map(t => t.id)))}
                  disabled={selectedTargets.size === coldTargets.length}
                  className="small"
                >
                  Select All
                </button>
                <button 
                  onClick={() => setSelectedTargets(new Set())}
                  disabled={coldTargets.length === 0}
                  className="small"
                >
                  Clear Selection
                </button>
                <div style={{ flex: 1 }} />
                <span className="small muted" style={{ marginRight: '0.5rem' }}>
                  {selectedTargets.size} selected
                </span>
                <button 
                  className="primary"
                  onClick={handleGenerateCold}
                  disabled={selectedTargets.size === 0}
                >
                  {selectedTargets.size > 0 ? 'Generate selected' : 'Generate for all'}
                </button>
              </div>
              
              <div style={{ maxHeight: '200px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                {coldTargets.map((target) => (
                  <div
                    key={target.id}
                    style={{
                      padding: '0.75rem',
                      borderBottom: '1px solid var(--border)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.75rem',
                      background: selectedTargets.has(target.id) ? 'var(--accent-soft)' : 'transparent',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedTargets.has(target.id)}
                      onChange={() => toggleTargetSelection(target.id)}
                      style={{ width: '18px', height: '18px' }}
                    />
                    <div style={{ flex: 1 }}>
                      <strong style={{ fontSize: '0.95rem' }}>{target.fullName}</strong>
                      <div className="small muted" style={{ marginTop: '0.15rem' }}>
                        {target.role === 'TALENT' ? 'Recruiter' : target.role === 'ENGINEERING' ? 'Engineering Manager' : target.role} at {target.companyName}
                      </div>
                      <div className="small muted" style={{ marginTop: '0.05rem' }}>
                        {target.degree ? `${target.degree}-degree connection` : 'Connection'} • {target.hasConversation ? 'has previous conversation' : 'no previous conversation'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <p>Loading...</p>
      ) : items.length === 0 ? (
        <p className="muted">No {activeTab.toLowerCase()} outreach items.</p>
      ) : (
        <div style={{ marginTop: '1rem' }}>
          {items.map((item) => (
            <OutreachItemCard
              key={item.id}
              item={item}
              isEditing={editingItem === item.id}
              editText={editText}
              onEditChange={setEditText}
              onEditStart={() => handleEdit(item)}
              onEditSave={() => handleSaveEdit(item.id)}
              onEditCancel={handleCancelEdit}
              onCopy={() => handleCopy(currentBody(item))}
              onOpenLinkedIn={() => handleOpenLinkedIn(item.contact.profileUrl)}
              onApprove={() => handleApprove(item.id)}
              onSkip={() => handleSkip(item.id)}
              onMarkSent={() => handleMarkSent(item.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Tabs({ activeTab, onTabChange, tabCounts }: { activeTab: TabType; onTabChange: (tab: TabType) => void; tabCounts: Record<TabType, number> }) {
  const tabs: { type: TabType; label: string }[] = [
    { type: 'COLD', label: 'Cold outreach' },
    { type: 'REPLY', label: 'Replies' },
    { type: 'FOLLOW_UP', label: 'Follow-ups' },
  ];
  
  return (
    <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.5rem' }}>
      {tabs.map((tab) => (
        <button
          key={tab.type}
          onClick={() => onTabChange(tab.type)}
          style={{
            padding: '0.5rem 1rem',
            background: activeTab === tab.type ? 'var(--accent-soft)' : 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontWeight: activeTab === tab.type ? '600' : 'normal',
            color: activeTab === tab.type ? 'var(--accent)' : 'var(--text)',
            borderRadius: 'var(--radius-sm)',
            transition: 'background var(--fast) var(--ease), color var(--fast) var(--ease)',
          }}
        >
          {tab.label}
          {tabCounts[tab.type] > 0 && (
            <span style={{ 
              marginLeft: '0.4rem', 
              fontSize: '0.75rem', 
              opacity: 0.7,
              background: activeTab === tab.type ? 'var(--accent)' : 'var(--border)',
              color: activeTab === tab.type ? 'var(--accent-contrast)' : 'var(--muted)',
              padding: '0.1rem 0.4rem',
              borderRadius: '999px',
            }}>
              {tabCounts[tab.type]}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function OutreachItemCard({
  item,
  isEditing,
  editText,
  onEditChange,
  onEditStart,
  onEditSave,
  onEditCancel,
  onCopy,
  onOpenLinkedIn,
  onApprove,
  onSkip,
  onMarkSent,
}: {
  item: OutreachItem;
  isEditing: boolean;
  editText: string;
  onEditChange: (text: string) => void;
  onEditStart: () => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  onCopy: () => void;
  onOpenLinkedIn: () => void;
  onApprove: () => void;
  onSkip: () => void;
  onMarkSent: () => void;
}) {
  const currentBody = item.finalBody || item.draftBody;
  const isOverLimit = currentBody.length > item.charLimit;

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '1rem',
        marginBottom: '1rem',
        background: isOverLimit ? 'var(--bad-soft)' : 'var(--panel-2)',
      }}
    >
      <div style={{ marginBottom: '0.5rem' }}>
        <strong style={{ fontSize: '1rem' }}>{item.contact.fullName}</strong>
        <div className="small muted" style={{ marginTop: '0.1rem' }}>
          {item.contact.headline || item.contact.role} · {item.contact.companyName}
        </div>
        <div className="small muted" style={{ marginTop: '0.1rem' }}>
          {item.contact.degree ? `${item.contact.degree}-degree connection` : 'Connection'}
        </div>
      </div>

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
              disabled={editText.length > item.charLimit}
            >
              Save
            </button>
            <button onClick={onEditCancel}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ marginBottom: '0.5rem' }}>
          <div
            style={{
              padding: '0.75rem',
              background: 'var(--bg-subtle)',
              borderRadius: 'var(--radius-sm)',
              whiteSpace: 'pre-wrap',
              fontFamily: 'monospace',
              border: '1px solid var(--border)',
            }}
          >
            {currentBody}
          </div>
          <div className="small muted" style={{ marginTop: '0.25rem' }}>
            {currentBody.length} / {item.charLimit} characters
            {isOverLimit && <span style={{ color: 'var(--bad)', marginLeft: '0.5rem' }}>OVER LIMIT</span>}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {!isEditing && item.status === 'DRAFT' && (
          <button onClick={onEditStart}>Edit</button>
        )}
        <button className="ghost small" onClick={onCopy}>Copy</button>
        <button className="ghost small" onClick={onOpenLinkedIn}>Open profile</button>
        {item.status === 'DRAFT' && (
          <>
            <button className="primary" onClick={onApprove}>Approve</button>
            <button className="ghost" onClick={onSkip}>Skip</button>
          </>
        )}
        {item.status === 'APPROVED' && (
          <button className="primary" onClick={onMarkSent}>Send on LinkedIn</button>
        )}
      </div>

      {item.status === 'SENT' && (
        <div className="small muted" style={{ marginTop: '0.5rem' }}>
          Sent at {item.sentAt ? new Date(item.sentAt).toLocaleString() : 'Unknown'}
        </div>
      )}
    </div>
  );
}
