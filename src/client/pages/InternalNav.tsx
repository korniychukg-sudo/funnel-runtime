const LINKS = [
  { href: '/', label: 'Funnel' },
  { href: '/admin', label: 'Admin' },
  { href: '/dashboard', label: 'Dashboard' },
];

export function InternalNav({ active }: { active: '/admin' | '/dashboard' }) {
  return (
    <nav className="internal-nav" aria-label="Internal pages">
      <span className="brand">Funnel Runtime</span>
      {LINKS.map((link) => {
        const isActive = link.href === active;
        return (
          <a
            key={link.href}
            href={link.href}
            className={isActive ? 'active' : undefined}
            aria-current={isActive ? 'page' : undefined}
          >
            {link.label}
          </a>
        );
      })}
    </nav>
  );
}
