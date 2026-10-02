import { Fragment, useState } from 'react';
import type { VersionStatus, VersionSummary } from '../../shared/api';
import { formatCount, formatDateTime } from './format';
import { VersionJson } from './VersionJson';

type Props = {
  versions: VersionSummary[];
  busy: boolean;
  onPublish: (version: VersionSummary) => void;
  onActivate: (version: VersionSummary) => void;
  onUnauthorized: () => void;
};

const STATUS_BADGE: Record<VersionStatus, { label: string; className: string }> = {
  draft: { label: 'draft', className: 'badge badge-warning' },
  published: { label: 'published', className: 'badge badge-success' },
  rolled_back: { label: 'rolled back', className: 'badge badge-danger' },
};

const COLUMN_COUNT = 7;

export function VersionsTable({ versions, busy, onPublish, onActivate, onUnauthorized }: Props) {
  const [openVersion, setOpenVersion] = useState<number | null>(null);
  const rows = [...versions].sort((a, b) => b.version - a.version);

  return (
    <section className="card panel" aria-labelledby="versions-title">
      <div className="panel-head">
        <div>
          <h2 id="versions-title">Versions</h2>
          <p>Publishing a draft makes it active at once. Activate brings back a published or rolled-back version.</p>
        </div>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Status</th>
              <th scope="col">Release note</th>
              <th scope="col">Created / published</th>
              <th scope="col" className="num">
                Sessions
              </th>
              <th scope="col" className="num">
                Events
              </th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((version) => {
              const badge = STATUS_BADGE[version.status];
              const canActivate = version.status !== 'draft' && !version.isActive;
              const isOpen = openVersion === version.version;
              return (
                <Fragment key={version.version}>
                  <tr className={version.isActive ? 'row-active' : undefined}>
                    <td className="version-cell">
                      <strong>v{version.version}</strong>
                      <span className="cell-sub">{version.title}</span>
                    </td>
                    <td>
                      <div className="chip-row">
                        <span className={badge.className}>{badge.label}</span>
                        {version.isActive && <span className="badge badge-accent">Active</span>}
                      </div>
                    </td>
                    <td className="note-cell">{version.releaseNote ?? <span className="muted">—</span>}</td>
                    <td className="nowrap">
                      {formatDateTime(version.createdAt)}
                      <span className="cell-sub">
                        {version.publishedAt ? `published ${formatDateTime(version.publishedAt)}` : 'not published'}
                      </span>
                    </td>
                    <td className="num">{formatCount(version.sessions)}</td>
                    <td className="num">{formatCount(version.events)}</td>
                    <td>
                      <div className="row-actions">
                        {version.status === 'draft' && (
                          <button type="button" className="btn btn-small" disabled={busy} onClick={() => onPublish(version)}>
                            Publish
                          </button>
                        )}
                        {canActivate && (
                          <button type="button" className="btn btn-small" disabled={busy} onClick={() => onActivate(version)}>
                            Activate
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          aria-expanded={isOpen}
                          onClick={() => setOpenVersion(isOpen ? null : version.version)}
                        >
                          {isOpen ? 'Hide JSON' : 'View JSON'}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="json-row">
                      <td colSpan={COLUMN_COUNT}>
                        <VersionJson version={version.version} onUnauthorized={onUnauthorized} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
