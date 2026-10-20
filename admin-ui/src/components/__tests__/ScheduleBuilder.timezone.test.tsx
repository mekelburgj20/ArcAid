import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ScheduleBuilder from '../ScheduleBuilder';

/**
 * Room default timezone: the create form mounts with the default zone and is
 * re-seeded with the ROOM's zone once the settings read lands. The builder
 * keeps the zone in local state, so it must follow a changed `value.timezone`
 * or it would display one zone while the form saves another.
 */

const zoneSelect = () => screen.getByDisplayValue(/Chicago|Los Angeles|Toronto/) as HTMLSelectElement;

describe('ScheduleBuilder timezone', () => {
  it('labels the preview with the short zone name', () => {
    render(<ScheduleBuilder value={{ cron: '0 22 * * *', timezone: 'America/Chicago' }} onChange={() => {}} />);
    expect(screen.getByText('Every day at 22:00 Chicago (CT)')).toBeTruthy();
  });

  it('follows a zone change from the parent and reports it back', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ScheduleBuilder value={{ cron: '0 22 * * *', timezone: 'America/Chicago' }} onChange={onChange} />);
    rerender(<ScheduleBuilder value={{ cron: '0 22 * * *', timezone: 'America/Los_Angeles' }} onChange={onChange} />);
    expect(zoneSelect().value).toBe('America/Los_Angeles');
    expect(onChange).toHaveBeenLastCalledWith({ cron: '0 22 * * *', timezone: 'America/Los_Angeles' });
  });

  it('shows a stored zone outside the list as itself', () => {
    render(<ScheduleBuilder value={{ cron: '0 22 * * *', timezone: 'America/Toronto' }} onChange={() => {}} />);
    expect(zoneSelect().value).toBe('America/Toronto');
  });
});
