import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

// S2 (Phase 0): smoke test proving the admin-ui Vitest runner works end-to-end —
// jsdom environment, @testing-library/react render/screen, and the
// @testing-library/jest-dom matchers wired through setupTests. Real component
// tests land with the frontend sprints.
describe('admin-ui test runner', () => {
    it('renders into jsdom and exposes jest-dom matchers', () => {
        render(<div>ArcAid admin-ui harness</div>);
        expect(screen.getByText('ArcAid admin-ui harness')).toBeInTheDocument();
    });
});
