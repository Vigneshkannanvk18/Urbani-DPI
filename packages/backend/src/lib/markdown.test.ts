import { describe, it, expect } from 'vitest';
import { sanitizeUrl, parseMarkdown, parseInline } from '@urbani/shared';

/**
 * The assistant renders UNTRUSTED model markdown. The security-relevant pieces
 * (scheme allow-list + link neutralization) live in the pure @urbani/shared
 * helper so they are directly asserted here in the backend vitest runner (the
 * only configured runner). The thin React wrapper is verified by tsc -b + vite
 * build; it never calls dangerouslySetInnerHTML.
 */
describe('markdown URL sanitizer', () => {
  it('allows http/https links', () => {
    expect(sanitizeUrl('https://example.com/path')).toBe('https://example.com/path');
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com');
  });

  it('neutralizes javascript: URLs', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeUrl('  JavaScript:alert(1)')).toBeNull();
    expect(sanitizeUrl('java\tscript:alert(1)')).toBeNull();
  });

  it('neutralizes data: and other disallowed schemes', () => {
    expect(sanitizeUrl('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
    expect(sanitizeUrl('vbscript:msgbox(1)')).toBeNull();
    expect(sanitizeUrl('file:///etc/passwd')).toBeNull();
    // Relative/scheme-less URLs are also rejected (only absolute http(s)).
    expect(sanitizeUrl('/relative/path')).toBeNull();
  });
});

describe('markdown inline parsing', () => {
  it('renders a safe link as a link token', () => {
    const tokens = parseInline('see [docs](https://example.com)');
    const link = tokens.find((t) => t.type === 'link');
    expect(link).toBeDefined();
    expect(link && link.type === 'link' && link.href).toBe('https://example.com');
  });

  it('renders a javascript: link as LITERAL TEXT (no link token / no anchor)', () => {
    const tokens = parseInline('click [here](javascript:alert(1)) now');
    expect(tokens.some((t) => t.type === 'link')).toBe(false);
    const joined = tokens
      .filter((t): t is { type: 'text'; value: string } => t.type === 'text')
      .map((t) => t.value)
      .join('');
    expect(joined).toContain('[here](javascript:alert(1))');
  });

  it('parses bold, italic and inline code', () => {
    expect(parseInline('**b**').some((t) => t.type === 'bold')).toBe(true);
    expect(parseInline('_i_').some((t) => t.type === 'italic')).toBe(true);
    expect(parseInline('`c`').some((t) => t.type === 'code')).toBe(true);
  });
});

describe('markdown block parsing', () => {
  it('parses headings, lists and fenced code', () => {
    const blocks = parseMarkdown('# Title\n\n- one\n- two\n\n```\ncode\n```');
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1 });
    const list = blocks.find((b) => b.type === 'list');
    expect(list && list.type === 'list' && list.items.length).toBe(2);
    const code = blocks.find((b) => b.type === 'code');
    expect(code && code.type === 'code' && code.value).toBe('code');
  });

  it('parses an ordered list and a blockquote', () => {
    const blocks = parseMarkdown('1. first\n2. second\n\n> a quote');
    const ordered = blocks.find((b) => b.type === 'list');
    expect(ordered && ordered.type === 'list' && ordered.ordered).toBe(true);
    expect(blocks.some((b) => b.type === 'blockquote')).toBe(true);
  });
});
