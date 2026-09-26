'use client';

export function Pager({
  page,
  pages,
  total,
  limit,
  shown,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  limit: number;
  shown: number;
  onPage: (p: number) => void;
}) {
  if (total === 0 || pages <= 1) return null;
  const first = (page - 1) * limit + 1;
  return (
    <div
      className="row"
      style={{ gap: '.5rem', alignItems: 'center', marginTop: '.9rem', borderTop: '1px solid var(--border)', paddingTop: '.8rem' }}
    >
      <button disabled={page <= 1} onClick={() => onPage(1)}>
        « first
      </button>
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ‹ previous
      </button>
      <span className="muted small" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {first}–{first + shown - 1} of {total} · page {page} of {pages}
      </span>
      <button disabled={page >= pages} onClick={() => onPage(page + 1)}>
        next ›
      </button>
      <button disabled={page >= pages} onClick={() => onPage(pages)}>
        last »
      </button>
    </div>
  );
}
