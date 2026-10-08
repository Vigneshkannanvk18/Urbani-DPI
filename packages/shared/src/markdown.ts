/**
 * Pure, DOM-free markdown tokenizer + URL sanitizer.
 *
 * This module contains NO React / DOM references so it is unit-testable in a
 * plain Node (vitest) runner. The frontend renders these tokens to React
 * elements (never dangerouslySetInnerHTML), and the security-relevant pieces —
 * the URL scheme allow-list and link neutralization — live HERE where they are
 * directly asserted.
 *
 * The assistant answer is UNTRUSTED model output. Links are rendered as anchors
 * ONLY when the URL passes the scheme allow-list (http/https); any other scheme
 * (javascript:, data:, vbscript:, file:, …) is neutralized to literal text.
 */

/** Allowed URL schemes for rendered links. Everything else is neutralized. */
export const ALLOWED_LINK_SCHEMES = ['http:', 'https:'] as const;

/**
 * Return the URL if it is a safe http(s) link, else null (neutralize). Handles
 * leading/trailing whitespace, control characters, and case/entity tricks like
 * "javascript:", " JavaScript:", and "java\tscript:".
 */
export function sanitizeUrl(raw: string): string | null {
  // Strip ASCII control chars (incl. tab/newline) that can split a scheme, then trim.
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned) return null;

  // A scheme is [a-z][a-z0-9+.-]* immediately followed by ':'. If present, it
  // must be in the allow-list. Relative URLs (no scheme) are rejected too — we
  // only render absolute http(s) links from untrusted output.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (!schemeMatch) return null;
  const scheme = `${schemeMatch[1].toLowerCase()}:`;
  return (ALLOWED_LINK_SCHEMES as readonly string[]).includes(scheme) ? cleaned : null;
}

// ---- Inline tokens ----------------------------------------------------------

export type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'bold'; children: InlineToken[] }
  | { type: 'italic'; children: InlineToken[] }
  | { type: 'code'; value: string }
  | { type: 'link'; href: string; children: InlineToken[] };

// ---- Block tokens -----------------------------------------------------------

export type BlockToken =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; children: InlineToken[] }
  | { type: 'paragraph'; children: InlineToken[] }
  | { type: 'code'; value: string }
  | { type: 'blockquote'; children: InlineToken[] }
  | { type: 'list'; ordered: boolean; items: InlineToken[][] };

/**
 * Parse markdown into a block token tree. Supported subset: fenced code blocks,
 * ATX headings, unordered (dash/star/plus) and ordered lists, blockquotes, and
 * paragraphs with soft line breaks. Inline: bold, italic, inline code, and
 * [text](url) links (url scheme-allow-listed).
 */
export function parseMarkdown(md: string): BlockToken[] {
  const lines = (md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: BlockToken[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    if (/^```/.test(line.trim())) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      blocks.push({ type: 'code', value: buf.join('\n') });
      continue;
    }

    // Blank line.
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Heading.
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({
        type: 'heading',
        level: h[1].length as 1 | 2 | 3 | 4,
        children: parseInline(h[2].trim()),
      });
      i++;
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: InlineToken[][] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\s*[-*+]\s+/, '')));
        i++;
      }
      blocks.push({ type: 'list', ordered: false, items });
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: InlineToken[][] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\s*\d+\.\s+/, '')));
        i++;
      }
      blocks.push({ type: 'list', ordered: true, items });
      continue;
    }

    // Blockquote.
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', children: parseInline(buf.join(' ')) });
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-structural lines.
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^```/.test(lines[i].trim()) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ type: 'paragraph', children: parseInline(buf.join('\n')) });
  }

  return blocks;
}

/**
 * Parse inline markdown. Order matters: inline code is extracted first (its
 * contents are literal), then links, then bold, then italic.
 */
export function parseInline(text: string): InlineToken[] {
  if (!text) return [];

  // Inline code `...` — contents are literal (no further parsing).
  const codeMatch = /`([^`]+)`/.exec(text);
  if (codeMatch && codeMatch.index !== undefined) {
    const before = text.slice(0, codeMatch.index);
    const after = text.slice(codeMatch.index + codeMatch[0].length);
    return [
      ...parseInline(before),
      { type: 'code', value: codeMatch[1] },
      ...parseInline(after),
    ];
  }

  // Links [text](url). The URL is scheme-allow-listed; a disallowed scheme is
  // rendered as literal text (the whole [text](url) stays verbatim).
  const linkMatch = /\[([^\]]*)\]\(([^)]*)\)/.exec(text);
  if (linkMatch && linkMatch.index !== undefined) {
    const before = text.slice(0, linkMatch.index);
    const after = text.slice(linkMatch.index + linkMatch[0].length);
    const href = sanitizeUrl(linkMatch[2]);
    if (href) {
      return [
        ...parseInline(before),
        { type: 'link', href, children: parseInline(linkMatch[1]) },
        ...parseInline(after),
      ];
    }
    // Neutralized: keep the raw markdown as literal text (no anchor emitted).
    return [
      ...parseInline(before),
      { type: 'text', value: linkMatch[0] },
      ...parseInline(after),
    ];
  }

  // Bold **...**.
  const boldMatch = /\*\*([^*]+)\*\*/.exec(text);
  if (boldMatch && boldMatch.index !== undefined) {
    const before = text.slice(0, boldMatch.index);
    const after = text.slice(boldMatch.index + boldMatch[0].length);
    return [
      ...parseInline(before),
      { type: 'bold', children: parseInline(boldMatch[1]) },
      ...parseInline(after),
    ];
  }

  // Italic *...* or _..._.
  const italicMatch = /(?:\*([^*]+)\*|_([^_]+)_)/.exec(text);
  if (italicMatch && italicMatch.index !== undefined) {
    const before = text.slice(0, italicMatch.index);
    const after = text.slice(italicMatch.index + italicMatch[0].length);
    const inner = italicMatch[1] ?? italicMatch[2] ?? '';
    return [
      ...parseInline(before),
      { type: 'italic', children: parseInline(inner) },
      ...parseInline(after),
    ];
  }

  return [{ type: 'text', value: text }];
}
