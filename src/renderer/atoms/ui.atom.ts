import { atom } from 'jotai';

export interface PanelType {
  type: 'favorites' | 'history' | 'downloads' | 'settings' | 'passwords';
}

export const activePanelAtom = atom<PanelType | null>(null);
export const findBarVisibleAtom = atom(false);
export const findBarTextAtom = atom('');
export const showZoomOverlayAtom = atom(false);
