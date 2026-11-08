// Every script parses. The 3D code (render3d, dummy rider, bike) is never imported by the other tests,
// so a broken line there only showed in the browser, which then quietly fell back to 2D.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every script in js/ parses', () => {
  const files = readdirSync(join(root, 'js')).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 10);
  const broken = [];
  for (const f of files) {
    try { execFileSync(process.execPath, ['--check', join(root, 'js', f)], { stdio: 'pipe' }); } catch (e) { broken.push(`${f}: ${String(e.stderr).split('\n').slice(0, 4).join(' ')}`); }
  }
  assert.deepEqual(broken, []);
});
