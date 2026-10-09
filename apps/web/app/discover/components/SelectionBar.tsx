'use client';

/**
 * "Keywords only" is the state this bar exists for.
 *
 * A crawl reads the top slice properly and ranks the rest on word counts, so
 * most of the queue carries a score nobody stands behind. Ticking the ones
 * that look interesting and pressing this reads exactly those.
 */
export function SelectionBar({
  picked,
  max,
  allPicked,
  pageCount,
  busy,
  onToggleAll,
  onClear,
  onRescore,
  applying,
  onAutoApply,
}: {
  picked: string[];
  max: number;
  allPicked: boolean;
  pageCount: number;
  busy: boolean;
  onToggleAll: () => void;
  onClear: () => void;
  onRescore: () => void;
  /** "applied 3 of 8", while a batch is being queued; null otherwise. */
  applying: string | null;
  onAutoApply: () => void;
}) {
  const over = picked.length > max;
  if (pageCount === 0 && picked.length === 0) return null;
  return (
    <div
      className="row discover-selection"
      style={{
        gap: '.6rem',
        alignItems: 'center',
        marginTop: '.6rem',
        paddingBottom: '.2rem',
        flexWrap: 'wrap',
      }}
    >
      <label className="row small muted" style={{ gap: '.35rem' }}>
        <input
          type="checkbox"
          checked={allPicked}
          disabled={pageCount === 0}
          onChange={onToggleAll}
        />
        select this page
      </label>

      {picked.length > 0 && <button
        className="primary"
        disabled={picked.length === 0 || busy}
        onClick={onRescore}
        title="Send the ticked postings to the model to be read properly"
      >
        {busy
          ? 'Reading…'
          : `Rescore selected${picked.length ? ` (${Math.min(picked.length, max)})` : ''}`}
      </button>}

      {picked.length > 0 && (
        <button
          className="primary"
          disabled={busy || applying !== null}
          onClick={onAutoApply}
          title="Apply to every ticked job and submit each one without asking. Anything that needs you is set aside and the rest carry on."
        >
          {applying ?? `Auto-apply to ${picked.length}`}
        </button>
      )}

      {picked.length > 0 && (
        <button onClick={onClear} disabled={busy || applying !== null}>
          clear selection
        </button>
      )}

      <span className="muted small">
        {picked.length === 0
          ? 'Select jobs to auto-apply to, or for a deeper match assessment.'
          : over
            ? `${picked.length} ticked; the first ${max} will be read. Run it again for the rest.`
            : `${picked.length} ticked, here and on other pages.`}
      </span>
    </div>
  );
}
