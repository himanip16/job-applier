'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API, api } from '../../lib/api';
import { Icon, type IconName } from '../../components/Icon';
import s from './profile.module.css';

interface Fact { id: string; key: string; label: string; value: string }
interface Resume { id: string; label: string; filename: string; bytes: number; isDefault: boolean }
interface Profile {
  id: string; email: string; fullName: string; firstName: string; lastName: string;
  phone: string | null; city: string | null; region: string | null; country: string | null;
  countryCode: string | null; citizenship: string | null; expectedCTC: string | null; linkedin: string | null; github: string | null; website: string | null; portfolio: string | null; summary: string | null;
  facts: Fact[]; resumes: Resume[];
}

type Key = keyof Profile;

/** The details, in the groups a person thinks of them in. */
const GROUPS: { title: string; icon: IconName; fields: [Key, string, string?][] }[] = [
  { title: 'Name', icon: 'user', fields: [['fullName', 'Full name'], ['firstName', 'First name'], ['lastName', 'Last name']] },
  { title: 'Contact', icon: 'mail', fields: [['email', 'Email', 'you@example.com'], ['phone', 'Phone', '+91 98765 43210']] },
  { title: 'Location', icon: 'pin', fields: [['city', 'City'], ['region', 'State / region'], ['country', 'Country'], ['countryCode', 'Country code'], ['citizenship', 'Citizenship']] },
  { title: 'Links', icon: 'link', fields: [['linkedin', 'LinkedIn', 'linkedin.com/in/…'], ['github', 'GitHub', 'github.com/…'], ['website', 'Website'], ['portfolio', 'Portfolio']] },
  { title: 'Salary', icon: 'wallet', fields: [['expectedCTC', 'Expected CTC', 'e.g. 45 LPA']] },
];

const FIELDS: [Key, string][] = GROUPS.flatMap((g) => g.fields.map(([k, l]) => [k, l] as [Key, string]));
const URL_FIELDS: Key[] = ['linkedin', 'github', 'website', 'portfolio'];

/** How long after the last keystroke the profile saves itself. */
const AUTOSAVE_MS = 900;

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'waiting'; reason: string }
  | { kind: 'error'; reason: string };

