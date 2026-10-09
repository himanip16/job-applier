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

/** A banner, replacing the alert() calls this page used to interrupt you with. */
type Notice = { kind: 'info' | 'good' | 'bad' | 'warn'; text: string } | null;

/** The enum names are how the database spells it, not how a person reads it. */
const TAB_LABEL: Record<TabType, string> = {
  COLD: 'First contact',
  REPLY: 'Replies',
  FOLLOW_UP: 'Follow-ups',
};

const EMPTY_COPY: Record<TabType, string> = {
  COLD: 'Nothing drafted yet. Pick people from your connections below and write to them.',
  REPLY: 'No replies waiting. Anyone who answers you appears here.',
  FOLLOW_UP: 'No follow-ups due. One appears when a message has gone unanswered long enough.',
};

const STATUS_LABEL: Record<OutreachItem['status'], string> = {
  DRAFT: 'Draft',
  APPROVED: 'Approved',
  SENT: 'Sent',
  SKIPPED: 'Skipped',
};

const ROLE_LABEL: Record<string, string> = {
  TALENT: 'Recruiting',
  ENGINEERING: 'Engineering leadership',
  OTHER: 'Other',
};

const initialsOf = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join('') || '?';

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
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [connectionsRefresh, setConnectionsRefresh] = useState(0);
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await api<OutreachItem[]>(`/api/outreach/items?type=${activeTab}`));
    } catch (err) {
      setNotice({ kind: 'bad', text: err instanceof Error ? err.message : 'Could not load messages.' });
    }
    setLoading(false);
  }, [activeTab]);

  const loadColdTargets = useCallback(async () => {
    try {
      setColdTargets(await api<ColdTarget[]>('/api/outreach/cold/targets'));
    } catch {
      // A shortlist that will not load is not worth a banner: the connections
      // list below is the primary way in and still works.
    }
  }, []);

  const loadSyncStatus = useCallback(async () => {
    try {
      setSyncStatus(await api<{ connections: any }>('/api/linkedin/sync/status'));
    } catch {
      /* The "last synced" line simply does not render. */
    }
  }, []);

  useEffect(() => {
    loadItems();
    if (activeTab === 'COLD') loadColdTargets();
  }, [loadItems, loadColdTargets, activeTab]);

  useEffect(() => { loadSyncStatus(); }, [loadSyncStatus]);

  useEffect(() => {
    api<{ profile: { id: string } | null }>('/api/profile')
      .then(({ profile }) => setHasProfile(Boolean(profile)))
      .catch((err) => {
        setHasProfile(false);
        setNotice({ kind: 'bad', text: err instanceof Error ? err.message : 'Could not load your profile.' });
      });
  }, []);

  const handleSyncConnections = async () => {
    if (!hasProfile || syncing) return;
    setSyncing(true);
    setNotice(null);
    try {
      const result = await api<{ synced: number; errors: string[] }>(
        '/api/linkedin/sync/connections', { method: 'POST' },
      );
      setNotice(result.errors.length
        ? { kind: 'warn', text: `Synced ${result.synced} connections. ${result.errors.join(' ')}` }
        : { kind: 'good', text: `Synced and categorised ${result.synced} connections.` });
      await loadSyncStatus();
      await loadColdTargets();
    } catch (err) {
      setNotice({ kind: 'bad', text: err instanceof Error ? err.message : 'Failed to sync connections.' });
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
   *
   * `fatalError` is reported on its own. The server distinguishes "the sync
   * never ran" from "one thread of forty failed", and collapsing the two is how
   * a sign-in problem used to surface as "Read 0 messages across 0
   * conversations. 1 could not be saved."
   */
  const handleSyncMessages = async () => {
    if (!hasProfile || syncingMessages) return;
    setSyncingMessages(true);
    setNotice(null);
    try {
      const result = await api<{
        threads: number; messages: number; unmatched: number;
        errors: string[]; fatalError: string | null;
      }>('/api/linkedin/sync/messages', { method: 'POST' });

      if (result.fatalError) {
        setNotice({ kind: 'bad', text: `Could not read your messages. ${result.fatalError}` });
      } else {
        setNotice({
          kind: result.errors.length ? 'warn' : 'good',
          text: `Read ${result.messages} messages across ${result.threads} conversations.`
            + (result.unmatched ? ` ${result.unmatched} threads were with people who are not connections, so they were skipped.` : '')
            + (result.errors.length ? ` ${result.errors.length} could not be saved: ${result.errors[0]}` : ''),
        });
      }
      await loadSyncStatus();
      setConnectionsRefresh((value) => value + 1);
    } catch (err) {
      setNotice({ kind: 'bad', text: err instanceof Error ? err.message : 'Failed to sync messages.' });
    } finally {
      setSyncingMessages(false);
    }
  };

  const handleGenerateCold = async () => {
    if (selectedTargets.size === 0 || generating) return;
    setGenerating(true);
    setNotice(null);
    try {
      const result = await api<{
        created: { id: string; contactId: string }[];
        errors: { contactId: string; error: string }[];
      }>('/api/outreach/cold/generate', {
        method: 'POST',
        body: JSON.stringify({ contactIds: Array.from(selectedTargets) }),
      });
      setSelectedTargets(new Set());
      await loadItems();
      await loadColdTargets();
      setNotice({
        kind: result.errors.length ? 'warn' : 'good',
        text: `Drafted ${result.created.length} message${result.created.length === 1 ? '' : 's'}. Read ${result.created.length === 1 ? 'it' : 'them'} below before approving.`
          + (result.errors.length ? ` ${result.errors.length} could not be written: ${result.errors[0]!.error}` : ''),
      });
    } catch (err) {
      setNotice({ kind: 'bad', text: err instanceof Error ? err.message : 'Failed to draft the messages.' });
    } finally {
      setGenerating(false);
    }
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
      setNotice({ kind: 'bad', text: err instanceof Error ? err.message : 'Could not save your edit.' });
    }
  };

  const handleApprove = async (itemId: string) => {
    try {
      await api(`/api/outreach/items/${itemId}/approve`, { method: 'POST' });
      await loadItems();
    } catch (err) {
      setNotice({ kind: 'bad', text: err instanceof Error ? err.message : 'Could not approve that message.' });
    }
  };

  const handleSkip = async (itemId: string, reason: string) => {
    try {
      await api(`/api/outreach/items/${itemId}/skip`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      });
      await loadItems();
    } catch (err) {
      setNotice({ kind: 'bad', text: err instanceof Error ? err.message : 'Could not skip that message.' });
    }
  };

  const handleMarkSent = async (itemId: string) => {
    try {
      await api(`/api/outreach/items/${itemId}/mark-sent`, { method: 'POST' });
      await loadItems();
      setNotice({ kind: 'good', text: 'Sent on LinkedIn.' });
    } catch (err) {
      setNotice({
        kind: 'bad',
        text: (err instanceof Error ? err.message : 'LinkedIn did not send the message.')
          + ' Nothing was marked as sent.',
      });
    }
  };

  const toggleTarget = (targetId: string) => setSelectedTargets((previous) => {
    const next = new Set(previous);
    if (next.has(targetId)) next.delete(targetId);
    else next.add(targetId);
    return next;
  });

  const lastSynced = syncStatus?.connections?.lastSyncAt
    ? new Date(syncStatus.connections.lastSyncAt).toLocaleString()
    : null;

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

      {notice && (
        <div
          className={`notice ${notice.kind === 'info' ? '' : notice.kind}`}
          role={notice.kind === 'bad' ? 'alert' : 'status'}
          style={{ marginTop: '1rem' }}
        >
          <span>{notice.text}</span>
          <button className="ghost small" onClick={() => setNotice(null)} aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      )}

      <div
        role="tabpanel"
        id="outreach-panel"
        aria-labelledby={`outreach-tab-${activeTab}`}
      >
        {activeTab === 'COLD' && (
          <>
            <div className="sync-bar">
              <button onClick={handleSyncConnections} disabled={!hasProfile || syncing}>
                {syncing ? 'Syncing connections…' : 'Sync connections'}
              </button>
              <button onClick={handleSyncMessages} disabled={!hasProfile || syncingMessages}>
                {syncingMessages ? 'Reading conversations…' : 'Sync messages'}
              </button>
              <span className="small muted sync-meta">
                {hasProfile === null
                  ? 'Checking your profile…'
                  : hasProfile === false
                    ? <>Syncing needs a profile. <a href="/profile">Set one up</a>.</>
                    : lastSynced
                      ? `Connections last synced ${lastSynced}`
                      : 'Connections have never been synced'}
              </span>
            </div>

            {hasProfile && (
              <ConnectionsList
                refreshKey={connectionsRefresh}
                onDrafted={() => { setActiveTab('COLD'); loadItems(); }}
              />
            )}

            {coldTargets.length > 0 && (
              <ColdTargets
                targets={coldTargets}
                selected={selectedTargets}
                busy={generating}
                onToggle={toggleTarget}
                onSelectAll={() => setSelectedTargets(new Set(coldTargets.map((t) => t.id)))}
                onClear={() => setSelectedTargets(new Set())}
                onGenerate={handleGenerateCold}
              />
            )}
          </>
        )}

        <div className="group">
          <div className="group-head">
            <h3 className="group-title">
              {TAB_LABEL[activeTab]}
              {!loading && items.length > 0 && <span className="group-count">{items.length}</span>}
            </h3>
          </div>

          {loading ? (
            <p className="small muted" role="status" style={{ marginTop: '1rem' }}>
              Loading messages…
            </p>
          ) : items.length === 0 ? (
            <div className="empty-state">{EMPTY_COPY[activeTab]}</div>
          ) : (
            <div style={{ marginTop: '1rem' }}>
              {items.map((item) => (
                <OutreachItemCard
                  key={item.id}
                  item={item}
                  isEditing={editingItem === item.id}
                  editText={editText}
                  onEditChange={setEditText}
                  onEditStart={() => {
                    setEditingItem(item.id);
                    setEditText(item.finalBody || item.draftBody);
                  }}
                  onEditSave={() => handleSaveEdit(item.id)}
                  onEditCancel={() => { setEditingItem(null); setEditText(''); }}
                  onApprove={() => handleApprove(item.id)}
                  onSkip={(reason) => handleSkip(item.id, reason)}
                  onMarkSent={() => handleMarkSent(item.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Tabs({ activeTab, onTabChange }: { activeTab: TabType; onTabChange: (tab: TabType) => void }) {
  const tabs: TabType[] = ['COLD', 'REPLY', 'FOLLOW_UP'];
  return (
    <div className="tabs" role="tablist" aria-label="Outreach stage">
      {tabs.map((tab) => (
        <button
          key={tab}
          role="tab"
          id={`outreach-tab-${tab}`}
          aria-selected={activeTab === tab}
          aria-controls="outreach-panel"
          onClick={() => onTabChange(tab)}
        >
          {TAB_LABEL[tab]}
        </button>
      ))}
    </div>
  );
}

/**
 * The never-contacted shortlist.
 *
 * Narrower than the connections list below it: only people with no message
 * either way and no draft already waiting. It earns its place by naming the
 * job each person is matched to, which the full list does not know about.
 */
function ColdTargets({ targets, selected, busy, onToggle, onSelectAll, onClear, onGenerate }: {
  targets: ColdTarget[];
  selected: Set<string>;
  busy: boolean;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onGenerate: () => void;
}) {
  return (
    <section className="group" aria-labelledby="cold-targets-heading">
      <div className="group-head">
        <h3 className="group-title" id="cold-targets-heading">
          Never contacted
          <span className="group-count">{targets.length}</span>
        </h3>
        <div className="row" style={{ gap: '0.4rem' }}>
          <button
            className="small ghost"
            onClick={onSelectAll}
            disabled={selected.size === targets.length}
          >
            Select all
          </button>
          <button className="small ghost" onClick={onClear} disabled={selected.size === 0}>
            Clear
          </button>
        </div>
      </div>
      <p className="group-note">
        No message either way, and nothing drafted yet. Tick anyone you want written to.
      </p>

      {selected.size > 0 && (
        <div className="card composer">
          <div className="composer-head">
            <span className="composer-count">{selected.size} selected</span>
            <button className="ghost small" onClick={onClear}>Clear selection</button>
          </div>
          <div className="composer-go">
            <button className="primary" onClick={onGenerate} disabled={busy}>
              {busy
                ? `Writing ${selected.size} message${selected.size === 1 ? '' : 's'}…`
                : `Draft ${selected.size} message${selected.size === 1 ? '' : 's'}`}
            </button>
            <span className="small muted">
              Drafts appear below. Nothing is sent until you approve it.
            </span>
          </div>
        </div>
      )}

      <ul className="people">
        {targets.map((target) => (
          <li
            key={target.id}
            className={`person${selected.has(target.id) ? ' is-selected' : ''}`}
          >
            <input
              type="checkbox"
              checked={selected.has(target.id)}
              onChange={() => onToggle(target.id)}
              aria-label={`Select ${target.fullName}`}
            />
            <span className="avatar" aria-hidden="true">{initialsOf(target.fullName)}</span>
            <div className="person-main">
              <a href={target.profileUrl} target="_blank" rel="noreferrer" className="person-name">
                {target.fullName}
              </a>
              {target.headline && <p className="person-headline">{target.headline}</p>}
              <div className="person-meta">
                <span>{ROLE_LABEL[target.role] ?? target.role}</span>
                {target.companyName && target.companyName !== 'Unknown' && (
                  <>· <span>{target.companyName}</span></>
                )}
                {target.jobTitle && <>· <span>Matched to {target.jobTitle}</span></>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One drafted message.
 *
 * Two things here are deliberate. The character count is live while you edit,
 * because LinkedIn's connection-note cap is 300 and finding out you are over it
 * only after saving is the whole reason a draft gets rewritten twice. And
 * sending asks twice: it is the one action on this page that cannot be undone.
 */
function OutreachItemCard({
  item, isEditing, editText, onEditChange, onEditStart, onEditSave, onEditCancel,
  onApprove, onSkip, onMarkSent,
}: {
  item: OutreachItem;
  isEditing: boolean;
  editText: string;
  onEditChange: (text: string) => void;
  onEditStart: () => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  onApprove: () => void;
  onSkip: (reason: string) => void;
  onMarkSent: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [confirmingSend, setConfirmingSend] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [skipReason, setSkipReason] = useState('');

  const body = isEditing ? editText : (item.finalBody || item.draftBody);
  const over = body.length - item.charLimit;
  const isOver = over > 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div className="person" style={{ padding: 0, marginBottom: '0.75rem' }}>
        <span className="avatar" aria-hidden="true">{initialsOf(item.contact.fullName)}</span>
        <div className="person-main">
          <a href={item.contact.profileUrl} target="_blank" rel="noreferrer" className="person-name">
            {item.contact.fullName}
          </a>
          {item.contact.headline && <p className="person-headline">{item.contact.headline}</p>}
          <div className="person-meta">
            <span>{ROLE_LABEL[item.contact.role] ?? item.contact.role}</span>
            {item.contact.companyName && item.contact.companyName !== 'Unknown' && (
              <>· <span>{item.contact.companyName}</span></>
            )}
            {item.jobTitle && <>· <span>About {item.jobTitle}</span></>}
          </div>
        </div>
        <div className="person-side">
          <span className={`pill ${item.status}`}>{STATUS_LABEL[item.status]}</span>
          {item.status === 'SENT' && item.sentAt && (
            <span className="small muted">{new Date(item.sentAt).toLocaleDateString()}</span>
          )}
        </div>
      </div>

      {isEditing ? (
        <>
          <textarea
            value={editText}
            onChange={(event) => onEditChange(event.target.value)}
            aria-label={`Message to ${item.contact.fullName}`}
          />
          <p className={`msg-count${isOver ? ' over' : ''}`}>
            {body.length} / {item.charLimit} characters
            {isOver && ` — ${over} over LinkedIn's limit`}
          </p>
          <div className="msg-actions">
            <button className="primary" onClick={onEditSave} disabled={!body.trim()}>Save</button>
            <button className="ghost" onClick={onEditCancel}>Cancel</button>
          </div>
        </>
      ) : (
        <>
          <p className={`msg${isOver ? ' over' : ''}`}>{body}</p>
          <p className={`msg-count${isOver ? ' over' : ''}`}>
            {body.length} / {item.charLimit} characters
            {isOver && ` — ${over} over LinkedIn's limit, so this cannot be sent until it is shortened`}
          </p>

          {confirmingSend ? (
            <div className="confirm" role="alertdialog" aria-label="Confirm send">
              <p>
                This sends the message to {item.contact.fullName} on LinkedIn now. It cannot be
                unsent.
              </p>
              <button className="primary" onClick={() => { setConfirmingSend(false); onMarkSent(); }}>
                Send it
              </button>
              <button className="ghost" onClick={() => setConfirmingSend(false)}>Cancel</button>
            </div>
          ) : skipping ? (
            <div className="confirm" role="group" aria-label="Skip this message">
              <input
                type="text"
                value={skipReason}
                onChange={(event) => setSkipReason(event.target.value)}
                placeholder="Why are you skipping this? (optional)"
                aria-label="Reason for skipping"
                style={{ flex: '1 1 14rem' }}
              />
              <button onClick={() => { setSkipping(false); onSkip(skipReason); }}>Skip it</button>
              <button className="ghost" onClick={() => { setSkipping(false); setSkipReason(''); }}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="msg-actions">
              {item.status === 'DRAFT' && (
                <button className="primary" onClick={onApprove} disabled={isOver}>Approve</button>
              )}
              {item.status === 'APPROVED' && (
                <button className="primary" onClick={() => setConfirmingSend(true)} disabled={isOver}>
                  Send on LinkedIn
                </button>
              )}
              {(item.status === 'DRAFT' || item.status === 'APPROVED') && (
                <button onClick={onEditStart}>Edit</button>
              )}
              <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
              {item.status === 'DRAFT' && (
                <button className="danger ghost" onClick={() => setSkipping(true)}>Skip</button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
