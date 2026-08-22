'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface AppRow {
  id: string;
  status: string;
  blockedReason: string | null;
  submittedAt: string | null;
  requiresReview: boolean;
  job: { url: string; company: string; title: string; ats: string };
  _count: { pending: number };
}

export default function Dashboard() {
  const [rows, setRows] = useState<AppRow[]>([]);
  const [url, setUrl] = useState('');
  const [review, setReview] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<{
    llmConfigured: boolean;
    headless: boolean;
    model: string;
    cheapModel: string;
    estimatedCosts: { perApplication: number; perTailoring: number; perDeepScoredLead: number };
  } | null>(null);

  const load = () =>
    api<{ applications: AppRow[] }>('/api/applications')
      .then((d) => setRows(d.applications))
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
    api<typeof health>('/api/health').then(setHealth).catch(() => {});
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ applicationId: string }>('/api/applications', {
        method: 'POST',
        body: JSON.stringify({ url, autoStart: true, requiresReview: review }),
      });
      setUrl('');
      window.location.href = `/applications/${r.applicationId}`;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {health && !health.llmConfigured && (
        <div className="panel">
          <div className="notice bad">
            ANTHROPIC_API_KEY is not set. Field matching and the answer bank still work, but cover
            letters and inference will fail.
          </div>
        </div>
      )}
      {health?.llmConfigured && (
        <div className="panel">
          <div className="spread">
            <div>
              <h2>Running cost</h2>
              <p className="sub" style={{ margin: 0 }}>
                {health.model} writes what goes out under your name; {health.cheapModel} handles the
                high-volume judgement calls. Estimated locally — your console has the real figure.
              </p>
            </div>
            <div className="row" style={{ gap: '1.5rem' }}>
              <Cost label="per application" value={health.estimatedCosts.perApplication} />
              <Cost label="per resume tailor" value={health.estimatedCosts.perTailoring} />
              <Cost label="per lead read fully" value={health.estimatedCosts.perDeepScoredLead} />
            </div>
          </div>
        </div>
      )}

      {health?.headless && (
        <div className="panel">
          <div className="notice">
            Running headless. Set <code>HEADLESS=false</code> so you can see the form, take over on a
            captcha, and give the browser profile a real interaction history.
          </div>
        </div>
      )}

      <div className="panel">
        <h2>Apply to a job</h2>
        <p className="sub">
          Paste the posting URL. Greenhouse, Lever, Ashby and Workable have dedicated handling;
          anything else falls back to reading the form off the page.
        </p>
        <form onSubmit={add}>
          <div className="row">
            <input
              type="url"
              required
              placeholder="https://job-boards.greenhouse.io/acme/jobs/1234567"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              style={{ flex: 1, minWidth: '18rem' }}
            />
            <button className="primary" disabled={busy}>
              {busy ? 'Starting…' : 'Start'}
            </button>
          </div>
          <label className="row small" style={{ marginTop: '.7rem' }}>
            <input
              type="checkbox"
              checked={review}
              onChange={(e) => setReview(e.target.checked)}
              style={{ width: 'auto' }}
            />
            <span>Stop for my review before submitting</span>
          </label>
        </form>
        {error && <p className="notice bad" style={{ marginTop: '.8rem' }}>{error}</p>}
      </div>

      <div className="panel">
        <h2>Applications</h2>
        {rows.length === 0 ? (
          <p className="muted small">Nothing yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>ATS</th>
                <th>Status</th>
                <th>Needs you</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <a href={`/applications/${r.id}`}>
                      {r.job.title === 'pending' ? r.job.url : `${r.job.title} — ${r.job.company}`}
                    </a>
                    {r.blockedReason && <div className="muted small">{r.blockedReason}</div>}
                  </td>
                  <td className="small muted">{r.job.ats}</td>
                  <td><span className={`pill ${r.status}`}>{r.status.replace('_', ' ')}</span></td>
                  <td className="small">
                    {r._count.pending > 0
                      ? `${r._count.pending} question${r._count.pending === 1 ? '' : 's'}`
                      : r.status === 'REVIEW'
                        ? 'approval'
                        : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Cost({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div style={{ fontSize: '1.15rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        ${value.toFixed(3)}
      </div>
      <div className="muted small">{label}</div>
    </div>
  );
}
