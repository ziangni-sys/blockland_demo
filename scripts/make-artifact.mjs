// Turns the single-file build (dist-artifact/index.html) into a page fragment for hosts
// that wrap the content in their own <html><head><body> skeleton: strips the document
// wrapper tags and keeps <title>, <style>, markup and the inlined module script.
// Usage: node scripts/make-artifact.mjs [in] [out]
import { readFileSync, writeFileSync } from 'node:fs';

const input = process.argv[2] ?? 'dist-artifact/index.html';
const output = process.argv[3] ?? 'dist-artifact/blocklands.html';

let html = readFileSync(input, 'utf8');

if (/<script[^>]+src=/.test(html) || /<link[^>]+rel="stylesheet"/.test(html)) {
  throw new Error('artifact build still references external script/style files — single-file inlining failed');
}

html = html
  .replace(/<!doctype[^>]*>/i, '')
  .replace(/<html[^>]*>/i, '')
  .replace(/<\/html>/i, '')
  .replace(/<head[^>]*>/i, '')
  .replace(/<\/head>/i, '')
  .replace(/<body[^>]*>/i, '')
  .replace(/<\/body>/i, '')
  .replace(/<meta\s+charset[^>]*>/i, '')
  .replace(/<meta\s+name="viewport"[^>]*>/i, '')
  .trim();

if (!/<title>[^<]+<\/title>/.test(html.slice(0, 8192))) {
  throw new Error('the page needs a <title> within the first 8 KB');
}

writeFileSync(output, html + '\n');
const mb = Buffer.byteLength(html) / (1024 * 1024);
console.log(`wrote ${output} (${mb.toFixed(2)} MB)`);
if (mb > 15.5) throw new Error('artifact is too large (limit 16 MB)');
