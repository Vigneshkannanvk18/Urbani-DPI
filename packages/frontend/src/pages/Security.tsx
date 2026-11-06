import { useState, type FormEvent } from 'react';
import { useApi } from '../hooks/useApi';
import { mfaApi, type MfaCredential } from '../api/endpoints';
import { PageHeader, Card, Button, Input, AsyncView, fmtTime } from '../components/ui';
import { MfaEnroll, RecoveryCodes } from '../components/MfaEnroll';

/** Account security (DPI 2 item 5): MFA status, enrolment, recovery codes, disable. */
export function Security() {
  const status = useApi(() => mfaApi.status(), []);
  const [mode, setMode] = useState<'view' | 'enrol' | 'disable' | 'regen'>('view');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);

  const cred = (): MfaCredential => (useRecovery ? { recoveryCode: code } : { code });
  const reset = () => { setMode('view'); setPassword(''); setCode(''); setUseRecovery(false); setError(null); status.reload(); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (mode === 'disable') {
        await mfaApi.disable(password, cred());
        reset();
      } else {
        setNewCodes((await mfaApi.regenerate(password, cred())).recoveryCodes);
        setMode('view');
        setPassword('');
        setCode('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    }
  };

  return (
    <div className="stack">
      <PageHeader title="Account security" subtitle="Two-step verification with an authenticator app (TOTP)." source="LIVE" />
      {newCodes && (
        <Card title="New recovery codes">
          <RecoveryCodes codes={newCodes} onDone={() => { setNewCodes(null); status.reload(); }} />
        </Card>
      )}
      <Card title="Two-step verification">
        <AsyncView state={status}>
          {(s) => (
            <div className="stack">
              {s.authSource === 'sso' ? (
                <p>You sign in with single sign-on. Two-step verification is enforced by your identity provider.</p>
              ) : mode === 'enrol' ? (
                <MfaEnroll onEnrolled={reset} />
              ) : (
                <>
                  <p>
                    Status: <strong>{s.enabled ? 'Enabled' : 'Not enabled'}</strong>
                    {s.enabled && <> since {fmtTime(s.enrolledAt)}. Recovery codes left: {s.recoveryCodesRemaining}.</>}
                    {s.required && <> Required for your role.</>}
                  </p>
                  {!s.enabled && mode === 'view' && <Button onClick={() => setMode('enrol')}>Enable two-step verification</Button>}
                  {s.enabled && mode === 'view' && (
                    <div>
                      <Button variant="secondary" onClick={() => setMode('regen')}>Regenerate recovery codes</Button>{' '}
                      {!s.required && <Button variant="ghost" onClick={() => setMode('disable')}>Disable</Button>}
                    </div>
                  )}
                  {(mode === 'disable' || mode === 'regen') && (
                    <form className="user-form" onSubmit={submit}>
                      {error && <div className="form-error" role="alert">{error}</div>}
                      <label className="field">
                        <span className="field-label">Current password</span>
                        <Input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                      </label>
                      <label className="field">
                        <span className="field-label">{useRecovery ? 'Recovery code' : '6-digit code'}</span>
                        <Input required autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
                      </label>
                      <label className="login-check">
                        <input type="checkbox" checked={useRecovery} onChange={(e) => setUseRecovery(e.target.checked)} />
                        <span>Use a recovery code instead</span>
                      </label>
                      <Button type="submit">{mode === 'disable' ? 'Disable two-step verification' : 'Regenerate codes'}</Button>{' '}
                      <Button type="button" variant="ghost" onClick={reset}>Cancel</Button>
                    </form>
                  )}
                </>
              )}
            </div>
          )}
        </AsyncView>
      </Card>
    </div>
  );
}
