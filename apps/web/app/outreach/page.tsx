'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import ConnectionsList from './ConnectionsList';

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

interface ColdTarget {
  id: string;
  fullName: string;
  headline: string | null;
  companyName: string;
  profileUrl: string;
  role: string;
  degree: string | null;
  hasConversation: boolean;
  jobLeadId: string | null;
  jobTitle: string | null;
  jobUrl: string | null;
}

type TabType = 'COLD' | 'REPLY' | 'FOLLOW_UP';

export default function OutreachPage() {
  const [activeTab, setActiveTab] = useState<TabType>('COLD');
  const [items, setItems] = useState<OutreachItem[]>([]);
  const [coldTargets, setColdTargets] = useState<ColdTarget[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState<{ connections: any } | null>(null);
  const [hasProfile, setHasProfile] = useState<boolean | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncingMessages, setSyncingMessages] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [connectionsRefresh, setConnectionsRefresh] = useState(0);
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<OutreachItem[]>(`/api/outreach/items?type=${activeTab}`);
      setItems(data);
    } catch (err) {
      console.error('Failed to load items:', err);
    }
    setLoading(false);
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

  useEffect(() => {
    loadItems();
    if (activeTab === 'COLD') {
      loadColdTargets();
    }
  }, [loadItems, loadColdTargets, activeTab]);

  useEffect(() => {
    loadSyncStatus();
  }, [loadSyncStatus]);

  useEffect(() => {
    api<{ profile: { id: string } | null }>('/api/profile')
      .then(({ profile }) => setHasProfile(Boolean(profile)))
      .catch((err) => setSyncMessage(err instanceof Error ? err.message : 'Could not load your profile.'));
  }, []);

  const handleSyncConnections = async () => {
    if (!hasProfile || syncing) return;
    setSyncing(true);
    setSyncMessage(null);
    try {
      const result = await api<{ synced: number; errors: string[] }>('/api/linkedin/sync/connections', { method: 'POST' });
      setSyncMessage(result.errors.length
        ? `Synced ${result.synced} connections. ${result.errors.join(' ')}`
        : `Synced and categorized ${result.synced} connections.`);
      await loadSyncStatus();
      await loadColdTargets();
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : 'Failed to sync connections.');
    } finally {
      setSyncing(false);
      setConnectionsRefresh((value) => value + 1);
    }
  };

  /**
   * Import the message history.
   *
   * Separate from the connection sync because it is much slower - it opens
   * every thread - and because the two answer different questions. Connections
   * says who you know; this says who you have actually spoken to, which is what
   * puts someone under "Your turn" instead of "Not contacted".
   */
  const handleSyncMessages = async () => {
    if (!hasProfile || syncingMessages) return;
    setSyncingMessages(true);
    setSyncMessage(null);
    try {
      const result = await api<{ threads: number; messages: number; unmatched: number; errors: string[] }>(
        '/api/linkedin/sync/messages', { method: 'POST' },
      );
      setSyncMessage(
        `Read ${result.messages} messages across ${result.threads} conversations.` +
        (result.unmatched ? ` ${result.unmatched} threads were with people who are not connections, so they were skipped.` : '') +
        (result.errors.length ? ` ${result.errors.length} could not be saved.` : ''),
      );
      await loadSyncStatus();
      setConnectionsRefresh((value) => value + 1);
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : 'Failed to sync messages.');
    } finally {
      setSyncingMessages(false);
    }
  };

  const handleGenerateCold = async () => {
    if (selectedTargets.size === 0) {
      alert('Select at least one contact to generate outreach for.');
      return;
    }
    try {
      const result = await api<{ created: Array<{ id: string; contactId: string }>; errors: Array<{ contactId: string; error: string }> }>('/api/outreach/cold/generate', {
        method: 'POST',
        body: JSON.stringify({ contactIds: Array.from(selectedTargets) }),
      });
      setSelectedTargets(new Set());
      await loadItems();
      await loadColdTargets();
      if (result.errors.length > 0) {
        alert(`Generated ${result.created.length} items. ${result.errors.length} failed.`);
      }
    } catch (err) {
      console.error('Failed to generate outreach:', err);
      alert('Failed to generate outreach. Check console for details.');
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
    } catch (err) {
      console.error('Failed to save edit:', err);
      alert('Failed to save edit.');
    }
  };

  const handleCancelEdit = () => {
    setEditingItem(null);
    setEditText('');
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const handleOpenLinkedIn = (profileUrl: string) => {
    window.open(profileUrl, '_blank');
  };

  const handleApprove = async (itemId: string) => {
    try {
      await api(`/api/outreach/items/${itemId}/approve`, { method: 'POST' });
      await loadItems();
    } catch (err) {
      console.error('Failed to approve:', err);
      alert('Failed to approve item.');
    }
  };

  const handleSkip = async (itemId: string) => {
    const reason = prompt('Reason for skipping (optional):');
    try {
      await api(`/api/outreach/items/${itemId}/skip`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      await loadItems();
    } catch (err) {
      console.error('Failed to skip:', err);
      alert('Failed to skip item.');
    }
  };

  const handleMarkSent = async (itemId: string) => {
    try {
      await api(`/api/outreach/items/${itemId}/mark-sent`, { method: 'POST' });
      await loadItems();
      alert('Message and resume sent on LinkedIn.');
    } catch (err) {
      console.error('Failed to mark as sent:', err);
      alert('LinkedIn did not send the message. Nothing was marked as sent.');
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
      <div className="panel-head">
        <div>
          <h2>Outreach</h2>
          <p className="sub">
            Messages to people at the companies you are applying to — drafted here, approved by
            you, never sent on their own.
          </p>
        </div>
        <Tabs activeTab={activeTab} onTabChange={setActiveTab} />
      </div>

      {activeTab === 'COLD' && (
        <div style={{ marginTop: '1rem' }}>
          {hasProfile === false && (
            <p role="status">
              Create your Job Applier profile before syncing LinkedIn connections.{' '}
              <a href="/profile">Set up your profile</a>, or sign in to the account with your existing profile.
            </p>
          )}
          {syncMessage && <p role="status">{syncMessage}</p>}
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
            <button onClick={handleSyncConnections} disabled={!hasProfile || syncing}>
              {syncing ? 'Syncing connections…' : 'Sync Connections'}
            </button>
            <button onClick={handleSyncMessages} disabled={!hasProfile || syncingMessages}>
              {syncingMessages ? 'Reading conversations…' : 'Sync Messages'}
            </button>
            {syncStatus?.connections && (
              <span className="small muted">
                Last synced: {syncStatus.connections.lastSyncAt 
                  ? new Date(syncStatus.connections.lastSyncAt).toLocaleString()
                  : 'Never'}
                {' '}({syncStatus.connections.status})
              </span>
            )}
          </div>

          {hasProfile && (
            <ConnectionsList
              refreshKey={connectionsRefresh}
              onDrafted={() => { setActiveTab('COLD'); loadItems(); }}
            />
          )}

          {coldTargets.length > 0 && (
            <div style={{ marginBottom: '1rem', padding: '1rem', background: 'var(--panel-2)', borderRadius: '4px' }}>
              <div style={{ marginBottom: '0.5rem' }}>
                <strong>{coldTargets.length} cold targets available</strong>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <button 
                  onClick={() => setSelectedTargets(new Set(coldTargets.map(t => t.id)))}
                  disabled={selectedTargets.size === coldTargets.length}
                >
                  Select All
                </button>
                <button 
                  onClick={() => setSelectedTargets(new Set())}
                  disabled={selectedTargets.size === 0}
                >
                  Clear Selection
                </button>
                <button 
                  onClick={handleGenerateCold}
                  disabled={selectedTargets.size === 0}
                >
                  Generate ({selectedTargets.size})
                </button>
              </div>
              <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                {coldTargets.map((target) => (
                  <div
                    key={target.id}
                    style={{
                      padding: '0.5rem',
                      borderBottom: '1px solid var(--border)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selectedTargets.has(target.id)}
                      onChange={() => toggleTargetSelection(target.id)}
                    />
                    <div style={{ flex: 1 }}>
                      <strong>{target.fullName}</strong>
                      <div className="small muted">
                        {target.role === 'TALENT' ? 'Recruiter' : target.role === 'ENGINEERING' ? 'Engineering Manager' : target.role} at {target.companyName}
                      </div>
                      <div className="small muted">
                        {target.degree ? `${target.degree}-degree connection` : 'Connection'} • {target.hasConversation ? 'has previous conversation' : 'no previous conversation'}
                      </div>
                      <div className="small muted">
                        {target.jobTitle
                          ? `Matched job: ${target.jobTitle}`
                          : 'No matching job yet; the career page will be checked when generating'}
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
        <div className="empty-state">
          {activeTab === 'COLD'
            ? 'Nothing to send yet. Sync your connections to find people worth writing to.'
            : activeTab === 'REPLY'
              ? 'No replies waiting. Anyone who answers you appears here.'
              : 'No follow-ups due. One appears when a message has gone unanswered long enough.'}
        </div>
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

/** The enum names are how the database spells it, not how a person reads it. */
const TAB_LABEL: Record<TabType, string> = {
  COLD: 'First contact',
  REPLY: 'Replies',
  FOLLOW_UP: 'Follow-ups',
};

function Tabs({ activeTab, onTabChange }: { activeTab: TabType; onTabChange: (tab: TabType) => void }) {
  const tabs: TabType[] = ['COLD', 'REPLY', 'FOLLOW_UP'];
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab}
          role="tab"
          aria-selected={activeTab === tab}
          onClick={() => onTabChange(tab)}
        >
          {TAB_LABEL[tab]}
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
      className="card"
      style={{
        marginBottom: '1rem',
        background: isOverLimit ? 'var(--bad-soft)' : undefined,
        borderColor: isOverLimit ? 'var(--bad-border)' : undefined,
      }}
    >
      <div style={{ marginBottom: '0.5rem' }}>
        <strong>{item.contact.fullName}</strong>
        <div className="small muted">
          {item.contact.headline} • {item.contact.companyName}
          {item.jobTitle && ` • ${item.jobTitle} at ${item.companyName}`}
        </div>
        <div className="small muted">
          {item.type} • {item.status} • {item.contact.degree}
        </div>
      </div>

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
        <div style={{ marginBottom: '0.5rem' }}>
          <div
            style={{
              padding: '0.5rem',
              background: 'var(--panel-2)',
              borderRadius: '4px',
              whiteSpace: 'pre-wrap',
              fontFamily: 'monospace',
            }}
          >
            {currentBody}
          </div>
          <div className="small muted" style={{ marginTop: '0.25rem' }}>
            {currentBody.length} / {item.charLimit} characters
            {isOverLimit && <span style={{ color: 'var(--bad)' }}> (OVER LIMIT)</span>}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {!isEditing && item.status === 'DRAFT' && (
          <button onClick={onEditStart}>Edit</button>
        )}
        <button onClick={onCopy}>Copy</button>
        <button onClick={onOpenLinkedIn}>Open LinkedIn</button>
        {item.status === 'DRAFT' && (
          <>
            <button onClick={onApprove}>Approve</button>
            <button onClick={onSkip}>Skip</button>
          </>
        )}
        {item.status === 'APPROVED' && (
          <button onClick={onMarkSent}>Send message + resume</button>
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
