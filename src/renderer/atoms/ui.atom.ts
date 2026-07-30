import { atom } from 'jotai';

export interface PanelType {
  type: 'favorites' | 'history' | 'downloads' | 'settings' | 'passwords';
}

export const activePanelAtom = atom<PanelType | null>(null);
export const findBarVisibleAtom = atom(false);
export const findBarTextAtom = atom('');
export const showZoomOverlayAtom = atom(false);

export interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  tabId: string;
  linkURL?: string;
  selectionText?: string;
  isEditable?: boolean;
}

export const contextMenuAtom = atom<ContextMenuState>({
  visible: false,
  x: 0,
  y: 0,
  tabId: '',
});
