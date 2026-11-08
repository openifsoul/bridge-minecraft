import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
test('documented optional separator reads the config and refuses unapproved offline use',()=>{
 for(const args of [['config.example.json'],['--','config.example.json']]){
  const result=spawnSync(process.execPath,['src/start.mjs',...args],{cwd:root,encoding:'utf8',timeout:5000});
  assert.equal(result.status,1);assert.match(result.stderr,/Invalid bounded local configuration/);assert.doesNotMatch(result.stderr,/ENOENT/);
 }
});
