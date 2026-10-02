const LINKS = [
  { href: '/?reset=1', note: 'Variant assigned by the server (hash)' },
  { href: '/?reset=1&variant=A', note: 'Forced variant A, counted as override traffic' },
  { href: '/?reset=1&variant=B', note: 'Forced variant B, counted as override traffic' },
];

export function QuickLinks() {
  return (
    <section className="card panel" aria-labelledby="quick-links-title">
      <div className="panel-head">
        <div>
          <h2 id="quick-links-title">Open a new session</h2>
          <p>Each link starts a fresh session on the active version in a new tab.</p>
        </div>
      </div>
      <ul className="link-list">
        {LINKS.map((link) => (
          <li key={link.href}>
            <a href={link.href} target="_blank" rel="noopener noreferrer" className="mono">
              {link.href}
            </a>
            <span className="cell-sub">{link.note}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
