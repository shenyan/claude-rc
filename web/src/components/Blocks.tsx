// Generative-UI block renderers. Each Block in shared/protocol.ts gets
// a small dedicated component here. Stack vertically by default; cards_row
// renders a horizontal scroller. Actions click → send back as user message.

import { lazy, Suspense, useState } from "react";
import type { Block } from "../../../shared/protocol";

const MarkdownText = lazy(() => import("./MarkdownText"));

interface Ctx {
  /** Called when an action button is clicked. Sends `payload` (or label) as a user message. */
  onAction: (payload: string) => void;
}

export function BlocksView({ blocks, ctx }: { blocks: Block[]; ctx: Ctx }) {
  return (
    <div className="space-y-3 max-w-full">
      {blocks.map((b, i) => <BlockView key={i} block={b} ctx={ctx} />)}
    </div>
  );
}

function BlockView({ block, ctx }: { block: Block; ctx: Ctx }) {
  switch (block.type) {
    case "text":
      return (
        <Suspense fallback={<div className="whitespace-pre-wrap">{block.markdown}</div>}>
          <MarkdownText text={block.markdown} />
        </Suspense>
      );
    case "card":
      return <CardView card={block} ctx={ctx} />;
    case "cards_row":
      return (
        <div className="flex gap-3 overflow-x-auto -mx-1 px-1 pb-1 [scrollbar-width:thin]">
          {block.items.map((c, i) => (
            <div key={i} className="shrink-0 w-64">
              <CardView card={c} ctx={ctx} />
            </div>
          ))}
        </div>
      );
    case "map":
      return <MapView block={block} />;
    case "stats":
      return (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {block.items.map((s, i) => {
            const tone = s.tone === "good" ? "text-emerald-400" : s.tone === "bad" ? "text-red-400" : "text-zinc-300";
            return (
              <div key={i} className="bg-panel border border-border rounded-lg p-3">
                <div className="text-[10px] text-muted uppercase tracking-wide truncate">{s.label}</div>
                <div className={"text-xl font-semibold " + tone}>{s.value}</div>
                {s.delta && <div className="text-[11px] text-muted truncate">{s.delta}</div>}
              </div>
            );
          })}
        </div>
      );
    case "actions":
      return (
        <div className="flex flex-wrap gap-2">
          {block.choices.map((c, i) => {
            const cls = c.style === "primary"
              ? "bg-emerald-600 hover:bg-emerald-500 text-white"
              : c.style === "danger"
              ? "bg-red-600 hover:bg-red-500 text-white"
              : "bg-panel border border-border hover:bg-panel/70 text-zinc-200";
            return (
              <button
                key={i}
                className={"rounded-lg px-3 py-2 text-sm " + cls}
                onClick={() => ctx.onAction(c.payload ?? c.label)}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      );
    case "code":
      return (
        <div className="font-mono text-xs">
          {block.filename && <div className="text-muted text-[10px] mb-1">{block.filename}</div>}
          <pre className="bg-bg border border-border rounded p-2 overflow-x-auto whitespace-pre"><code>{block.code}</code></pre>
        </div>
      );
    default:
      return <div className="text-xs text-muted">(unknown block: {(block as any).type})</div>;
  }
}

function CardView({ card, ctx }: { card: Extract<Block, { type: "card" }>; ctx: Ctx }) {
  const Wrapper: any = card.url ? "a" : "div";
  const wrapperProps = card.url ? { href: card.url, target: "_blank", rel: "noopener noreferrer" } : {};
  return (
    <div className="bg-panel border border-border rounded-xl overflow-hidden">
      {card.image && (
        <Wrapper {...wrapperProps} className="block aspect-[16/9] bg-bg overflow-hidden">
          <img
            src={card.image}
            alt={card.imageAlt ?? card.title}
            className="w-full h-full object-cover"
            loading="lazy"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        </Wrapper>
      )}
      <div className="p-3 space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <Wrapper {...wrapperProps} className="font-semibold leading-tight [overflow-wrap:anywhere] hover:underline">
            {card.title}
          </Wrapper>
          {typeof card.rating === "number" && <Stars rating={card.rating} />}
        </div>
        {card.subtitle && <div className="text-xs text-muted [overflow-wrap:anywhere]">{card.subtitle}</div>}
        {card.badges && card.badges.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            {card.badges.map((b, i) => (
              <span key={i} className="text-[10px] bg-bg border border-border rounded px-1.5 py-0.5 text-zinc-300">
                {b}
              </span>
            ))}
          </div>
        )}
        {card.meta && card.meta.length > 0 && (
          <dl className="text-[11px] grid grid-cols-[auto_1fr] gap-x-2 pt-1">
            {card.meta.map((m, i) => (
              <div key={i} className="contents">
                <dt className="text-muted">{m.label}</dt>
                <dd className="text-zinc-300 truncate">{m.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {card.actions && card.actions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1.5">
            {card.actions.map((a, i) => {
              const cls = a.style === "primary"
                ? "bg-emerald-600 text-white"
                : a.style === "danger"
                ? "bg-red-600 text-white"
                : "bg-bg border border-border text-zinc-200";
              if (a.url) {
                return (
                  <a
                    key={i}
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={"text-[11px] rounded px-2 py-1 " + cls}
                  >
                    {a.label}
                  </a>
                );
              }
              return (
                <button
                  key={i}
                  className={"text-[11px] rounded px-2 py-1 " + cls}
                  onClick={(e) => { e.stopPropagation(); ctx.onAction(a.payload ?? a.label); }}
                >
                  {a.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Stars({ rating }: { rating: number }) {
  const r = Math.max(0, Math.min(5, rating));
  return (
    <div className="text-amber-400 text-xs whitespace-nowrap shrink-0" title={`${r.toFixed(1)} / 5`}>
      ★ {r.toFixed(1)}
    </div>
  );
}

function MapView({ block }: { block: Extract<Block, { type: "map" }> }) {
  const [expanded, setExpanded] = useState(false);
  const zoom = block.zoom ?? 15;
  // OSM bbox: rough degree window proportional to zoom (~0.005° at z15).
  const span = Math.max(0.0008, 360 / Math.pow(2, zoom + 1));
  const w = block.lng - span, e = block.lng + span;
  const s = block.lat - span * 0.6, n = block.lat + span * 0.6;
  const embed = `https://www.openstreetmap.org/export/embed.html?bbox=${w},${s},${e},${n}&layer=mapnik&marker=${block.lat},${block.lng}`;
  const full = `https://www.openstreetmap.org/?mlat=${block.lat}&mlon=${block.lng}#map=${zoom}/${block.lat}/${block.lng}`;
  return (
    <div className="bg-panel border border-border rounded-xl overflow-hidden">
      <div className={"relative bg-bg " + (expanded ? "h-72" : "h-40")}>
        <iframe
          src={embed}
          className="w-full h-full"
          title={block.label ?? "map"}
          loading="lazy"
        />
        <button
          className="absolute top-2 right-2 text-[11px] bg-panel/90 border border-border rounded px-2 py-0.5"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>
      <div className="px-3 py-2 flex items-center justify-between gap-2">
        <div className="text-xs truncate">
          {block.label && <span className="font-medium">{block.label}</span>}
          {block.caption && <span className="text-muted ml-2">{block.caption}</span>}
        </div>
        <a
          href={full}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-emerald-400 hover:underline shrink-0"
        >
          Open in OSM ↗
        </a>
      </div>
    </div>
  );
}
