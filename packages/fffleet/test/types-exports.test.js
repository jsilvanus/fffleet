// The hand-written declarations must list every runtime export (and nothing the runtime lacks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as runtime from '../src/index.js';
import * as server from '../src/server.js';

const declared = file => {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  return new Set([...text.matchAll(/^export (?:declare )?(?:async )?(?:function|const|class)\s+(\w+)/gm)].map(m => m[1]));
};

for (const [file, mod] of [['index.d.ts', runtime], ['server.d.ts', server]]) {
  test(`${file} declares exactly the runtime exports`, () => {
    const names = declared(file);
    const actual = Object.keys(mod);
    assert.deepEqual(actual.filter(n => !names.has(n)), [], `exported at runtime but not declared in ${file}`);
    assert.deepEqual([...names].filter(n => !actual.includes(n)), [], `declared in ${file} but not exported at runtime`);
  });
}
