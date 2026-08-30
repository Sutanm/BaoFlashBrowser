export const AUTOMATION_IMAGE_GROUP_PREFIX = '@bao-image-group:';

export function encodeAutomationImageGroup(assets: readonly string[]): string {
  return `${AUTOMATION_IMAGE_GROUP_PREFIX}${assets.map((asset) => encodeURIComponent(asset)).join('|')}`;
}

export function decodeAutomationImageGroup(value: string): readonly string[] | null {
  if (!value.startsWith(AUTOMATION_IMAGE_GROUP_PREFIX)) return null;
  const assets = value.slice(AUTOMATION_IMAGE_GROUP_PREFIX.length).split('|').filter(Boolean).map((asset) => decodeURIComponent(asset));
  return assets.length >= 2 ? assets : null;
}

export type AutomationImageGroup = {
  readonly directory: string;
  readonly assets: readonly string[];
  readonly value: string;
};

/** A subdirectory containing at least two direct image children is an image group. */
export function collectAutomationImageGroups(assets: readonly string[]): readonly AutomationImageGroup[] {
  const groups = new Map<string, string[]>();
  for (const asset of [...new Set(assets)].sort()) {
    const separator = asset.lastIndexOf('/');
    if (separator <= 0) continue;
    const directory = asset.slice(0, separator);
    if (directory === 'assets') continue;
    const members = groups.get(directory) ?? [];
    members.push(asset);
    groups.set(directory, members);
  }
  return [...groups.entries()]
    .filter(([, members]) => members.length >= 2)
    .map(([directory, members]) => ({ directory, assets: members, value: encodeAutomationImageGroup(members) }));
}
