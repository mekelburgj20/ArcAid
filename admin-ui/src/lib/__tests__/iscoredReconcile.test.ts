import { describe, it, expect } from 'vitest';
import { deletionSentence, iscoredGameLabel, joinGameNames } from '../iscoredReconcile';

describe('Reconcile iScored wording', () => {
  it('joins names without cutting any off', () => {
    expect(joinGameNames([])).toBe('');
    expect(joinGameNames(['Dracula'])).toBe('Dracula');
    expect(joinGameNames(['Dracula', 'Halloween'])).toBe('Dracula and Halloween');
    expect(joinGameNames(['Dracula', 'Tales from the Crypt', 'Scared Stiff', 'Class of 1812', 'Halloween']))
      .toBe('Dracula, Tales from the Crypt, Scared Stiff, Class of 1812 and Halloween');
  });

  it('falls back to the iScored id for a nameless game', () => {
    expect(iscoredGameLabel({ id: '99255', name: '' })).toBe('(iScored game 99255)');
    expect(iscoredGameLabel({ id: '99255', name: '  Dracula ' })).toBe('Dracula');
  });

  it('names every game that will be deleted', () => {
    expect(deletionSentence([])).toBe('Nothing is ticked, so nothing will be deleted.');
    expect(deletionSentence([{ id: '1', name: 'Dracula' }]))
      .toBe('Dracula will be deleted from iScored, with every score on it.');
    expect(deletionSentence([{ id: '1', name: 'Dracula' }, { id: '2', name: 'Halloween' }]))
      .toBe('Dracula and Halloween will be deleted from iScored, with every score on them.');
  });
});
