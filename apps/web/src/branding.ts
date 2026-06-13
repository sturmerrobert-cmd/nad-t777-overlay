/**
 * Single source of truth for product branding.
 *
 * The product is INDEPENDENT and UNOFFICIAL. Brand names of third parties
 * (NAD, Dolby, DTS, Dirac) must NOT appear as our branding — only
 * descriptively, to state hardware compatibility (nominative use; see
 * DISCLAIMER.txt). We do NOT use the streaming-module trademark at all: its
 * built-in streamer is referred to only generically ("streaming module", brand
 * "BO"). Device-reported labels (e.g. SourceN.Name) are NOT our branding and
 * are rendered as-is.
 */
export const PRODUCT_NAME = 'Receiver HQ';

/**
 * One-time, descriptive compatibility line for the About screen / store / README.
 * Trademark-free: names only NAD (descriptive) and the generic "streaming
 * modules" category — never a third-party streaming brand.
 */
export const COMPAT_LINE = `${PRODUCT_NAME} — kompatybilny z amplitunerami NAD oraz ich modułami streamującymi`;

/**
 * Dirac is the highest legal risk (trademark requires prior written consent;
 * the :5006 API is unofficial). DISABLED by default: when false the UI hides
 * any Dirac panel and the backend does not probe :5006. Do not flip to true
 * without written Dirac consent (see DIRAC-EMAIL.md).
 */
export const DIRAC_ENABLED = false;
