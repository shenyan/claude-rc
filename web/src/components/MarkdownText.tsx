// Renders agent text as Markdown. react-markdown + remark-gfm + remark-breaks
// together are ~85 KB un-gzipped, so this component is lazy-loaded by
// Chat.tsx (React.lazy + Suspense) and ships in its own chunk that
// only downloads the first time you open a chat detail.

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

interface Props {
  text: string;
  /** show a blinking cursor at the end while still streaming */
  streaming?: boolean;
}

export default function MarkdownText({ text, streaming }: Props) {
  return (
    <div className="markdown" data-testid="markdown">
      <ReactMarkdown
        // remark-gfm: tables, strikethrough, autolinks, task lists.
        // remark-breaks: a single \n becomes a hard <br> instead of
        //   collapsing to a space. CommonMark would render
        //   "step 1\nstep 2\nstep 3" as one line; codex emits this
        //   pattern constantly, so the chat-friendly behavior wins.
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          // Force any inbound link to open in a new tab + sanitize.
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
          // Block remote image fetches. The model occasionally emits
          // `![](http://...)` in summaries; we don't want the browser
          // to silently GET it and leak Tailscale IP / User-Agent to
          // an arbitrary host. Render the alt text as a small inline
          // chip instead so the user knows an image was *intended*.
          img: ({ alt, src }) => (
            <span
              className="text-[11px] text-muted bg-bg/60 border border-border rounded px-1 py-0.5 mx-0.5"
              title={typeof src === "string" ? src : ""}
            >
              [image{alt ? `: ${alt}` : ""}]
            </span>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      {streaming && <span className="opacity-50 animate-pulse">▌</span>}
    </div>
  );
}
