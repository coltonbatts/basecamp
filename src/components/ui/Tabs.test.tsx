/* @vitest-environment jsdom */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { TabsList, TabsPanel, TabsRoot, TabsTrigger } from './Tabs';

afterEach(() => {
  cleanup();
});

function Harness() {
  const [value, setValue] = useState('timeline');

  return (
    <TabsRoot value={value} onValueChange={setValue}>
      <TabsList aria-label="Inspect tabs">
        <TabsTrigger value="timeline">Timeline</TabsTrigger>
        <TabsTrigger value="request">Request</TabsTrigger>
        <TabsTrigger value="errors">Errors</TabsTrigger>
      </TabsList>

      <TabsPanel value="timeline">Timeline panel</TabsPanel>
      <TabsPanel value="request">Request panel</TabsPanel>
      <TabsPanel value="errors">Errors panel</TabsPanel>
    </TabsRoot>
  );
}

describe('Tabs', () => {
  it('renders active tab with correct aria wiring', () => {
    render(<Harness />);

    const timeline = screen.getByRole('tab', { name: 'Timeline' });
    const request = screen.getByRole('tab', { name: 'Request' });
    const timelinePanel = screen.getByRole('tabpanel', { name: 'Timeline' });

    expect(timeline.getAttribute('aria-selected')).toBe('true');
    expect(timeline.tabIndex).toBe(0);
    expect(request.getAttribute('aria-selected')).toBe('false');
    expect(request.tabIndex).toBe(-1);
    expect((timelinePanel as HTMLDivElement).hidden).toBe(false);
  });

  it('supports arrow and home/end keyboard navigation', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const timeline = screen.getByRole('tab', { name: 'Timeline' });
    const request = screen.getByRole('tab', { name: 'Request' });
    const errors = screen.getByRole('tab', { name: 'Errors' });

    timeline.focus();
    await user.keyboard('{ArrowRight}');

    expect(document.activeElement).toBe(request);
    expect(request.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: 'Request' }).hidden).toBe(false);

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(errors);
    expect(errors.getAttribute('aria-selected')).toBe('true');

    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(timeline);
    expect(timeline.getAttribute('aria-selected')).toBe('true');
  });
});
