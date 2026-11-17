/**
 * Driver for the art contact-sheet tool. Skipped unless ART_SHEET_OUT names an output dir:
 *   ART_SHEET_OUT=/tmp/sheets npx vitest run tests/art/tools
 */
import { describe, expect, it } from 'vitest';
import { writeContactSheets } from './contactSheet';

const out = process.env['ART_SHEET_OUT'];

describe.runIf(Boolean(out))('art contact sheets', () => {
  it('writes the PNG sheets', () => {
    const files = writeContactSheets(out!);
    for (const f of files) console.log(`wrote ${f}`);
    expect(files.length).toBeGreaterThan(5);
  });
});
