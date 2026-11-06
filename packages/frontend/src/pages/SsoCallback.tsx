import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Loading } from '../components/ui';

/** Landing page after the SSO redirect: the backend puts the session token in the URL fragment. */
export function SsoCallback() {
  const { acceptSession } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
    // Remove the token from the address bar and history immediately.
    window.history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setError('No sign-in token was received.');
      return;
    }
    acceptSession(token)
      .then(() => navigate('/', { replace: true }))
      .catch(() => setError('Single sign-on could not be completed.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div style={{ maxWidth: 420, margin: '4rem auto', fontFamily: 'sans-serif' }}>
        <h1>Sign-in failed</h1>
        <p role="alert">{error}</p>
        <Link to="/login">Back to sign in</Link>
      </div>
    );
  }
  return <Loading label="Completing sign-in…" />;
}
