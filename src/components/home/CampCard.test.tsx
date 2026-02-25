/* @vitest-environment jsdom */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CampCard } from './CampCard';

afterEach(() => {
  cleanup();
});

const CAMP = {
  id: 'camp-1',
  name: 'Alpha',
  model: 'openrouter/auto',
  updated_at: 1_700_000_100_000,
  path: '/tmp/camps/camp-1',
};

describe('CampCard', () => {
  it('opens camp when main action button is clicked', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();

    render(<CampCard camp={CAMP} promptPreview="Hello" onOpen={onOpen} />);

    await user.click(screen.getByRole('button', { name: 'Open Alpha' }));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('deletes camp without firing open action', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onDelete = vi.fn();

    render(<CampCard camp={CAMP} promptPreview="Hello" onOpen={onOpen} onDelete={onDelete} />);

    await user.click(screen.getByRole('button', { name: 'Delete Alpha' }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(0);
  });
});
