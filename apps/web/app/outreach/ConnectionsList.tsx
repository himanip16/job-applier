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
  status: 'Conversation', role: 'What they do', name: 'Name', company: 'Company',
};

/**
 * The five states, in the order the server ranks them.
 *
 * `blurb` sits on the section rather than the row: saying "they replied and
 * you have not answered" once above eleven people reads better than eleven
 * times, and the state is the whole reason the section exists.
 */
const statusLabels: Record<Status, { heading: string; pill: string; blurb: string; colour: string }> = {
  YOUR_TURN: {
    heading: 'Your turn',
    pill: 'Your turn',
    blurb: 'They wrote back and you have not answered yet.',
    colour: 'var(--warn)',
  },
  DRAFTED: {
    heading: 'Draft waiting on you',
    pill: 'Drafted',
    blurb: 'A message is written but not sent. Approve it under First contact.',
    colour: 'var(--accent)',
  },
  AWAITING_REPLY: {
    heading: 'Waiting on them',
    pill: 'Sent',
    blurb: 'You sent the last message. Nothing to do until they answer.',
    colour: 'var(--border-strong)',
  },
  NOT_CONTACTED: {
    heading: 'Not contacted',
    pill: 'New',
    blurb: 'No message either way on record.',
    colour: 'var(--border-strong)',
  },
  CLOSED: {
    heading: 'Done',
    pill: 'Done',
    blurb: 'You marked these finished. Reopen one to pick it back up.',
    colour: 'var(--good)',
  },
};

/** The most people one request will draft for, matching the server's cap. */
const MAX_SELECTION = 50;

