import { useEffect, useState } from 'react';
import { asRequestError, fetchVersion, isUnauthorized, type RequestError } from '../adminApi';
import { ErrorNotice } from './ErrorNotice';

type Props = {
  version: number;
  onUnauthorized: () => void;
};

export function VersionJson({ version, onUnauthorized }: Props) {
  const [json, setJson] = useState<string | null>(null);
  const [error, setError] = useState<RequestError | null>(null);

  useEffect(() => {
    let ignore = false;
    fetchVersion(version).then(
      (detail) => {
        if (!ignore) setJson(JSON.stringify(detail.config, null, 2));
      },
      (failure: unknown) => {
        if (ignore) return;
        const requestError = asRequestError(failure);
        if (isUnauthorized(requestError)) onUnauthorized();
        else setError(requestError);
      },
    );
    return () => {
      ignore = true;
    };
  }, [version, onUnauthorized]);

  if (error) return <ErrorNotice error={error} />;
  if (json === null) return <p className="muted">Loading config…</p>;
  return (
    <pre className="json-view" tabIndex={0} aria-label={`Config of version ${version}`}>
      {json}
    </pre>
  );
}
