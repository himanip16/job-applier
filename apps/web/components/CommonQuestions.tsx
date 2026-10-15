'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from './Icon';
import s from '../app/profile/profile.module.css';

interface Fact { id: string; key: string; label: string; value: string }

/**
 * The questions nearly every form asks. Answering them once here is what
 * stops the popup appearing on every application. Stored as profile facts;
 * shown on the Answers page, which is where a person looks for "my answers".
 */
const QUESTIONS: { key: string; label: string }[] = [
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
  { key: 'legal.meets_min_qualifications', label: 'Certify you meet the minimum qualifications of jobs you apply to' },
  { key: 'identity.legal_name_matches_id', label: 'Legal name matches your government ID' },
  { key: 'history.worked_here_before', label: 'Previously worked for the companies you apply to' },
  { key: 'history.family_employed', label: 'Family member works at the companies you apply to' },
  { key: 'contact.sms_opt_in', label: 'Get recruiting updates by text message' },
  { key: 'history.source', label: 'How did you hear about this role' },
];

export function CommonQuestions() {
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [hasProfile, setHasProfile] = useState(true);
  const [justSaved, setJustSaved] = useState<string[]>([]);

  const load = useCallback(async () => {
    const d = await api<{ profile: { facts: Fact[] } | null }>('/api/profile');
    setHasProfile(Boolean(d.profile));
    setFacts(d.profile?.facts ?? []);
  }, []);

  useEffect(() => { void load().catch(() => setFacts([])); }, [load]);

  async function save(key: string, label: string, value: string) {
    await api('/api/facts', { method: 'POST', body: JSON.stringify({ key, label, value }) });
    setJustSaved((k) => [...k, key]);
    await load();
  }

  const valueOf = (key: string) => facts?.find((f) => f.key === key)?.value ?? '';
  const answered = QUESTIONS.filter((q) => valueOf(q.key)).length;

  return (
    <section className={s.section}>
      <div className={s.sectionHead}>
        <div className={s.sectionTitle}>
          <span className={s.sectionIcon}><Icon name="checkCircle" size={18} /></span>
          <div>
            <h2>Common questions</h2>
            <p>Asked on nearly every form. Answer once here and they are filled for you; leave one blank and you are asked the first time it comes up. Saves as you leave each box.</p>
          </div>
        </div>
        {hasProfile && facts && (
          <span className={s.counter}><strong>{answered}</strong> of {QUESTIONS.length} answered</span>
        )}
      </div>

      {!hasProfile ? (
        <div className={s.locked}>
          These unlock once you have a profile. <a href="/profile">Set it up</a> — adding your resume is enough.
        </div>
      ) : facts === null ? (
        <div className={s.locked}>Loading…</div>
      ) : (
        <div className={s.answers}>
          {QUESTIONS.map((q) => (
            <div className={s.answer} key={q.key}>
              <label htmlFor={`fact-${q.key}`}>{q.label}</label>
              <input
                id={`fact-${q.key}`}
                type="text"
                defaultValue={valueOf(q.key)}
                placeholder="Not set — you'll be asked"
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== valueOf(q.key)) void save(q.key, q.label, v);
                }}
              />
              <span aria-hidden>{justSaved.includes(q.key) && <Icon name="check" size={16} className={s.tick} />}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
