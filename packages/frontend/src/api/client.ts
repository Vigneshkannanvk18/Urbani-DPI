import type { ApiError } from '@urbani/shared';

/**
 * Typed API client. The dashboard talks ONLY to the backend API (proxied at
 * /api). It never imports an AWS SDK or knows about mock-vs-live — provenance
 * arrives as a `source` field in the response envelope.
 */

const TOKEN_KEY = 'urbani.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  /** Use this bearer token instead of the stored session (MFA enrolment-only token). */
  token?: string;
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = opts.token ?? getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && !opts.token) {
    clearToken();
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = (data as ApiError)?.error;
    throw new ApiClientError(res.status, err?.code ?? 'ERROR', err?.message ?? res.statusText, (err as { details?: unknown } | undefined)?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body, opts),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

export interface DownloadResult {
  blob: Blob;
  filename: string;
  rows: number | null;
  truncated: boolean;
  source: string | null;
}

/** Authenticated file download (exports): fetch with the bearer token -> Blob. Errors carry the API message. */
export async function downloadFile(path: string): Promise<DownloadResult> {
  const token = getToken();
  const res = await fetch(`/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (res.status === 401) clearToken();
  if (!res.ok) {
    let message = res.statusText;
    let code = 'ERROR';
    try {
      const err = (JSON.parse(await res.text()) as ApiError)?.error;
      message = err?.message ?? message;
      code = err?.code ?? code;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiClientError(res.status, code, message);
  }
  const cd = res.headers.get('Content-Disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'urbani-export';
  const rows = res.headers.get('X-Export-Rows');
  return {
    blob: await res.blob(),
    filename,
    rows: rows === null ? null : Number(rows),
    truncated: res.headers.get('X-Export-Truncated') === 'true',
    source: res.headers.get('X-Export-Source'),
  };
}

/** Trigger the browser save dialog for a Blob. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Clear message for an export failure. */
export function exportErrorMessage(e: unknown): string {
  if (e instanceof ApiClientError) {
    if (e.status === 401) return 'Your session has expired. Sign in again to export.';
    if (e.status === 403) return 'You do not have permission to export.';
    if (e.status === 429) return 'Too many exports. Wait a minute and try again.';
    if (e.status === 400) return `These filters cannot be exported: ${e.message}`;
    return `Export failed: ${e.message}`;
  }
  return 'Export failed. Check your connection and try again.';
}
