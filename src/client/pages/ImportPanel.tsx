import { useState, type ChangeEvent } from 'react';
import type { VersionSummary } from '../../shared/api';
import {
  asRequestError,
  importConfig,
  importFixture,
  isUnauthorized,
  type ErrorMessage,
} from '../adminApi';
import { ErrorNotice } from './ErrorNotice';

type Props = {
  fixtures: string[];
  onImported: () => void;
  onUnauthorized: () => void;
};

export function ImportPanel({ fixtures, onImported, onUnauthorized }: Props) {
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorMessage | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function send(upload: () => Promise<VersionSummary>, source: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await upload();
      setSuccess(`v${created.version} imported from ${source} as a draft. Review it in the versions table, then publish.`);
      onImported();
      return true;
    } catch (failure) {
      const requestError = asRequestError(failure);
      if (isUnauthorized(requestError)) onUnauthorized();
      else setError(requestError);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function sendJson(text: string, source: string): Promise<boolean> {
    let config: unknown;
    try {
      config = JSON.parse(text);
    } catch (parseError) {
      const reason = parseError instanceof Error ? parseError.message : String(parseError);
      setSuccess(null);
      setError({ message: `${source} is not valid JSON: ${reason}` });
      return Promise.resolve(false);
    }
    return send(() => importConfig(config), source);
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await sendJson(await file.text(), file.name);
  }

  async function importPasted() {
    if (await sendJson(pasted, 'pasted JSON')) setPasted('');
  }

  return (
    <section className="card panel" aria-labelledby="import-title">
      <div className="panel-head">
        <div>
          <h2 id="import-title">Import a new version</h2>
          <p>Imports are stored as drafts. Nothing changes for users until a draft is published.</p>
        </div>
      </div>

      <div className="import-grid">
        <div className="import-block">
          <h3>From the configs folder</h3>
          {fixtures.length === 0 ? (
            <p className="muted">No fixtures found in configs/.</p>
          ) : (
            <div className="button-stack">
              {fixtures.map((file) => (
                <button
                  key={file}
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={busy}
                  onClick={() => send(() => importFixture(file), file)}
                >
                  Import {file} as draft
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="import-block">
          <h3>From a file</h3>
          <label className={busy ? 'btn btn-secondary btn-small file-button is-disabled' : 'btn btn-secondary btn-small file-button'}>
            Choose a .json config
            <input
              type="file"
              accept=".json,application/json"
              className="visually-hidden"
              disabled={busy}
              onChange={importFile}
            />
          </label>
        </div>
      </div>

      <div className="import-block">
        <h3>
          <label htmlFor="paste-config">Paste JSON</label>
        </h3>
        <textarea
          id="paste-config"
          className="code-input"
          rows={8}
          spellCheck={false}
          placeholder='{ "schemaVersion": "1.0", "funnelId": "…", "version": 4, … }'
          value={pasted}
          onChange={(event) => setPasted(event.target.value)}
        />
        <button type="button" className="btn btn-small" disabled={busy || !pasted.trim()} onClick={importPasted}>
          Import pasted JSON as draft
        </button>
      </div>

      <div aria-live="polite">
        {busy && <p className="muted">Importing…</p>}
        {success && <p className="notice notice-success">{success}</p>}
        {error && <ErrorNotice error={error} onDismiss={() => setError(null)} />}
      </div>
    </section>
  );
}
