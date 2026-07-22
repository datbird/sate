// Type surface for the shared, runtime-agnostic barcode normalization helpers (./barcode.js).
// The .js is the implementation and the source of truth; this file only describes it for
// TypeScript consumers. Keep the two in step when either changes.

/** Strip leading zeros — the loose form used when comparing codes for equality. */
export declare function normUpc(s: unknown): string;

/** UPC-A check digit for an 11-digit body (mod-10, odd positions ×3). */
export declare function upcACheck(b11: string): string;

/** Expand a compressed UPC-E barcode to its 12-digit UPC-A form; null if not UPC-E-shaped. */
export declare function upcEtoA(e: string): string | null;

/** Ordered, deduped equivalent barcode forms (UPC-E / UPC-A / EAN-13 / GTIN-14) to try in lookups. */
export declare function barcodeVariants(code: string): string[];
