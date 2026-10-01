import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import mimirMaskableIcon from '../../public/icons/mimir-maskable.svg?raw';
import mimirIcon from '../../public/icons/mimir.svg?raw';
import { BrandMark } from '../components/brand-mark';

/** MMR-272 — the Board mark: five cards, exactly one selected in the accent. */
describe('the Board mark', () => {
  it('draws five cards and selects exactly one in the accent', () => {
    const { getByTestId } = render(<BrandMark size={20} />);
    const mark = getByTestId('brand-mark');
    expect(mark.querySelectorAll('rect')).toHaveLength(5);
    expect(mark.querySelectorAll('.stroke-accent')).toHaveLength(1);
  });

  it('the static icons carry the same selected card in the dark accent', () => {
    for (const icon of [mimirIcon, mimirMaskableIcon]) {
      expect(icon.match(/stroke="#4fc4d6"/g)).toHaveLength(1);
    }
  });
});
