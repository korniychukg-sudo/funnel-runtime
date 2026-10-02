import { useState, type FormEvent } from 'react';
import { readAdminToken, saveAdminToken } from '../adminApi';

export function TokenForm({ onSaved }: { onSaved: () => void }) {
  const [token, setToken] = useState('');
  const rejected = readAdminToken() !== null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = token.trim();
    if (!value) return;
    saveAdminToken(value);
    onSaved();
  }

  return (
    <form className="card panel token-form" onSubmit={submit}>
      <h2>Admin token required</h2>
      <p className="muted">
        This server runs with <code>ADMIN_TOKEN</code>. Enter it to continue. It is kept in this browser only.
      </p>
      {rejected && <p className="notice notice-error">The saved token was not accepted. Enter the current one.</p>}
      <label className="field">
        <span>Token</span>
        <input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          required
        />
      </label>
      <button type="submit" className="btn" disabled={!token.trim()}>
        Save and retry
      </button>
    </form>
  );
}
