import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Tabs, TabsList, TabsTab } from '../components/ui/tabs';

describe('UI SDK wrappers keep className callbacks', () => {
  it('applies the classes a state callback returns, beside the base classes', () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTab value="a" className={() => 'probe-fn'}>
            One
          </TabsTab>
          <TabsTab value="b" className="probe-str">
            Two
          </TabsTab>
        </TabsList>
      </Tabs>,
    );
    const fn = screen.getByRole('tab', { name: 'One' });
    expect(fn).toHaveClass('probe-fn');
    expect(fn).toHaveClass('cursor-pointer');
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveClass('probe-str');
  });
});
