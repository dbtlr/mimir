import { createLazyRoute } from '@tanstack/react-router';
import { useState } from 'react';

import { StatusBadge } from '../components/status-badge';
import { StatusDot } from '../components/status-dot';
import { ActionButton } from '../components/ui/action-button';
import { Badge, statusChipVariants } from '../components/ui/badge';
import { Card, CardContent, CardHeader } from '../components/ui/card';
import { SegmentedControl } from '../components/ui/segmented-control';
import { cn } from '../lib/cn';
import { STATUS_META, STATUS_ORDER } from '../lib/status';

/*
 * Dev-only showcase (gated off the prod bundle in the router). One page over two
 * themes exercises every kit primitive and token, so a foundation regression is
 * visible in a single glance rather than surface by surface.
 */

// Literal class strings — Tailwind's scanner can't see interpolated names.
const WELLS = [
  { cls: 'bg-well-950', name: 'well-950' },
  { cls: 'bg-well-900', name: 'well-900' },
  { cls: 'bg-well-850', name: 'well-850' },
  { cls: 'bg-well-800', name: 'well-800' },
  { cls: 'bg-well-recessed', name: 'well-recessed' },
] as const;
const INKS = [
  { cls: 'text-ink-bright', name: 'ink-bright' },
  { cls: 'text-ink', name: 'ink' },
  { cls: 'text-ink-dim', name: 'ink-dim' },
  { cls: 'text-ink-faint', name: 'ink-faint' },
  { cls: 'text-ink-ghost', name: 'ink-ghost' },
] as const;
const HUES = [
  { cls: 'bg-accent', name: 'accent' },
  { cls: 'bg-accent-foreground', name: 'accent-foreground' },
  { cls: 'bg-action', name: 'action' },
  { cls: 'bg-action-foreground', name: 'action-foreground' },
  { cls: 'bg-attention', name: 'attention' },
  { cls: 'bg-attention-solid', name: 'attention-solid' },
  { cls: 'bg-cold', name: 'cold' },
] as const;

const TYPE_SCALE = [
  { cls: 'text-page', note: '28 · page title · 700' },
  { cls: 'text-header', note: '21 · section header · 700' },
  { cls: 'text-dossier', note: '17 · dossier title · 600' },
  { cls: 'text-card-mobile', note: '15 · card title (mobile) · 500' },
  { cls: 'text-body', note: '14 · body · 400' },
  { cls: 'text-meta', note: '13 · meta' },
  { cls: 'text-mono-id', mono: true, note: '11.5 · mono id' },
  { cls: 'text-tag', note: '11 · tag' },
] as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="microlabel text-ink-faint">{title}</h2>
      {children}
    </section>
  );
}

export function KitPage() {
  const [lens, setLens] = useState<'board' | 'tree' | 'log'>('board');

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 overflow-y-auto px-5 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-page font-bold text-ink-bright">Meridian kit</h1>
        <p className="text-meta text-ink-dim">Foundation tokens and CVA primitives · dev only</p>
      </header>

      <Section title="Wells">
        <div className="flex flex-wrap gap-3">
          {WELLS.map((w) => (
            <div key={w.name} className="flex flex-col gap-1">
              <div className={cn('size-16 rounded-lg border border-line', w.cls)} />
              <span className="text-mono-id font-mono text-ink-faint">{w.name}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Ink">
        <div className="flex flex-col gap-1 rounded-lg border border-line bg-well-850 p-4">
          {INKS.map((i) => (
            <p key={i.name} className={cn('text-body', i.cls)}>
              {i.name} — the quick brown fox jumps over the lazy dog
            </p>
          ))}
        </div>
      </Section>

      <Section title="Accent / action / attention">
        <div className="flex flex-wrap gap-3">
          {HUES.map((h) => (
            <div key={h.name} className="flex flex-col gap-1">
              <div className={cn('size-16 rounded-lg border border-line', h.cls)} />
              <span className="text-mono-id font-mono text-ink-faint">{h.name}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Type scale">
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-well-850 p-4">
          {TYPE_SCALE.map((t) => (
            <div key={t.cls} className="flex items-baseline gap-4">
              <span className={cn(t.cls, 'text-ink-bright', 'mono' in t && t.mono && 'font-mono')}>
                Meridian
              </span>
              <span className="text-mono-id font-mono text-ink-faint">{t.note}</span>
            </div>
          ))}
          <p className="microlabel text-ink-dim">microlabel · 10.5 · 600 · tracked · uppercase</p>
        </div>
      </Section>

      <Section title="Status chips">
        <div className="flex flex-wrap gap-2">
          {STATUS_ORDER.map((s) => (
            <StatusBadge key={s} status={s} />
          ))}
        </div>
      </Section>

      <Section title="Status dots">
        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-well-850 p-4">
          {STATUS_ORDER.map((s) => (
            <div key={s} className="flex items-center gap-1.5">
              <StatusDot status={s} />
              <span className="text-meta text-ink-dim">{STATUS_META[s].label}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Wash + ring (per hue)">
        <div className="flex flex-wrap gap-2">
          {STATUS_ORDER.map((s) => (
            <div key={s} className={cn(statusChipVariants({ status: s }), 'px-3 py-2')}>
              {STATUS_META[s].label}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Status left-border cards">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {STATUS_ORDER.map((s) => (
            <Card key={s} className={cn('border-l-2 p-3', STATUS_META[s].border)}>
              <p className="text-body font-medium text-ink-bright">{STATUS_META[s].label}</p>
              <p className="text-meta text-ink-dim">a card on the well</p>
            </Card>
          ))}
        </div>
      </Section>

      <Section title="Card variants">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <p className="text-dossier font-semibold text-ink-bright">Default card</p>
              <p className="text-meta text-ink-dim">well-850, hairline, light-mode lift</p>
            </CardHeader>
            <CardContent>
              <p className="text-body text-ink">Body copy on the panel ground.</p>
            </CardContent>
          </Card>
          <Card variant="recessed">
            <CardHeader>
              <p className="text-dossier font-semibold">Recessed card</p>
              <p className="text-meta">demoted / done — ghost ink on the recessed well</p>
            </CardHeader>
            <CardContent>
              <p className="text-body">Folded content sits back.</p>
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <ActionButton variant="action">Primary action</ActionButton>
          <ActionButton variant="attention">Approve</ActionButton>
          <ActionButton variant="outline">Cancel</ActionButton>
          <ActionButton variant="action" disabled>
            Disabled
          </ActionButton>
        </div>
      </Section>

      <Section title="Segmented control">
        <SegmentedControl
          ariaLabel="Lens"
          value={lens}
          onChange={setLens}
          options={[
            { label: 'Board', value: 'board' },
            { label: 'Tree', value: 'tree' },
            { label: 'Log', value: 'log' },
          ]}
        />
      </Section>

      <Section title="Badges">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>default</Badge>
          <Badge variant="mono">MMR-219</Badge>
          <Badge variant="outline">outline</Badge>
        </div>
      </Section>
    </main>
  );
}

/** Lazy route object — loaded only when the DEV-gated `/kit` branch registers it. */
export const Route = createLazyRoute('/kit')({ component: KitPage });
