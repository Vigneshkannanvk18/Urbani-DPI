import { useState, type FormEvent } from 'react';
import { mfaApi, type MfaEnrolStart } from '../api/endpoints';
import { Button, Input } from './ui';

/** Shows the recovery codes exactly once, with copy and download. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([`Urbani Radar recovery codes\n\n${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'urbani-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="stack">
      <p>
        <strong>Save these recovery codes now.</strong> Each works once if you lose your authenticator. They will not be shown again.
      </p>
      <ul className="cell-mono" aria-label="Recovery codes" style={{ columns: 2, listStyle: 'none', padding: 0 }}>
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div>
        <Button variant="secondary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>{' '}
        <Button variant="secondary" onClick={download}>Download</Button>{' '}
        <Button onClick={onDone}>I have saved them</Button>
      </div>
    </div>
  );
}

/**
 * Enrolment: QR + manual key, then a confirm code. `token` is the enrolment-only token during forced
 * enrolment (omit for a normal session). `onEnrolled` gets the full-session token when one is issued.
 */
export function MfaEnroll({ token, onEnrolled }: { token?: string; onEnrolled: (sessionToken?: string) => void }) {
  const [start, setStart] = useState<MfaEnrolStart | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [sessionToken, setSessionToken] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      setStart(await mfaApi.start(token));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start enrolment');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await mfaApi.confirm(code, token);
      setCodes(res.recoveryCodes);
      setSessionToken(res.session?.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  };

  if (codes) return <RecoveryCodes codes={codes} onDone={() => onEnrolled(sessionToken)} />;

  return (
    <div className="stack">
      {error && <div className="form-error" role="alert">{error}</div>}
      {!start ? (
        <Button onClick={() => void begin()} disabled={busy}>{busy ? 'Starting…' : 'Set up authenticator app'}</Button>
      ) : (
        <>
          <p>Scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password), or enter the key manually.</p>
          <img src={start.qrDataUrl} alt="QR code for the authenticator app" width={224} height={224} />
          <p>Manual key: <code className="cell-mono" data-testid="mfa-secret">{start.secret}</code></p>
          <form className="user-form" onSubmit={confirm}>
            <label className="field">
              <span className="field-label">6-digit code from the app</span>
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]{6,7}"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <Button type="submit" disabled={busy}>{busy ? 'Verifying…' : 'Confirm and enable'}</Button>
          </form>
        </>
      )}
    </div>
  );
}
