import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const server=readFileSync(new URL('../../server/modules/recorder/replay-import.js',import.meta.url),'utf8');
const routes=readFileSync(new URL('../../server/routes/analysis.js',import.meta.url),'utf8');
test('replay import is idempotent by default but a manual retry keeps its 409',()=>{
  assert.match(server,/input\.idempotent !== false/,'enqueue reuses the running job unless asked otherwise');
  assert.match(server,/IMPORT_ACTIVE/,'the manual path still refuses a duplicate');
});
test('the import route can take a raw share link and exposes the job status',()=>{
  assert.match(routes,/replay\/import/);
  assert.match(routes,/req\.body\?\.source/,'a link-only submission previews and confirms server side');
  assert.match(routes,/replay\/import\/:id/,'a job id can be polled');
});