const trimmed = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
/** "linkedin.com/in/x" is what people type; the server wants a full address. */
const asUrl = (v: string) => (v && !/^https?:\/\//i.test(v) ? `https://${v}` : v);

export default function ProfilePage() {
  const [profile, setProfile] = useState<Partial<Profile>>({});
  const [loaded, setLoaded] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [filling, setFilling] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [fresh, setFresh] = useState<Key[]>([]);
  // Edits since the last save; only these trigger an autosave.
  const dirty = useRef(false);

  const load = useCallback(async () => {
    const d = await api<{ profile: Profile | null }>('/api/profile');
    dirty.current = false;
    setProfile(d.profile ?? {});
    setLoaded(true);
  }, []);

  useEffect(() => { load().catch((e) => setNotice({ ok: false, text: e.message })); }, [load]);

  const persist = useCallback(async (p: Partial<Profile>) => {
    const missing = [
      !trimmed(p.fullName) && 'name',
      !trimmed(p.firstName) && 'first name',
      !trimmed(p.email) && 'email',
    ].filter(Boolean) as string[];
    if (missing.length) {
      setSave({ kind: 'waiting', reason: `Add your ${missing.join(', ')} to start saving` });
      return;
    }
    setSave({ kind: 'saving' });
    try {
      const opt = (k: Key) => trimmed(p[k]) || undefined;
      await api('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({
          email: trimmed(p.email), fullName: trimmed(p.fullName),
          firstName: trimmed(p.firstName), lastName: trimmed(p.lastName),
          phone: opt('phone'), city: opt('city'), region: opt('region'), country: opt('country'),
          countryCode: opt('countryCode'), citizenship: opt('citizenship'), expectedCTC: opt('expectedCTC'),
          linkedin: opt('linkedin') && asUrl(opt('linkedin')!), github: opt('github') && asUrl(opt('github')!),
          website: opt('website') && asUrl(opt('website')!), portfolio: opt('portfolio') && asUrl(opt('portfolio')!), summary: opt('summary'),
        }),
      });
      dirty.current = false;
      setSave({ kind: 'saved' });
      // A first save creates the profile: pick up its id so resume and answers unlock.
      if (!p.id) await load();
    } catch (e) {
      const msg = (e as Error).message;
      setSave({ kind: 'error', reason: /invalid input/i.test(msg) ? 'Check the email and links — one of them is not valid' : msg });
    }
  }, [load]);

  // Autosave: a moment after you stop typing.
  useEffect(() => {
    if (!loaded || !dirty.current) return;
    const t = setTimeout(() => void persist(profile), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [profile, loaded, persist]);

  const edit = (patch: Partial<Profile>) => {
    dirty.current = true;
    setProfile((p) => ({ ...p, ...patch }));
  };

  async function upload(file: File) {
    setUploading(true);
    setNotice(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API}/api/resume`, { method: 'POST', body: fd, credentials: 'include' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Upload failed');
      const filled: Key[] = body.filled ?? [];
      await load();
      setFresh(filled);
      setNotice({
        ok: !body.warning,
        text: body.warning
          ? `Uploaded, but: ${body.warning}`
          : filled.length
            ? `Resume added, and ${filled.length} detail${filled.length === 1 ? '' : 's'} filled in from it: ${filled.map(labelOf).join(', ')}.`
            : 'Resume added.',
      });
    } catch (e) {
      setNotice({ ok: false, text: (e as Error).message });
    } finally {
      setUploading(false);
    }
  }

  /** Fill the empty boxes from the resume; autosave takes it from there. */
  async function autofill() {
    setFilling(true);
    setNotice(null);
    try {
      const d = await api<{ details: Record<string, string>; reason?: string }>('/api/profile/autofill');
      const empty = Object.entries(d.details).filter(([k, v]) => v && !trimmed(profile[k as Key]));
      if (!empty.length) {
        setNotice({ ok: true, text: d.reason ?? 'Nothing new to fill: every detail your resume has is already here.' });
      } else {
        edit(Object.fromEntries(empty) as Partial<Profile>);
        setFresh(empty.map(([k]) => k as Key));
        setNotice({ ok: true, text: `Filled ${empty.map(([k]) => labelOf(k)).join(', ')} from your resume.` });
      }
    } catch (e) {
      setNotice({ ok: false, text: (e as Error).message });
    } finally {
      setFilling(false);
    }
  }

  const filledCount = FIELDS.filter(([k]) => trimmed(profile[k])).length + (profile.resumes?.length ? 1 : 0);
  const totalCount = FIELDS.length + 1;
  const canSave = trimmed(profile.fullName) && trimmed(profile.firstName) && trimmed(profile.email);

  return (
    <div className={s.page}>
      <header className={s.header}>
        <div>
          <span className={s.eyebrow}>Your profile</span>
          <h1>Profile</h1>
          <p>What every application is filled from. Start with your resume; the rest mostly fills itself.</p>
        </div>
        <div className={s.meter}>
          <div className={s.meterLabel}>
            <span>Profile complete</span>
            <strong>{filledCount} of {totalCount}</strong>
          </div>
          <div className={s.meterTrack}>
            <div
              className={`${s.meterFill} ${filledCount === totalCount ? s.done : ''}`}
              style={{ width: `${Math.round((filledCount / totalCount) * 100)}%` }}
            />
          </div>
          <div className={s.saveActions}>
            <button
              type="button"
              className={s.saveBtn}
              onClick={() => void persist(profile)}
              disabled={!canSave || save.kind === 'saving'}
            >
              {save.kind === 'saving' ? (
                <>
                  <Icon name="refresh" size={14} className="spin" /> Saving…
                </>
              ) : (
                <>
                  <Icon name="save" size={14} /> Save
                </>
              )}
            </button>
            <SaveStatus state={save} />
          </div>
        </div>
      </header>

      {notice && (
        <div className={`notice ${notice.ok ? 'good' : 'bad'}`} role="status">
          <span className={s.toast}>
            <Icon name={notice.ok ? 'checkCircle' : 'alert'} size={15} /> {notice.text}
          </span>
        </div>
      )}

      {/* ---- Resume: first, because it fills everything else ---- */}
      <section className={s.section}>
        <div className={s.sectionHead}>
          <div className={s.sectionTitle}>
            <span className={s.sectionIcon}><Icon name="text" size={18} /></span>
            <div>
              <h2>Resume</h2>
              <p>Attached to your applications, and the only thing the AI may make claims from. Adding one fills in your details below.</p>
            </div>
          </div>
        </div>

        <label
          className={`${s.drop} ${profile.resumes?.length ? s.compact : ''} ${dragOver ? s.over : ''} ${uploading ? s.busy : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f && !uploading) void upload(f);
          }}
        >
          <input
            type="file"
            accept=".pdf,.doc,.docx"
            disabled={uploading}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }}
          />
          <span className={s.dropIcon}>
            <Icon name={uploading ? 'refresh' : 'upload'} size={20} className={uploading ? 'spin' : undefined} />
          </span>
          <span className={s.dropTitle}>
            {uploading ? 'Reading your resume…' : profile.resumes?.length ? 'Add another resume' : 'Drop your resume here, or choose a file'}
          </span>
          <span className={s.dropHint}>PDF, DOC or DOCX</span>
        </label>

        {profile.resumes?.length ? (
          <div className={s.files}>
            {profile.resumes.map((r) => (
              <div key={r.id} className={`${s.file} ${r.isDefault ? s.default : ''}`}>
                <Icon name="text" size={16} />
                <span className={s.fileName}>{r.filename}</span>
                <span className={s.fileMeta}>{(r.bytes / 1024).toFixed(0)} KB</span>
                {r.isDefault ? (
                  <span className={s.badge}><Icon name="star" size={12} /> Used for applications</span>
                ) : (
                  <button
                    className={s.ghostBtn}
                    onClick={async () => {
                      await api(`/api/resume/${r.id}/default`, { method: 'POST' });
                      await load();
                    }}
                  >
                    Use this one
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {/* ---- Details ---- */}
      <section className={s.section}>
        <div className={s.sectionHead}>
          <div className={s.sectionTitle}>
            <span className={s.sectionIcon}><Icon name="user" size={18} /></span>
            <div>
              <h2>Your details</h2>
              <p>These fill the name and contact half of every form directly, with no AI involved. Changes save automatically.</p>
            </div>
          </div>
          <button
            type="button"
            className={s.ghostBtn}
            onClick={autofill}
            disabled={filling}
            title="Fill the empty boxes with the name, email, phone and links on your resume"
          >
            <Icon name="sparkles" size={15} className={filling ? 'spin' : undefined} />
            {filling ? 'Reading…' : 'Autofill from resume'}
          </button>
        </div>

        <div className={s.groups}>
          {GROUPS.map((g) => (
            <div className={s.group} key={g.title}>
              <div className={s.groupTitle}><Icon name={g.icon} size={14} /> {g.title}</div>
              <div className={s.row}>
                {g.fields.map(([k, label, placeholder]) => (
                  <label className={`${s.field} ${fresh.includes(k) ? s.fresh : ''}`} key={k}>
                    <span>{label}</span>
                    <input
                      type={k === 'email' ? 'email' : k === 'phone' ? 'tel' : 'text'}
                      value={(profile[k] as string) ?? ''}
                      placeholder={placeholder}
                      onChange={(e) => edit({ [k]: e.target.value } as Partial<Profile>)}
                      onBlur={(e) => {
                        if (URL_FIELDS.includes(k) && e.target.value.trim()) edit({ [k]: asUrl(e.target.value.trim()) } as Partial<Profile>);
                      }}
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}

          <div className={s.group}>
            <div className={s.groupTitle}><Icon name="message" size={14} /> About you</div>
            <label className={s.field}>
              <span>Summary — used to ground cover letters</span>
              <textarea
                value={profile.summary ?? ''}
                placeholder="Two or three sentences on what you do and what you are looking for."
                onChange={(e) => edit({ summary: e.target.value })}
              />
            </label>
          </div>
        </div>
      </section>

      <a href="/answers" className={`${s.section} ${s.linkCard}`}>
        <span className={s.sectionIcon}><Icon name="checkCircle" size={18} /></span>
        <span>
          <strong>Visa, notice period, salary and other common questions</strong>
          <span className={s.linkHint}>Answer them once on the Answers page and forms stop asking.</span>
        </span>
        <Icon name="arrowRight" size={18} />
      </a>
    </div>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  const style = { marginTop: '.5rem', fontSize: 'var(--fs-xs)', display: 'flex', alignItems: 'center', gap: '.35rem' } as const;
  switch (state.kind) {
    case 'saving':
      return <div style={{ ...style, color: 'var(--muted)' }} role="status"><Icon name="refresh" size={12} className="spin" /> Saving…</div>;
    case 'saved':
      return <div style={{ ...style, color: 'var(--good)' }} role="status"><Icon name="check" size={12} /> All changes saved</div>;
    case 'waiting':
      return <div style={{ ...style, color: 'var(--muted)' }} role="status">{state.reason}</div>;
    case 'error':
      return <div style={{ ...style, color: 'var(--bad)' }} role="alert"><Icon name="alert" size={12} /> Not saved: {state.reason}</div>;
    default:
      return <div style={{ ...style, color: 'var(--muted)' }}>Changes save automatically</div>;
  }
}

/** A field key as the form labels it, for messages. */
function labelOf(key: string): string {
  return FIELDS.find(([k]) => k === key)?.[1] ?? key;
}
