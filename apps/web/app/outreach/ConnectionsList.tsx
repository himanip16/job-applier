'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';

type Status = 'YOUR_TURN' | 'DRAFTED' | 'AWAITING_REPLY' | 'NOT_CONTACTED' | 'CLOSED';

interface Connection {
  id: string;
  fullName: string;
  headline: string | null;
  companyName: string;
  profileUrl: string;
  role: string;
  location: string | null;
  status: Status;
  lastMessageAt: string | null;
  conversationClosedAt: string | null;
}

type Sort = 'status' | 'role' | 'name' | 'company';

interface ConnectionsPage {
  connections: Connection[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  sort: Sort;
  statusTotals: Record<Status, number>;
  roleTotals: Record<string, number>;
}

interface ComposeResult {
  created: { id: string; contactId: string; fullName: string; charLimit: number; overLimit: boolean }[];
  errors: { contactId: string; fullName: string; error: string }[];
}

type Mode = 'AI' | 'TEMPLATE';

const roleLabels: Record<string, string> = {
  TALENT: 'Recruiting', ENGINEERING: 'Engineering leadership', OTHER: 'Other',
};

const sortLabels: Record<Sort, string> = {
  status: 'Where the conversation is', role: 'What they do', name: 'Name', company: 'Company',
};

/**
 * The five states, in the order the server ranks them.
 *
 * `blurb` is on the section, not the row: saying "they replied and you have
 * not answered" once above eleven people reads better than eleven times, and
 * the state is the whole reason the section exists.
 */
const statusLabels: Record<Status, { heading: string; blurb: string }> = {
  YOUR_TURN: {
    heading: 'Your turn',
    blurb: 'They wrote back and you have not answered yet.',
  },
  DRAFTED: {
    heading: 'Draft waiting on you',
    blurb: 'A message is written but not sent. Approve it in First contact.',
  },
  AWAITING_REPLY: {
    heading: 'Waiting on them',
    blurb: 'You sent the last message. Nothing to do until they answer.',
  },
  NOT_CONTACTED: {
    heading: 'Not contacted',
    blurb: 'No message either way on record.',
  },
  CLOSED: {
    heading: 'Done',
    blurb: 'You marked these conversations finished. Reopen one to pick it back up.',
  },
};

const statusColour: Record<Status, string> = {
  YOUR_TURN: 'var(--bad)',
  DRAFTED: 'var(--accent)',
  AWAITING_REPLY: 'var(--muted)',
  NOT_CONTACTED: 'var(--muted)',
  CLOSED: 'var(--good)',
};

/** The most people one request will draft for, matching the server's cap. */
const MAX_SELECTION = 50;

interface Section {
  key: string;
  heading: string;
  blurb?: string;
  colour?: string;
  /** How many are in this section across the whole list, when we can know it. */
  total?: number;
  rows: Connection[];
}

/**
 * Cut the page into sections along whatever it was sorted by.
 *
 * The server orders by the same key, so a section is contiguous across the
 * list and this only ever has to break the run where the key changes. A
 * section split by a page boundary reappears under the same heading on the
 * next page, which is the honest way to show it.
 */
function sectionsOf(data: ConnectionsPage): Section[] {
  const keyOf = (connection: Connection) => {
    if (data.sort === 'status') return connection.status;
    if (data.sort === 'role') return connection.role;
    if (data.sort === 'company') return connection.companyName;
    return connection.fullName.trim().charAt(0).toUpperCase() || '#';
  };

  const sections: Section[] = [];
  for (const connection of data.connections) {
    const key = keyOf(connection);
    const open = sections[sections.length - 1];
    if (open && open.key === key) { open.rows.push(connection); continue; }

    if (data.sort === 'status') {
      const status = key as Status;
      sections.push({
        key,
        heading: statusLabels[status].heading,
        blurb: statusLabels[status].blurb,
        colour: statusColour[status],
        total: data.statusTotals[status],
        rows: [connection],
      });
    } else if (data.sort === 'role') {
      sections.push({ key, heading: roleLabels[key] ?? key, total: data.roleTotals[key], rows: [connection] });
    } else if (data.sort === 'company') {
      sections.push({ key, heading: key === 'Unknown' ? 'Company not recorded' : key, rows: [connection] });
    } else {
      sections.push({ key, heading: key, rows: [connection] });
    }
  }
  return sections;
}

export default function ConnectionsList({ refreshKey, onDrafted }: {
  refreshKey: number;
  onDrafted?: () => void;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<Sort>('status');
  const [data, setData] = useState<ConnectionsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  /**
   * Names live alongside the ids because the selection outlives the page it
   * was made on: picking three people under Recruiting and two on page 4 has
   * to produce a panel that can still name all five.
   */
  const [selected, setSelected] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<ConnectionsPage>(`/api/linkedin/connections?page=${page}&pageSize=${pageSize}&sort=${sort}`)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load connections.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [page, pageSize, sort, refreshKey, retry]);

  const toggle = (connection: Connection) => setSelected((previous) => {
    const next = new Map(previous);
    if (next.has(connection.id)) next.delete(connection.id);
    else next.set(connection.id, connection.fullName);
    return next;
  });

  const setMany = (rows: Connection[], select: boolean) => setSelected((previous) => {
    const next = new Map(previous);
    for (const row of rows) {
      if (select) next.set(row.id, row.fullName);
      else next.delete(row.id);
    }
    return next;
  });

  /**
   * Closing is written straight through and the row patched locally.
   * Refetching would re-sort the list under the cursor and jump the person you
   * just closed into another section mid-click.
   */
  const setClosed = async (connection: Connection, closed: boolean) => {
    await api(`/api/linkedin/connections/${connection.id}/close`, {
      method: 'POST',
      body: JSON.stringify({ closed }),
    });
    setData((previous) => previous && {
      ...previous,
      connections: previous.connections.map((row) => row.id === connection.id
        ? { ...row, conversationClosedAt: closed ? new Date().toISOString() : null }
        : row),
    });
  };

  const sections = data ? sectionsOf(data) : [];

  return (
    <section aria-labelledby="connections-heading" style={{ margin: '1.5rem 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div>
          <h3 id="connections-heading">All connections{data ? ` (${data.total.toLocaleString()})` : ''}</h3>
          <p className="small muted">Everyone synced from LinkedIn. Tick anyone you want to write to.</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Group by</span>
            <select value={sort} onChange={(event) => { setSort(event.target.value as Sort); setPage(1); }}>
              {(Object.keys(sortLabels) as Sort[]).map((option) => (
                <option key={option} value={option}>{sortLabels[option]}</option>
              ))}
            </select>
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span>Per page</span>
            <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
              {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
        </div>
      </div>

      {selected.size > 0 && (
        <Composer
          selected={selected}
          onClear={() => setSelected(new Map())}
          onDeselect={(id) => setSelected((previous) => {
            const next = new Map(previous);
            next.delete(id);
            return next;
          })}
          onDrafted={onDrafted}
        />
      )}

      {loading ? <p role="status">Loading connections…</p> : error ? (
        <div role="alert"><p>{error}</p><button onClick={() => setRetry((value) => value + 1)}>Try again</button></div>
      ) : data && data.total === 0 ? (
        <p role="status">No connections have been synced yet. Use Sync Connections above to import your LinkedIn connections.</p>
      ) : data && (
        <>
          {sections.map((section) => (
            <ConnectionSection
              key={section.key}
              section={section}
              selected={selected}
              onToggle={toggle}
              onToggleSection={(select) => setMany(section.rows, select)}
              onSetClosed={setClosed}
            />
          ))}
          <nav aria-label="Connections pagination" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', marginTop: '1rem' }}>
            <span className="small muted" role="status">
              {(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} of {data.total.toLocaleString()} connections
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <button disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>Previous</button>
              <span>Page {data.page} of {data.totalPages}</span>
              <button disabled={data.page >= data.totalPages} onClick={() => setPage(data.page + 1)}>Next</button>
            </div>
          </nav>
        </>
      )}
    </section>
  );
}

function ConnectionSection({ section, selected, onToggle, onToggleSection, onSetClosed }: {
  section: Section;
  selected: Map<string, string>;
  onToggle: (connection: Connection) => void;
  onToggleSection: (select: boolean) => void;
  onSetClosed: (connection: Connection, closed: boolean) => Promise<void>;
}) {
  const here = section.rows.filter((row) => selected.has(row.id)).length;
  const allHere = here === section.rows.length;
  const headingId = `connections-section-${section.key.replace(/\W+/g, '-')}`;

  return (
    <section aria-labelledby={headingId} style={{ marginTop: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '1rem', flexWrap: 'wrap', borderBottom: `2px solid ${section.colour ?? 'var(--border)'}`, paddingBottom: '0.4rem' }}>
        <h4 id={headingId} style={{ margin: 0 }}>
          {section.heading}{' '}
          <span className="small muted" style={{ fontWeight: 400 }}>
            {section.total !== undefined && section.total !== section.rows.length
              ? `${section.rows.length} of ${section.total.toLocaleString()} here`
              : section.rows.length.toLocaleString()}
          </span>
        </h4>
        <label className="check">
          <input
            type="checkbox"
            checked={allHere}
            ref={(node) => { if (node) node.indeterminate = here > 0 && !allHere; }}
            onChange={() => onToggleSection(!allHere)}
          />
          <span className="small">Select these {section.rows.length}</span>
        </label>
      </div>
      {section.blurb && <p className="small muted" style={{ margin: '0.4rem 0 0' }}>{section.blurb}</p>}
      <ul aria-label={section.heading} style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {section.rows.map((connection) => (
          <li key={connection.id} style={{ padding: '0.85rem 0', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: '0.65rem', minWidth: 0, flex: '1 1 240px' }}>
              <input
                type="checkbox"
                checked={selected.has(connection.id)}
                onChange={() => onToggle(connection)}
                aria-label={`Select ${connection.fullName}`}
                style={{ marginTop: '0.3rem' }}
              />
              <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                <a href={connection.profileUrl} target="_blank" rel="noreferrer"><strong>{connection.fullName}</strong></a>
                {connection.headline && <p style={{ margin: '0.35rem 0' }}>{connection.headline}</p>}
                <span className="small muted">{[connection.companyName === 'Unknown' ? null : connection.companyName, connection.location].filter(Boolean).join(' · ')}</span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.3rem' }}>
              <span className="small muted">{roleLabels[connection.role] ?? connection.role}</span>
              {connection.lastMessageAt && (
                <span className="small muted">
                  Last message {new Date(connection.lastMessageAt).toLocaleDateString()}
                </span>
              )}
              <button
                className="small ghost"
                onClick={() => onSetClosed(connection, !connection.conversationClosedAt)}
              >
                {connection.conversationClosedAt ? 'Reopen' : 'Mark as done'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Choose how the selected people get written to.
 *
 * Both routes end at the same place: a DRAFT in the First contact tab, which
 * you read before anything is approved or sent. The AI route writes one
 * message per person from their headline; the written route takes your words
 * and only fills in the placeholders you used.
 */
function Composer({ selected, onClear, onDeselect, onDrafted }: {
  selected: Map<string, string>;
  onClear: () => void;
  onDeselect: (id: string) => void;
  onDrafted?: () => void;
}) {
  const [mode, setMode] = useState<Mode>('AI');
  const [body, setBody] = useState('');
  const [emphasis, setEmphasis] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ComposeResult | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const ids = useMemo(() => [...selected.keys()], [selected]);
  const overCap = ids.length > MAX_SELECTION;

  const insert = (token: string) => {
    const field = bodyRef.current;
    if (!field) { setBody((text) => text + token); return; }
    const { selectionStart: start, selectionEnd: end } = field;
    setBody((text) => text.slice(0, start) + token + text.slice(end));
    // Put the caret after what was just inserted rather than at the end of the
    // message, so a second placeholder can be added mid-sentence.
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    setResult(null);
    try {
      const response = await api<ComposeResult>('/api/linkedin/connections/messages', {
        method: 'POST',
        body: JSON.stringify({
          contactIds: ids,
          mode,
          ...(mode === 'TEMPLATE' ? { body } : emphasis.trim() ? { emphasis: emphasis.trim() } : {}),
        }),
      });
      setResult(response);
      // Only people who now have a draft leave the selection. Anyone the
      // server could not write for stays ticked, so a retry after fixing the
      // message does not need the whole selection rebuilt.
      for (const made of response.created) onDeselect(made.contactId);
      if (response.created.length) onDrafted?.();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'Could not create the drafts.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ margin: '1rem 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
        <strong>{selected.size} selected</strong>
        <button className="ghost small" onClick={onClear}>Clear selection</button>
      </div>
      <p className="small muted" style={{ margin: '0.35rem 0 0.75rem', overflowWrap: 'anywhere' }}>
        {[...selected.values()].slice(0, 6).join(', ')}
        {selected.size > 6 && ` and ${selected.size - 6} more`}
      </p>

      <div role="radiogroup" aria-label="How to write the message" style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <label className="check">
          <input type="radio" name="compose-mode" checked={mode === 'AI'} onChange={() => setMode('AI')} />
          <span>Write each one with AI, from their profile</span>
        </label>
        <label className="check">
          <input type="radio" name="compose-mode" checked={mode === 'TEMPLATE'} onChange={() => setMode('TEMPLATE')} />
          <span>Use a message I write</span>
        </label>
      </div>

      {mode === 'AI' ? (
        <label className="field">
          <span>Anything to emphasise (optional)</span>
          <input
            type="text"
            value={emphasis}
            onChange={(event) => setEmphasis(event.target.value)}
            placeholder="e.g. the payments work, or that I am open to contract roles"
          />
          <span className="small muted">
            Each message is written from that person&apos;s headline and your profile. Nothing about them is invented.
          </span>
        </label>
      ) : (
        <label className="field">
          <span>Your message</span>
          <textarea
            ref={bodyRef}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={'Hi {firstName}, I am looking for my next backend role and thought I would ask around my network. Do you know of anything open?'}
            style={{ minHeight: '7rem' }}
          />
          <span className="small muted" style={{ display: 'block', marginTop: '0.4rem' }}>
            {body.trim().length} characters. Everyone gets these exact words, with the placeholders filled in.
          </span>
          <span style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.45rem' }}>
            {['{firstName}', '{fullName}', '{company}', '{headline}'].map((token) => (
              <button key={token} type="button" className="small ghost" onClick={() => insert(token)}>{token}</button>
            ))}
          </span>
        </label>
      )}

      <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="primary"
          onClick={submit}
          disabled={busy || overCap || (mode === 'TEMPLATE' && !body.trim())}
        >
          {busy
            ? mode === 'AI' ? `Writing ${ids.length} messages…` : 'Creating drafts…'
            : `Create ${ids.length} draft${ids.length === 1 ? '' : 's'}`}
        </button>
        <span className="small muted">
          Drafts land in First contact. Nothing is sent until you approve it there.
        </span>
      </div>

      {overCap && (
        <p className="small" role="alert" style={{ color: 'var(--bad)', marginTop: '0.6rem' }}>
          {ids.length} people selected, and one batch takes at most {MAX_SELECTION}. Untick some before creating drafts.
        </p>
      )}
      {failed && <p className="small" role="alert" style={{ color: 'var(--bad)', marginTop: '0.6rem' }}>{failed}</p>}
      {result && (
        <div role="status" style={{ marginTop: '0.75rem' }}>
          {result.created.length > 0 && (
            <p className="small">
              Drafted {result.created.length} message{result.created.length === 1 ? '' : 's'}. Read {result.created.length === 1 ? 'it' : 'them'} in First contact before approving.
              {result.created.some((made) => made.overLimit) &&
                ' Some are over LinkedIn’s character limit and are marked red there; they cannot be sent until they are shortened.'}
            </p>
          )}
          {result.errors.length > 0 && (
            <ul className="small" style={{ margin: '0.4rem 0 0', paddingLeft: '1.1rem', color: 'var(--bad)' }}>
              {result.errors.map((problem) => (
                <li key={problem.contactId}>{problem.fullName}: {problem.error}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
