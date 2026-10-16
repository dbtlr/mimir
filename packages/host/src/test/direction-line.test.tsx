import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, vi } from 'vitest';

import { DirectionPanel } from '../components/direction-line';

const { apiSend } = vi.hoisted(() => ({ apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet: vi.fn(), apiSend }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  vi.resetAllMocks();
});

const PROSE = 'Land the console direction line.\n\n- **cut** the dialog\n- wire the PATCH\n';

describe('directionPanel (MMR-450)', () => {
  it('opens straight into the editor and closes on Cancel', async () => {
    render(
      <DirectionPanel
        subject={{ key: 'MMR', kind: 'project' }}
        title="Mimir"
        next={PROSE}
        offline={false}
      />,
      { wrapper },
    );
    expect(screen.getByText('cut').tagName).toBe('STRONG');

    await userEvent.click(screen.getByRole('button', { name: 'Edit direction' }));
    expect(screen.getByRole('textbox', { name: 'Direction text' })).toHaveValue(PROSE);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('Save PATCHes the project with the rewritten text', async () => {
    apiSend.mockResolvedValue({});
    render(
      <DirectionPanel
        subject={{ key: 'MMR', kind: 'project' }}
        title="Mimir"
        next={PROSE}
        offline={false}
      />,
      { wrapper },
    );

    await userEvent.click(screen.getByRole('button', { name: 'Edit direction' }));
    const box = screen.getByRole('textbox', { name: 'Direction text' });
    await userEvent.clear(box);
    await userEvent.type(box, 'Rewritten direction.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/projects/MMR', {
        next: 'Rewritten direction.',
      });
    });
  });

  it('a node subject PATCHes the node route', async () => {
    apiSend.mockResolvedValue({});
    render(
      <DirectionPanel
        subject={{ id: 'MMR-12', kind: 'node' }}
        title="Console"
        next="Old plan."
        offline={false}
      />,
      { wrapper },
    );

    await userEvent.click(screen.getByRole('button', { name: 'Edit direction' }));
    const box = screen.getByRole('textbox', { name: 'Direction text' });
    await userEvent.clear(box);
    await userEvent.type(box, 'New plan.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/nodes/MMR-12', { next: 'New plan.' });
    });
  });

  it('offline disables Edit', () => {
    render(
      <DirectionPanel
        subject={{ key: 'MMR', kind: 'project' }}
        title="Mimir"
        next={PROSE}
        offline
      />,
      { wrapper },
    );
    expect(screen.getByRole('button', { name: 'Edit direction' })).toBeDisabled();
  });

  it('closes on Save once the rewrite lands', async () => {
    apiSend.mockResolvedValue({});
    render(
      <DirectionPanel
        subject={{ key: 'MMR', kind: 'project' }}
        title="Mimir"
        next={PROSE}
        offline={false}
      />,
      { wrapper },
    );

    await userEvent.click(screen.getByRole('button', { name: 'Edit direction' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(apiSend).toHaveBeenCalledTimes(1);
  });

  it('drops an open draft when the panel moves to another subject', async () => {
    const view = render(
      <DirectionPanel
        subject={{ key: 'MMR', kind: 'project' }}
        title="Mimir"
        next={PROSE}
        offline={false}
      />,
      { wrapper },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit direction' }));
    expect(screen.getByRole('dialog')).toBeDefined();

    view.rerender(
      <DirectionPanel
        subject={{ key: 'ABC', kind: 'project' }}
        title="Other"
        next="Other prose."
        offline={false}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

const renderPanel = () =>
  render(
    <DirectionPanel
      subject={{ key: 'MMR', kind: 'project' }}
      title="Mimir"
      next={PROSE}
      offline={false}
    />,
    { wrapper },
  );

const panel = (next: string) => (
  <DirectionPanel
    subject={{ key: 'MMR', kind: 'project' }}
    title="Mimir"
    next={next}
    offline={false}
  />
);

describe('directionPanel clamp (MMR-484)', () => {
  const proto = HTMLElement.prototype;
  const original = {
    client: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
    scroll: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'),
  };

  /** jsdom has no layout; stub the two heights the clamp measures. */
  function stubHeights(scrollHeight: number | (() => number), clientHeight: number) {
    Object.defineProperty(proto, 'scrollHeight', {
      configurable: true,
      get: () => (typeof scrollHeight === 'function' ? scrollHeight() : scrollHeight),
    });
    Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => clientHeight });
  }

  afterEach(() => {
    for (const [name, descriptor] of [
      ['clientHeight', original.client],
      ['scrollHeight', original.scroll],
    ] as const) {
      if (descriptor === undefined) {
        Reflect.deleteProperty(proto, name);
      } else {
        Object.defineProperty(proto, name, descriptor);
      }
    }
  });

  it('clamps the rendered direction to six lines', () => {
    stubHeights(100, 100);
    renderPanel();
    const article = screen.getByText('cut').closest('article');
    expect(article).toHaveAttribute('data-clamped');
    expect(article?.className).toContain('max-h-[6lh]');
  });

  it('offers no Read more when the direction fits its clamp', () => {
    stubHeights(100, 100);
    renderPanel();
    expect(screen.queryByRole('button', { name: 'Read more of the direction' })).toBeNull();
  });

  it('offers Read more when it overflows, opening the reading dialog rather than the editor', async () => {
    stubHeights(400, 100);
    renderPanel();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Read more of the direction' }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Direction');
    expect(screen.queryByRole('textbox')).toBeNull();
    // View mode keeps its own Edit, which switches to the editor in place.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('textbox', { name: 'Direction text' })).toHaveValue(PROSE);
  });

  it('gives Read more a 24px hit area and a name that contains its visible text', () => {
    stubHeights(400, 100);
    renderPanel();

    const readMore = screen.getByRole('button', { name: 'Read more of the direction' });
    expect(readMore).toHaveTextContent('Read more');
    expect(readMore.className).toContain('min-h-6');
  });

  it('returns focus to Edit when Read more unmounts under the open dialog', async () => {
    let scrollHeight = 400;
    stubHeights(() => scrollHeight, 100);
    apiSend.mockResolvedValue({});
    const view = render(panel(PROSE), { wrapper });

    await userEvent.click(screen.getByRole('button', { name: 'Read more of the direction' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Direction text' });
    await userEvent.clear(box);
    await userEvent.type(box, 'Short.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // The refetch lands: the shorter text fits, so Read more unmounts.
    scrollHeight = 100;
    view.rerender(panel('Short.'));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Read more of the direction' })).toBeNull();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'Edit direction' })).toHaveFocus();
  });
});
