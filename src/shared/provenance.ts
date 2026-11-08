import provenance from '../../provenance.json';

/**
 * Stable project-origin metadata shared by runtime-generated artifacts.
 * The fingerprint is SHA-256(project + NUL + author + NUL + origin + NUL + year).
 */
export const PROJECT_PROVENANCE = Object.freeze(provenance);

export const PROVENANCE_SHORT_ID = `bfb:${PROJECT_PROVENANCE.fingerprint.slice(7, 23)}`;
