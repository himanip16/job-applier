'use client';

import { useEffect, useState } from 'react';
import { API, api } from '../../lib/api';

interface Insertion { keyword: string; evidence: string; sourceField: string; line: string }
interface Unsupported { keyword: string; importance: string; note: string }
interface Covered { keyword: string; where: string }
interface Tailored {
  id: string;
  label: string;
  text: string;
  coverage: number;
  txtPath: string | null;
  docxPath: string | null;
  insertions: Insertion[];
  unsupported: Unsupported[];
  covered: Covered[];
  createdAt: string;
}

/**
 * The tailoring view.
 *
 * The rewritten resume is the smallest part of what is on this page. The three
 * lists either side of it are the point: what you already covered, what was
 * added and on what evidence, and what this job wants that you cannot honestly
 * claim. That last list is useful even on the days you do not send anything.
 */
export default function ResumeLab() {
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [atsIssues, setAtsIssues] = useState<string[]>([]);
  const [result, setResult] = useState<Tailored | null>(null);
  const [history, setHistory] = useState<Tailored[]>([]);

  const loadHistory = () =>
    api<{ tailored: Tailored[] }>('/api/resume/tailored')
      .then((d) => setHistory(d.tailored))
      .catch(() => {});

  useEffect(() => { loadHistory(); }, []);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      const r = await api<{
        tailoredResume: Tailored;
        atsIssues: string[];
        violations: string[];
        warning?: string;
      }>('/api/resume/tailor', {
        method: 'POST',
        body: JSON.stringify({ jobTitle: title, companyName: company, jobDescription: description }),
      });
      setResult(r.tailoredResume);
      setAtsIssues(r.atsIssues ?? []);
      if (r.warning) setWarning(r.warning);
      loadHistory();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="panel">
        <h2>Tailor your resume for a job</h2>
        <p className="sub">
          Pulls the keywords a screener looks for, checks each one against what you can actually
          back up, and rewrites only within that. Anything it cannot ground is reported as a gap
          rather than written in.
        </p>
        <form onSubmit={run}>
          <div className="row">
            <input type="text" required placeholder="Job title" value={title}
              onChange={(e) => setTitle(e.target.value)} style={{ flex: '1 1 14rem' }} />
            <input type="text" required placeholder="Company" value={company}
              onChange={(e) => setCompany(e.target.value)} style={{ flex: '1 1 12rem' }} />
          </div>
          <label className="field" style={{ marginTop: '.7rem' }}>
            <span>Paste the job description</span>
            <textarea required value={description} style={{ minHeight: '10rem' }}
              onChange={(e) => setDescription(e.target.value)} />
          </label>
          <button className="primary" disabled={busy}>{busy ? 'Working…' : 'Tailor'}</button>
        </form>
        {error && <div className="notice bad" style={{ marginTop: '.8rem' }}>{error}</div>}
        {warning && <div className="notice bad" style={{ marginTop: '.8rem' }}>{warning}</div>}
      </div>

      {result && (
        <>
          <div className="panel">
            <div className="spread">
              <h2>Keyword coverage</h2>
              <strong style={{ color: result.coverage >= 70 ? 'var(--good)' : 'var(--warn)' }}>
                {Math.round(result.coverage)}%
              </strong>
            </div>

            <h2 style={{ fontSize: '.9rem', marginTop: '.9rem' }}>
              Added ({result.insertions.length}) — each with the evidence that allowed it
            </h2>
            {result.insertions.length === 0 ? (
              <p className="muted small">Nothing added. Your resume already covered what it could.</p>
            ) : (
              <table>
                <tbody>
                  {result.insertions.map((i) => (
                    <tr key={i.keyword}>
                      <td><strong>{i.keyword}</strong></td>
                      <td className="small">
                        <span className="muted">because you wrote:</span> &ldquo;{i.evidence}&rdquo;
                        <div className="muted small">({i.sourceField})</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h2 style={{ fontSize: '.9rem', marginTop: '1.1rem', color: 'var(--warn)' }}>
              Not added ({result.unsupported.length}) — this job wants these and nothing backs them up
            </h2>
            <p className="sub" style={{ marginBottom: '.4rem' }}>
              These were deliberately left off. Putting a keyword on your resume that you cannot
              discuss in an interview is worse than missing it.
            </p>
            {result.unsupported.length === 0 ? (
              <p className="muted small">Nothing missing. Strong match.</p>
            ) : (
              <table>
                <tbody>
                  {result.unsupported.map((u) => (
                    <tr key={u.keyword}>
                      <td><strong>{u.keyword}</strong></td>
                      <td>
                        <span className="src" style={{ color: u.importance === 'REQUIRED' ? 'var(--bad)' : undefined }}>
                          {u.importance.replace('_', ' ').toLowerCase()}
                        </span>
                      </td>
                      <td className="small muted">{u.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {result.covered.length > 0 && (
              <>
                <h2 style={{ fontSize: '.9rem', marginTop: '1.1rem' }}>
                  Already covered ({result.covered.length})
                </h2>
                <p className="small muted">{result.covered.map((c) => c.keyword).join(', ')}</p>
              </>
            )}

            {atsIssues.length > 0 && (
              <>
                <h2 style={{ fontSize: '.9rem', marginTop: '1.1rem' }}>ATS formatting fixed</h2>
                <ul className="small muted">
                  {atsIssues.map((i) => <li key={i}>{i}</li>)}
                </ul>
              </>
            )}
          </div>

          <div className="panel">
            <div className="spread">
              <h2>The tailored resume</h2>
              <div className="row">
                {result.docxPath && (
                  <a href={`${API}/files/resumes/${result.docxPath.replace(/^resumes\//, '')}`}>
                    <button type="button">Download .docx</button>
                  </a>
                )}
                {result.txtPath && (
                  <a href={`${API}/files/resumes/${result.txtPath.replace(/^resumes\//, '')}`}>
                    <button type="button">Download .txt</button>
                  </a>
                )}
              </div>
            </div>
            <p className="sub">
              Single column, standard headings, plain bullets, no tables or graphics — the format
              parsers actually read correctly.
            </p>
            <textarea readOnly value={result.text} style={{ minHeight: '26rem', fontFamily: 'ui-monospace, monospace', fontSize: '.8rem' }} />
          </div>
        </>
      )}

      {history.length > 0 && (
        <div className="panel">
          <h2>Earlier versions</h2>
          <table>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>{h.label}</td>
                  <td className="muted small">{Math.round(h.coverage)}% coverage</td>
                  <td className="muted small">{new Date(h.createdAt).toLocaleDateString()}</td>
                  <td>
                    {h.docxPath && (
                      <a href={`${API}/files/resumes/${h.docxPath.replace(/^resumes\//, '')}`}>.docx</a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
