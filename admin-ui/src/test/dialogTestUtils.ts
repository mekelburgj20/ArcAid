import { expect } from 'vitest';
import { waitFor } from '@testing-library/react';

/**
 * Waits until every open Arcaid dialog (`components/parts/Dialog`) is the real
 * one: no stand-in is left and at least one dialog is on screen.
 *
 * The dialog's base-ui half is a chunk of its own (`DialogImpl`, loaded by
 * `lib/lazyPart.ts`). Until it arrives `Dialog` draws a stand-in, and when it
 * does the real dialog takes the stand-in's place. A button a test found on the
 * stand-in and clicks after that swap is detached: the click lands nowhere
 * (PublicLayout's "Leave <room>" test saw it 2 runs in 3). So a test that opens
 * one of these dialogs and then clicks inside it waits here first.
 */
export async function waitForRealDialog(): Promise<void> {
    await waitFor(() => {
        expect(document.querySelector('.arc-dialog--stand-in')).toBeNull();
        expect(document.querySelector('.arc-dialog')).not.toBeNull();
    });
}
