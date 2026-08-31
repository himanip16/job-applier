'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';

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
}

type TabType = 'COLD' | 'REPLY' | 'FOLLOW_UP';

export default function OutreachPage() {
  const [activeTab, setActiveTab] = useState<TabType>('COLD');
  const [items, setItems] = useState<OutreachItem[]>([]);
  const [coldTargets, setColdTargets] = useState<ColdTarget[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState<{ connections: any } | null>(null);
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

  const handleSyncConnections = async () => {
    try {
      await api('/api/linkedin/sync/connections', { method: 'POST' });
      await loadSyncStatus();
      await loadColdTargets();
    } catch (err) {
      console.error('Failed to sync connections:', err);
      alert('Failed to sync connections. Check console for details.');
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
    } catch (err) {
      console.error('Failed to mark as sent:', err);
      alert('Failed to mark as sent.');
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

      <Tabs activeTab={activeTab} onTabChange={setActiveTab} />

      {activeTab === 'COLD' && (
        <div style={{ marginTop: '1rem' }}>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
            <button onClick={handleSyncConnections}>
              Sync Connections
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

          {coldTargets.length > 0 && (
            <div style={{ marginBottom: '1rem', padding: '1rem', background: '#f5f5f5', borderRadius: '4px' }}>
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
                      borderBottom: '1px solid #ddd',
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

function Tabs({ activeTab, onTabChange }: { activeTab: TabType; onTabChange: (tab: TabType) => void }) {
  const tabs: TabType[] = ['COLD', 'REPLY', 'FOLLOW_UP'];
  return (
    <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '1px solid #ddd', paddingBottom: '0.5rem' }}>
      {tabs.map((tab) => (
        <button
          key={tab}
          onClick={() => onTabChange(tab)}
          style={{
            padding: '0.5rem 1rem',
            background: activeTab === tab ? '#e0e0e0' : 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontWeight: activeTab === tab ? 'bold' : 'normal',
          }}
        >
          {tab}
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
        border: '1px solid #ddd',
        borderRadius: '4px',
        padding: '1rem',
        marginBottom: '1rem',
        background: isOverLimit ? '#fff5f5' : 'white',
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
              background: '#f5f5f5',
              borderRadius: '4px',
              whiteSpace: 'pre-wrap',
              fontFamily: 'monospace',
            }}
          >
            {currentBody}
          </div>
          <div className="small muted" style={{ marginTop: '0.25rem' }}>
            {currentBody.length} / {item.charLimit} characters
            {isOverLimit && <span style={{ color: 'red' }}> (OVER LIMIT)</span>}
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
          <button onClick={onMarkSent}>Mark as Sent</button>
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
