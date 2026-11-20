import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { useMediaQuery } from '../lib/use-media-query';

function Probe() {
  return <span>{String(useMediaQuery('(min-width: 768px)'))}</span>;
}

describe('useMediaQuery', () => {
  it('renders on the server as not matching, so a Drawer can render there', () => {
    expect(renderToString(<Probe />)).toBe('<span>false</span>');
  });
});
