'use client';

import { useEffect, useState } from 'react';
import { API, api } from '../../lib/api';

interface Fact { id: string; key: string; label: string; value: string }
interface Resume { id: string; label: string; filename: string; bytes: number; isDefault: boolean }
interface Profile {
  id: string; email: string; fullName: string; firstName: string; lastName: string;
  phone: string | null; city: string | null; region: string | null; country: string | null;
  citizenship: string | null; expectedCTC: string | null; linkedin: string | null; github: string | null; website: string | null; summary: string | null;
  facts: Fact[]; resumes: Resume[];
}

const FIELDS: [keyof Profile, string][] = [
  ['fullName', 'Full name'], ['firstName', 'First name'], ['lastName', 'Last name'],
  ['email', 'Email'], ['phone', 'Phone'], ['city', 'City'], ['region', 'State / region'],
  ['country', 'Country'], ['citizenship', 'Citizenship'], ['expectedCTC', 'Expected CTC (Salary)'], ['linkedin', 'LinkedIn URL'], ['github', 'GitHub URL'],
  ['website', 'Website / portfolio'],
];

/**
 * The facts most forms ask for. Filling these in is what stops the popup from
 * appearing on every single application.
 */
const SUGGESTED: { key: string; label: string }[] = [
  { key: 'citizenship.country', label: 'Citizenship country' },
  { key: 'work_auth.authorized', label: 'Legally authorized to work in the country of the role' },
  { key: 'work_auth.sponsorship_required', label: 'Requires visa sponsorship now or in future' },
  { key: 'work_auth.visa_status', label: 'Current visa / work authorization status' },
  { key: 'experience.years_total', label: 'Years of professional experience' },
  { key: 'compensation.expectation', label: 'Salary expectation' },
  { key: 'compensation.expectation_min', label: 'Minimum salary expectation' },
  { key: 'compensation.expectation_max', label: 'Maximum salary expectation' },
  { key: 'availability.notice_period', label: 'Notice period' },
  { key: 'availability.start_date', label: 'Earliest start date' },
  { key: 'logistics.relocate', label: 'Willing to relocate' },
  { key: 'legal.age_18', label: 'At least 18 years old' },
  { key: 'legal.non_compete', label: 'Subject to a non-compete' },
  { key: 'history.source', label: 'How did you hear about this role' },
];

export default function ProfilePage() {
  const [profile, setProfile] = useState<Partial<Profile>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = () =>
    api<{ profile: Profile | null }>('/api/profile').then((d) => setProfile(d.profile ?? {}));

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({
          email: profile.email, fullName: profile.fullName,
          firstName: profile.firstName, lastName: profile.lastName,
          phone: profile.phone ?? undefined, city: profile.city ?? undefined,
          region: profile.region ?? undefined, country: profile.country ?? undefined,
          citizenship: profile.citizenship ?? undefined, expectedCTC: profile.expectedCTC ?? undefined,
          linkedin: profile.linkedin ?? undefined, github: profile.github ?? undefined,
          website: profile.website ?? undefined, summary: profile.summary ?? undefined,
        }),
      });
      setSaved('Saved.');
      setTimeout(() => setSaved(null), 2500);
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API}/api/resume`, { method: 'POST', body: fd });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Upload failed');
      setSaved(
        body.warning
          ? `Uploaded, but: ${body.warning}`
          : `Uploaded. Extracted ${body.words} words for the model to work from.`,
      );
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setUploading(false); }
  }

  async function saveFact(key: string, label: string, value: string) {
    await api('/api/facts', { method: 'POST', body: JSON.stringify({ key, label, value }) });
    await load();
  }

  const factFor = (key: string) => profile.facts?.find((f) => f.key === key);

  return (
    <>
      <div className="panel">
        <h2>Who you are</h2>
        <p className="sub">These fill the name/contact half of every form directly, with no model involved.</p>
        <form onSubmit={save}>
          <div className="grid2">
            {FIELDS.map(([k, label]) => (
              <label className="field" key={k}>
                <span>{label}</span>
                <input
                  type="text"
                  value={(profile[k] as string) ?? ''}
                  onChange={(e) => setProfile((p) => ({ ...p, [k]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          <label className="field">
            <span>Summary — used to ground cover letters</span>
            <textarea
              value={profile.summary ?? ''}
              onChange={(e) => setProfile((p) => ({ ...p, summary: e.target.value }))}
            />
          </label>
          <button className="primary">Save</button>
          {saved && <span className="small" style={{ marginLeft: '.8rem', color: 'var(--good)' }}>{saved}</span>}
        </form>
        {error && <div className="notice bad" style={{ marginTop: '.8rem' }}>{error}</div>}
      </div>

      <div className="panel">
        <h2>Resume</h2>
        <p className="sub">
          Attached to applications, and its text is the only thing the model is allowed to make
          claims from. PDF, DOCX or TXT.
        </p>
        <input
          type="file"
          accept=".pdf,.docx,.txt,.md"
          disabled={uploading || !profile.id}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }}
        />
        {!profile.id && <p className="muted small">Save your profile first.</p>}
        {profile.resumes?.length ? (
          <table style={{ marginTop: '.8rem' }}>
            <tbody>
              {profile.resumes.map((r) => (
                <tr key={r.id}>
                  <td>{r.filename}</td>
                  <td className="muted small">{(r.bytes / 1024).toFixed(0)} KB</td>
                  <td>
                    {r.isDefault ? (
                      <span className="src USER">default</span>
                    ) : (
                      <button
                        onClick={async () => {
                          await api(`/api/resume/${r.id}/default`, { method: 'POST' });
                          await load();
                        }}
                      >
                        Use this one
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      <div className="panel">
        <h2>Standing answers</h2>
        <p className="sub">
          The questions nearly every form asks. Anything you fill in here is answered without
          stopping to ask you. Anything you leave blank becomes a popup the first time it comes up,
          and is remembered from then on.
        </p>
        {!profile.id ? (
          <p className="muted small">Save your profile first.</p>
        ) : (
          <table>
            <tbody>
              {SUGGESTED.map((s) => (
                <tr key={s.key}>
                  <td style={{ width: '45%' }}>
                    {s.label}
                    <div className="muted small">{s.key}</div>
                  </td>
                  <td>
                    <input
                      type="text"
                      defaultValue={factFor(s.key)?.value ?? ''}
                      placeholder="not set — will be asked"
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== factFor(s.key)?.value) saveFact(s.key, s.label, v);
                      }}
                    />
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
