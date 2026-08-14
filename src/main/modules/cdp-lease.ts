export type CdpLeaseOwner = 'password-capture' | 'automation';

export type CdpDebuggerLike = {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
};

export type CdpWebContentsLike = {
  id: number;
  isDestroyed(): boolean;
  debugger: CdpDebuggerLike;
};

export type CdpLease = {
  readonly owner: CdpLeaseOwner;
  readonly webContentsId: number;
  readonly released: boolean;
  release(): void;
};

type LeaseRecord = {
  owner: CdpLeaseOwner;
  token: symbol;
};

const leases = new Map<number, LeaseRecord>();

/**
 * Electron permits only one Debugger client per WebContents. Keep ownership
 * explicit so password capture and automation can never detach each other.
 */
export function acquireCdpLease(
  webContents: CdpWebContentsLike,
  owner: CdpLeaseOwner,
  protocolVersion = '1.3',
): CdpLease {
  if (webContents.isDestroyed()) throw new Error(`cannot acquire CDP lease for destroyed WebContents ${webContents.id}`);
  const current = leases.get(webContents.id);
  if (current) throw new Error(`CDP is already leased by ${current.owner}`);
  if (webContents.debugger.isAttached()) throw new Error('CDP is already attached by an unmanaged client');

  const token = Symbol(`${owner}:${webContents.id}`);
  webContents.debugger.attach(protocolVersion);
  leases.set(webContents.id, { owner, token });
  let released = false;

  return {
    owner,
    webContentsId: webContents.id,
    get released(): boolean { return released; },
    release(): void {
      if (released) return;
      released = true;
      const active = leases.get(webContents.id);
      if (active?.token !== token) return;
      leases.delete(webContents.id);
      if (!webContents.isDestroyed() && webContents.debugger.isAttached()) webContents.debugger.detach();
    },
  };
}

export function getCdpLeaseOwner(webContentsId: number): CdpLeaseOwner | null {
  return leases.get(webContentsId)?.owner ?? null;
}