const initialsOf = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join('') || '?';

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
 * whole list and this only ever has to break the run where the key changes. A
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
      const label = statusLabels[key as Status];
      sections.push({
        key, heading: label.heading, blurb: label.blurb, colour: label.colour,
        total: data.statusTotals[key as Status], rows: [connection],
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
   * was made on: picking three people under Your turn and two on page 4 has to
   * produce a composer that can still name all five.
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
   * Closing writes through and patches the row in place. Refetching would
   * re-sort the list under the cursor and jump the person you just closed into
   * another section mid-click.
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
  const first = data ? (data.page - 1) * data.pageSize + 1 : 0;
  const last = data ? Math.min(data.page * data.pageSize, data.total) : 0;

  return (
    <section aria-labelledby="connections-heading">
      <div className="panel-head">
        <div>
          <h3 id="connections-heading">
            All connections{' '}
            {data && <span className="muted nums">({data.total.toLocaleString()})</span>}
          </h3>
          <p className="sub">Everyone synced from LinkedIn, grouped by where the conversation stands. Tick anyone you want to write to.</p>
        </div>
      </div>

      <div className="toolbar">
        <label className="field">
          <span className="cap">Group by</span>
          <select value={sort} onChange={(event) => { setSort(event.target.value as Sort); setPage(1); }}>
            {(Object.keys(sortLabels) as Sort[]).map((option) => (
              <option key={option} value={option}>{sortLabels[option]}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="cap">Per page</span>
          <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>
            {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <span className="toolbar-sep" />
        {data && data.total > 0 && (
          <span className="toolbar-note nums" role="status">
            {first}–{last} of {data.total.toLocaleString()}
          </span>
        )}
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

      {loading ? (
        <div className="people" aria-busy="true">
          {[0, 1, 2, 3].map((row) => (
            <div className="person" key={row}>
              <span className="skel avatar" aria-hidden="true" />
              <span className="person-main stack">
                <span className="skel" style={{ height: '0.9rem', width: '30%' }} />
                <span className="skel" style={{ height: '0.8rem', width: '65%' }} />
              </span>
            </div>
          ))}
          <p className="sr-only" role="status">Loading connections…</p>
        </div>
      ) : error ? (
        <div className="notice bad" role="alert">
          <span>{error}</span>
          <button className="small" onClick={() => setRetry((value) => value + 1)}>Try again</button>
        </div>
      ) : data && data.total === 0 ? (
        <div className="empty-state">
          No connections synced yet. Use <strong>Sync connections</strong> above to import them from LinkedIn.
        </div>
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
          <nav className="spread" aria-label="Connections pagination">
            <span className="small muted nums">Page {data.page} of {data.totalPages}</span>
            <span className="row">
              <button className="small" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>Previous</button>
              <button className="small" disabled={data.page >= data.totalPages} onClick={() => setPage(data.page + 1)}>Next</button>
            </span>
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
    <section
      className="group"
      aria-labelledby={headingId}
      style={section.colour ? ({ '--group-colour': section.colour } as React.CSSProperties) : undefined}
    >
      <div className="group-head">
        <h4 className="group-title" id={headingId}>
          {section.heading}
          <span className="group-count">
            {section.total !== undefined && section.total !== section.rows.length
              ? `${section.rows.length} of ${section.total.toLocaleString()}`
              : section.rows.length.toLocaleString()}
          </span>
        </h4>
        <label className="check small">
          <input
            type="checkbox"
            checked={allHere}
            ref={(node) => { if (node) node.indeterminate = here > 0 && !allHere; }}
            onChange={() => onToggleSection(!allHere)}
          />
          <span>Select these {section.rows.length}</span>
        </label>
      </div>
      {section.blurb && <p className="group-note">{section.blurb}</p>}

      <ul className="people" aria-label={section.heading}>
        {section.rows.map((connection) => {
          const label = statusLabels[connection.status];
          return (
            <li className={`person${selected.has(connection.id) ? ' is-selected' : ''}`} key={connection.id}>
              <input
                type="checkbox"
                checked={selected.has(connection.id)}
                onChange={() => onToggle(connection)}
                aria-label={`Select ${connection.fullName}`}
              />
              <span className="avatar" aria-hidden="true">{initialsOf(connection.fullName)}</span>
              <div className="person-main">
                <a className="person-name" href={connection.profileUrl} target="_blank" rel="noreferrer">
                  {connection.fullName}
                </a>
                {connection.headline && <p className="person-headline">{connection.headline}</p>}
                <div className="person-meta">
                  <span className={`pill ${connection.status}`}>{label.pill}</span>
                  {connection.companyName !== 'Unknown' && <span>{connection.companyName}</span>}
                  {connection.location && <span>{connection.location}</span>}
                  <span>{roleLabels[connection.role] ?? connection.role}</span>
                  {connection.lastMessageAt && (
                    <span>Last message {new Date(connection.lastMessageAt).toLocaleDateString()}</span>
                  )}
                </div>
              </div>
              <div className="person-side">
                <button
                  className="small ghost"
                  onClick={() => onSetClosed(connection, !connection.conversationClosedAt)}
                >
                  {connection.conversationClosedAt ? 'Reopen' : 'Mark as done'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Choose how the selected people get written to.
 *
 * Both routes end at the same place: a DRAFT under First contact, which you
 * read before anything is approved or sent. The AI route writes one message
 * per person from their headline; the written route takes your words and only
 * fills in the placeholders you used.
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
    <div className="card composer">
      <div className="composer-head">
        <span className="composer-count nums">{selected.size} selected</span>
        <button className="ghost small" onClick={onClear}>Clear</button>
      </div>
      <p className="composer-names">
        {[...selected.values()].slice(0, 6).join(', ')}
        {selected.size > 6 && ` and ${selected.size - 6} more`}
      </p>

      <div className="choices" role="radiogroup" aria-label="How to write the message">
        <label className="choice">
          <input type="radio" name="compose-mode" checked={mode === 'AI'} onChange={() => setMode('AI')} />
          <span>
            <span className="choice-title">Write each one with AI</span>
            <span className="choice-note">One message per person, from their headline and your profile.</span>
          </span>
        </label>
        <label className="choice">
          <input type="radio" name="compose-mode" checked={mode === 'TEMPLATE'} onChange={() => setMode('TEMPLATE')} />
          <span>
            <span className="choice-title">Use a message I write</span>
            <span className="choice-note">Your exact words, with placeholders filled in per person.</span>
          </span>
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
        </label>
      ) : (
        <div className="field">
          <span>Your message</span>
          <textarea
            ref={bodyRef}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={'Hi {firstName}, I am looking for my next backend role and thought I would ask around my network. Do you know of anything open?'}
          />
          <p className="msg-count">{body.trim().length} characters</p>
          <div className="tokens">
            {['{firstName}', '{fullName}', '{company}', '{headline}'].map((token) => (
              <button key={token} type="button" className="small ghost" onClick={() => insert(token)}>{token}</button>
            ))}
          </div>
        </div>
      )}

      <div className="composer-go">
        <button
          className="primary"
          onClick={submit}
          disabled={busy || overCap || (mode === 'TEMPLATE' && !body.trim())}
        >
          {busy && <span className="spinner" aria-hidden="true" />}
          {busy
            ? mode === 'AI' ? `Writing ${ids.length}…` : 'Creating drafts…'
            : `Create ${ids.length} draft${ids.length === 1 ? '' : 's'}`}
        </button>
        <span className="small muted">Drafts go to First contact. Nothing sends until you approve it there.</span>
      </div>

      {overCap && (
        <p className="notice bad small" role="alert">
          {ids.length} selected, and one batch takes at most {MAX_SELECTION}. Untick some first.
        </p>
      )}
      {failed && <p className="notice bad small" role="alert">{failed}</p>}
      {result && (result.created.length > 0 || result.errors.length > 0) && (
        <div role="status">
          {result.created.length > 0 && (
            <p className="notice good small">
              Drafted {result.created.length} message{result.created.length === 1 ? '' : 's'}.
              {result.created.some((made) => made.overLimit) && ' Some are over LinkedIn’s limit and are flagged red; they cannot send until shortened.'}
            </p>
          )}
          {result.errors.map((problem) => (
            <p className="notice bad small" key={problem.contactId}>
              <strong>{problem.fullName}</strong> {problem.error}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
