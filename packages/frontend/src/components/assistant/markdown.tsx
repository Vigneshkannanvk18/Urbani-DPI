import { Fragment, type ReactNode } from 'react';
import { parseMarkdown, type BlockToken, type InlineToken } from '@urbani/shared/markdown';

/**
 * Thin, XSS-safe React renderer for the assistant's markdown answer.
 *
 * The parsing + URL-sanitization logic lives in the pure, DOM-free
 * @urbani/shared helper (unit-tested in the backend vitest). This wrapper only
 * maps the resulting token tree to React elements — it NEVER uses
 * dangerouslySetInnerHTML, so React escapes all text by default. Links are only
 * emitted for scheme-allow-listed URLs (http/https); any other scheme was
 * already neutralized to literal text by the shared sanitizer.
 */
export function renderMarkdown(md: string): ReactNode {
  const blocks = parseMarkdown(md);
  return blocks.map((b, i) => <BlockView key={i} block={b} />);
}

function BlockView({ block }: { block: BlockToken }): ReactNode {
  switch (block.type) {
    case 'heading': {
      const Tag = (`h${block.level}` as unknown) as keyof JSX.IntrinsicElements;
      return <Tag className="md-h"><Inline tokens={block.children} /></Tag>;
    }
    case 'paragraph':
      return <p className="md-p"><Inline tokens={block.children} /></p>;
    case 'code':
      return (
        <pre className="md-pre">
          <code>{block.value}</code>
        </pre>
      );
    case 'blockquote':
      return <blockquote className="md-quote"><Inline tokens={block.children} /></blockquote>;
    case 'list':
      return block.ordered ? (
        <ol className="md-ol">
          {block.items.map((item, j) => (
            <li key={j}><Inline tokens={item} /></li>
          ))}
        </ol>
      ) : (
        <ul className="md-ul">
          {block.items.map((item, j) => (
            <li key={j}><Inline tokens={item} /></li>
          ))}
        </ul>
      );
    default:
      return null;
  }
}

function Inline({ tokens }: { tokens: InlineToken[] }): ReactNode {
  return (
    <>
      {tokens.map((t, i) => (
        <Fragment key={i}>
          <InlineView token={t} />
        </Fragment>
      ))}
    </>
  );
}

function InlineView({ token }: { token: InlineToken }): ReactNode {
  switch (token.type) {
    case 'text':
      return <>{token.value}</>;
    case 'bold':
      return <strong><Inline tokens={token.children} /></strong>;
    case 'italic':
      return <em><Inline tokens={token.children} /></em>;
    case 'code':
      return <code className="md-code">{token.value}</code>;
    case 'link':
      // href was already scheme-allow-listed by the shared sanitizer.
      return (
        <a href={token.href} rel="noopener noreferrer" target="_blank">
          <Inline tokens={token.children} />
        </a>
      );
    default:
      return null;
  }
}
