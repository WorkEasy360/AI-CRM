import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The small Markdown subset help articles and help answers use: `## headings`, numbered and bulleted
 * lists, paragraphs, **bold** and `code`. Rendered as React elements only — never as HTML — so text
 * written by a model or a workspace admin cannot inject markup.
 */
export function HelpMarkdown({ text, className }: { text: string; className?: string }) {
  const blocks = React.useMemo(() => parseBlocks(text), [text]);
  return (
    <div className={cn("grid gap-2 text-sm leading-relaxed text-fg", className)}>
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          return (
            <p key={index} className="pt-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
              {block.text}
            </p>
          );
        }
        if (block.type === "ol") {
          return (
            <ol key={index} className="grid gap-1.5">
              {block.items.map((item, i) => (
                <li key={i} className="flex gap-2">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#dcfce7] text-[11px] font-semibold text-[#15803d]" aria-hidden>
                    {i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="sr-only">{`Step ${i + 1}: `}</span>
                    <Inline text={item} />
                  </span>
                </li>
              ))}
            </ol>
          );
        }
        if (block.type === "ul") {
          return (
            <ul key={index} className="grid gap-1">
              {block.items.map((item, i) => (
                <li key={i} className="flex gap-2">
                  <span aria-hidden className="mt-[0.55rem] size-1 shrink-0 rounded-full bg-fg-subtle" />
                  <span className="min-w-0">
                    <Inline text={item} />
                  </span>
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={index}>
            <Inline text={block.text} />
          </p>
        );
      })}
    </div>
  );
}

type Block = { type: "heading"; text: string } | { type: "p"; text: string } | { type: "ol"; items: string[] } | { type: "ul"; items: string[] };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "p", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (const raw of (text || "").replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const last = blocks.at(-1);
    if (heading) {
      flush();
      blocks.push({ type: "heading", text: heading[1] ?? "" });
    } else if (numbered) {
      flush();
      const item = numbered[1] ?? "";
      if (last?.type === "ol") last.items.push(item);
      else blocks.push({ type: "ol", items: [item] });
    } else if (bullet) {
      flush();
      const item = bullet[1] ?? "";
      if (last?.type === "ul") last.items.push(item);
      else blocks.push({ type: "ul", items: [item] });
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

/** `**bold**` and `` `code` ``; everything else is text. Menu paths ("A → B") stay as typed. */
export function Inline({ text }: { text: string }) {
  const parts = React.useMemo(() => (text || "").split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).filter(Boolean), [text]);
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
          return (
            <strong key={index} className="font-semibold text-fg">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          return (
            <code key={index} className="rounded bg-bg-subtle px-1 py-0.5 text-[0.85em]">
              {part.slice(1, -1)}
            </code>
          );
        }
        return <React.Fragment key={index}>{part}</React.Fragment>;
      })}
    </>
  );
}

/** "Settings → CRM Configuration → Pipelines & Stages" as breadcrumb chips. */
export function MenuPath({ path, className }: { path: string; className?: string }) {
  const parts = path.split(/\s*→\s*/).filter(Boolean);
  if (!parts.length) return null;
  return (
    <nav aria-label="Where to find it" className={cn("flex flex-wrap items-center gap-1 text-xs", className)}>
      {parts.map((part, index) => (
        <React.Fragment key={index}>
          {index > 0 ? (
            <span aria-hidden className="text-fg-subtle">
              →
            </span>
          ) : null}
          <span className="rounded-md border border-border bg-bg-subtle px-1.5 py-0.5 font-medium text-fg">{part}</span>
        </React.Fragment>
      ))}
    </nav>
  );
}
