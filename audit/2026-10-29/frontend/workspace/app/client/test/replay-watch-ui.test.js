import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/pages/Pocket48.jsx',import.meta.url),'utf8');
test('the account panel exposes the daily replay watch with its own save and manual run',()=>{
  assert.match(source,/每天自动巡检成员回放/);
  assert.match(source,/aria-label="巡检成员 ID"/);
  assert.match(source,/立即检查一次/);
  assert.match(source,/每 24 小时最多检查一次/,'the daily limit is stated in the UI');
  assert.match(source,/只导入开启之后开始的公开回放/,'the window rule is stated in the UI');
});
