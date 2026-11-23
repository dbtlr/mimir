import {
  Drawer as SdkDrawer,
  DrawerBackdrop as SdkDrawerBackdrop,
  DrawerContent as SdkDrawerContent,
  DrawerDescription as SdkDrawerDescription,
  DrawerTitle as SdkDrawerTitle,
} from '@ui-sdk/react/drawer';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn';
import { useMediaQuery } from '../../lib/use-media-query';
import { mergeClassName } from './class-name';
import { OVERLAY_BACKDROP_CLASS, OVERLAY_DESCRIPTION_CLASS, OVERLAY_TITLE_CLASS } from './dialog';

/*
 * The Drawer primitive (ADR 0046): the surface of the Sheet pattern (ADR 0019,
 * MMR-736). Below `md` a sheet rises from the bottom, full screen for a form;
 * from `md` up it is a panel from the right, 440px for content and 640px for
 * a form. A left drawer is the phone sidebar (MMR-730). UI SDK fixes `side` per
 * Drawer, so `Drawer` picks it from the viewport unless the caller passes one;
 * a drawer that crosses `md` while open slides to the new edge. The preview
 * panel (MMR-720) is its own size: a content-sized bottom sheet capped at 88%
 * of the visible viewport, and from `md` a 440 panel under the top bar.
 */

/** Trigger and Close carry behavior only; render Close as an ActionButton. */
export { DrawerClose, DrawerTrigger } from '@ui-sdk/react/drawer';

/** Tailwind's `md` breakpoint: where a bottom sheet becomes a right panel. */
export const DRAWER_DESKTOP_QUERY = '(min-width: 768px)';

/** The edge a Drawer opens from when the caller does not set one. */
export function useDrawerSide(): 'bottom' | 'right' {
  return useMediaQuery(DRAWER_DESKTOP_QUERY) ? 'right' : 'bottom';
}

export function Drawer({ side, ...props }: ComponentProps<typeof SdkDrawer>) {
  const responsiveSide = useDrawerSide();
  return <SdkDrawer side={side ?? responsiveSide} {...props} />;
}

export function DrawerBackdrop({ className, ...props }: ComponentProps<typeof SdkDrawerBackdrop>) {
  return (
    <SdkDrawerBackdrop className={mergeClassName(OVERLAY_BACKDROP_CLASS, className)} {...props} />
  );
}

/*
 * UI SDK sets position and translate; the panel gives size, surface, and
 * corners per edge. A bottom sheet caps at the visible viewport so the
 * on-screen keyboard never covers a field; a form sheet fills that height.
 * The panel is well-850, so a well-950 control on it reads by its ground as
 * well as its edge (DESIGN.md, Color roles).
 */
const PANEL_CLASS =
  'group/drawer flex flex-col gap-3 overflow-y-auto border-line bg-well-850 p-4 text-ink shadow-2xl outline-none ' +
  'data-[side=bottom]:max-h-[min(88dvh,var(--visual-viewport-height,100dvh))] data-[side=bottom]:w-full data-[side=bottom]:rounded-t-xl data-[side=bottom]:border-t data-[side=bottom]:pb-[max(1rem,env(safe-area-inset-bottom))] ' +
  'data-[side=left]:h-dvh data-[side=left]:w-[min(86vw,320px)] data-[side=left]:border-r ' +
  'data-[side=right]:h-dvh data-[side=right]:border-l';

const SIZE_CLASS = {
  content: 'data-[side=right]:w-[min(100vw,440px)]',
  form: 'data-[side=bottom]:h-[var(--visual-viewport-height,100dvh)] data-[side=bottom]:max-h-none data-[side=bottom]:rounded-none data-[side=bottom]:border-t-0 data-[side=right]:w-[min(100vw,640px)]',
  // The panel starts at the top bar's measured bottom, so the bar stays in reach beside it.
  preview:
    'data-[side=bottom]:max-h-[calc(var(--visual-viewport-height,100dvh)*0.88)] data-[side=bottom]:border-sheet-seam light:data-[side=bottom]:elevation-sheet-up ' +
    'data-[side=right]:mt-(--top-bar-height) data-[side=right]:h-[calc(100dvh-var(--top-bar-height,0px))] data-[side=right]:w-[min(100vw,440px)] data-[side=right]:border-ink-ghost light:data-[side=right]:border-line-bright light:data-[side=right]:shadow-panel',
} as const;

/**
 * The bar that shows a bottom sheet can be dragged down; hidden on other edges,
 * and on a form sheet, which fills the screen and closes from its top bar.
 */
function DrawerGrip() {
  return (
    <div
      aria-hidden="true"
      className="mx-auto -mt-1 hidden h-1 w-10 shrink-0 rounded-full bg-ink-faint group-data-[side=bottom]/drawer:block group-data-[size=form]/drawer:hidden group-data-[size=preview]/drawer:mt-2"
      data-slot="drawer-grip"
    />
  );
}

export function DrawerContent({
  children,
  className,
  size = 'content',
  ...props
}: ComponentProps<typeof SdkDrawerContent> & { size?: keyof typeof SIZE_CLASS }) {
  return (
    <SdkDrawerContent
      className={mergeClassName(PANEL_CLASS, SIZE_CLASS[size], className)}
      data-size={size}
      {...props}
    >
      {(state) => (
        <>
          <DrawerGrip />
          {typeof children === 'function' ? children(state) : children}
        </>
      )}
    </SdkDrawerContent>
  );
}

export function DrawerTitle({ className, ...props }: ComponentProps<typeof SdkDrawerTitle>) {
  return <SdkDrawerTitle className={mergeClassName(OVERLAY_TITLE_CLASS, className)} {...props} />;
}

export function DrawerDescription({
  className,
  ...props
}: ComponentProps<typeof SdkDrawerDescription>) {
  return (
    <SdkDrawerDescription
      className={mergeClassName(OVERLAY_DESCRIPTION_CLASS, className)}
      {...props}
    />
  );
}

/** The row of answers at the foot of a Drawer, pinned down when the body is short. */
export function DrawerFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mt-auto flex justify-end gap-2 pt-1', className)} {...props} />;
}
