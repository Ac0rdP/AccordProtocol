import type { ReactNode } from "react";

type MarkdownDescriptionProps = {
  text: string;
  className?: string;
  emptyMessage?: string;
};

function isSafeLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function renderInline(text: string): ReactNode[] {
  const pattern =
    /(\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|__([^_]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_|`([^`]+)`|~~(.+?)~~)/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const key = `${match.index}-${match[0]}`;
    if (match[2] && match[3]) {
      nodes.push(
        isSafeLink(match[3]) ? (
          <a
            key={key}
            href={match[3]}
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-400 underline underline-offset-2"
          >
            {match[2]}
          </a>
        ) : (
          match[2]
        ),
      );
    } else if (match[4] || match[5]) {
      nodes.push(<strong key={key}>{match[4] ?? match[5]}</strong>);
    } else if (match[6] || match[7]) {
      nodes.push(<em key={key}>{match[6] ?? match[7]}</em>);
    } else if (match[8]) {
      nodes.push(
        <code key={key} className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[0.9em]">
          {match[8]}
        </code>,
      );
    } else if (match[9]) {
      nodes.push(<del key={key}>{match[9]}</del>);
    }
    cursor = pattern.lastIndex;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function isBlockStart(line: string): boolean {
  return /^(?:#{1,6}\s+.+|>\s?.+|[-*]\s+.+|\d+\.\s+.+)$/.test(line);
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      const className =
        level === 1
          ? "text-lg font-semibold"
          : level === 2
            ? "text-base font-semibold"
            : "text-sm font-semibold";
      const content = renderInline(heading[2]);
      const key = `heading-${index}`;
      const Heading = `h${level}` as "h1" | "h2" | "h3" | "h4";
      blocks.push(
        <Heading key={key} className={className}>
          {content}
        </Heading>,
      );
      index += 1;
      continue;
    }

    const unordered = /^[-*]\s+(.+)$/.exec(line);
    const ordered = /^\d+\.\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      const items: string[] = [];
      const listPattern = unordered ? /^[-*]\s+(.+)$/ : /^\d+\.\s+(.+)$/;
      while (index < lines.length) {
        const item = listPattern.exec(lines[index]);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      const List = unordered ? "ul" : "ol";
      blocks.push(
        <List
          key={`list-${index}`}
          className={`list-inside space-y-1 pl-2 ${
            unordered ? "list-disc" : "list-decimal"
          }`}
        >
          {items.map((item, itemIndex) => (
            <li key={`${itemIndex}-${item}`}>{renderInline(item)}</li>
          ))}
        </List>,
      );
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const item = /^>\s?(.*)$/.exec(lines[index]);
        if (!item) break;
        quoted.push(item[1]);
        index += 1;
      }
      blocks.push(
        <blockquote
          key={`quote-${index}`}
          className="border-l-2 border-zinc-600 pl-3 italic text-zinc-400"
        >
          {renderInline(quoted.join("\n"))}
        </blockquote>,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isBlockStart(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={`paragraph-${index}`} className="whitespace-pre-wrap">
        {renderInline(paragraph.join("\n"))}
      </p>,
    );
  }

  return blocks;
}

export function MarkdownDescription({
  text,
  className = "",
  emptyMessage = "No description provided.",
}: MarkdownDescriptionProps) {
  const content = text.trim();
  return (
    <div className={`space-y-2 break-words leading-7 ${className}`}>
      {content ? renderBlocks(content) : <p>{emptyMessage}</p>}
    </div>
  );
}
