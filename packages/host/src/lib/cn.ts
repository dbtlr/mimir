import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge taught the Meridian type scale (the `--text-*` tokens in
 * styles.css). Without this, custom `text-<step>` utilities are unclassifiable
 * and fall into the text-color conflict group, so a later color (`text-ink-dim`)
 * silently drops the font-size (`text-mono-id`) from the merged output.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'page',
            'header',
            'dossier',
            'card-mobile',
            'body',
            'meta',
            'mono-id',
            'tag',
            'micro',
          ],
        },
      ],
    },
  },
});

/** The shadcn class combinator — clsx then tailwind-merge. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
