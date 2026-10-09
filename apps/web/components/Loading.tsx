/** A consistent "fetching" state, instead of each page inventing its own. */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div
      className="row muted small"
      style={{ justifyContent: 'center', padding: '2.5rem 0', gap: '.5rem' }}
    >
      <span className="spinner" />
      {label}
    </div>
  );
}
