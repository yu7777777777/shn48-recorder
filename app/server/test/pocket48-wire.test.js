const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'p48-wire-'));
const https=require('node:https'),{EventEmitter}=require('node:events');
const api=require('../modules/pocket48/api');
const account=require('../modules/pocket48/account');
test('conversation IDs resolve by member to chat channels; scopes and pagination stay separate',async()=>{
 const original=https.request, originalFetch=global.fetch, calls=[];
 global.fetch=async (url, options)=>{assert.equal(url,'https://data.gnz.hk/members.json');assert.equal(options.headers,undefined);return {ok:true,json:async()=>[{id:63,channelId:777,serverId:99}]};};
 https.request=(options,callback)=>{
  const req=new EventEmitter();let body='';req.write=s=>{body+=s;};req.setTimeout=()=>{};req.destroy=()=>{};
  req.end=()=>queueMicrotask(()=>{
   const input=JSON.parse(body);calls.push({path:options.path,body:input});
   let content;
   if(options.path.endsWith('/check/today'))content={hasCheck:true};
   else if(options.path.endsWith('/conversation/page'))content={conversations:[{targetType:0,targetId:'10',targetName:'房间',ownerId:'63',ownerName:'成员',msg:'不应泄露在房间列表'},{targetType:1,targetId:'11',ownerId:'9'}]};
   else if(options.path.endsWith('/room/info')) {assert.equal(input.channelId,'10');content={serverId:'99'};}
   else if(options.path.includes('/team/message/list/')) {
    assert.equal(input.channelId,'777');assert.equal(input.serverId,'99');assert.ok(['0','123'].includes(input.nextTime));
    content={message:[{msgId:input.nextTime==='123'?'m0':'m1',bodys:'{"text":"频道消息"}'}],nextTime:'123'};
   }
   else {assert.equal(input.ownerId,'63');assert.equal(input.roomId,'10');content=input.nextTime==='123'?{message:[{msgId:'m0'}],nextTime:0}:{message:[],nextTime:0};}
   const res=new EventEmitter();res.statusCode=200;callback(res);res.emit('data',JSON.stringify({status:200,content}));res.emit('end');
  });return req;
 };
 try {
  assert.equal(account.content(await api.getCheckinInfo()).hasCheck,true);
  const rooms=account.content(await api.getRoomList()).rooms;assert.equal(rooms.length,1);assert.equal(rooms[0].msg,undefined);
  assert.equal(rooms[0].ownerName,'成员');
  assert.equal(account.content(await api.getRoomMessages('10')).message[0].msgId,'m1');
  assert.equal(account.content(await api.getRoomMessages('10','123')).message[0].msgId,'m0');
  await api.getAllRoomMessages('10');
  // 仅成员 is the QChat channel transcript itself and already carries LIVEPUSH,
  // so the member path makes no second notification request.
  assert.equal(account.content(await api.getRoomMessages('10',undefined,'members')).message[0].msgId,'m1');
  // A room opened straight from the conversation list still reaches the
  // notification endpoint, which is keyed by that conversation room id.
  await api.getRoomMessages('10',undefined,'notifications');
  await assert.rejects(api.getRoomMessages('10',undefined,'invalid'), /消息类型无效/);
  assert.deepEqual(calls.map(c=>c.path),['/user/api/v1/checkin/check/today','/im/api/v1/conversation/page','/im/api/v1/team/message/list/homeowner','/im/api/v1/team/message/list/homeowner','/im/api/v1/team/message/list/all','/im/api/v1/team/message/list/homeowner','/im/api/v1/chatroom/msg/list/homeowner']);
  assert.throws(()=>account.content({status:404,data:{status:404}}),/接口不存在/);
 }finally{https.request=original;global.fetch=originalFetch;}
});

test('room diagnosis probes every message endpoint and reports which one has rows',async()=>{
 // Module state (room list cache, one-hour directory) is per process, so this
 // test gets its own copies instead of inheriting whatever the first one saw.
 const apiPath=require.resolve('../modules/pocket48/api');
 for (const key of Object.keys(require.cache)) if (key.includes('modules'+path.sep+'pocket48')) delete require.cache[key];
 const probe=require('../modules/pocket48/api');
 const original=https.request, originalFetch=global.fetch;
 global.fetch=async()=>({ok:true,json:async()=>[{id:10,channelId:777,serverId:99}]});
 https.request=(options,callback)=>{
  const req=new EventEmitter();let body='';req.write=s=>{body+=s;};req.setTimeout=()=>{};req.destroy=()=>{};
  req.end=()=>queueMicrotask(()=>{
   const content=options.path.endsWith('/conversation/page')?{conversations:[{targetType:0,targetId:'10',ownerId:'10',ownerName:'成员'}]}
    :options.path.endsWith('/team/message/list/all')?{message:[{msgId:'a'},{msgId:'b'}]}
    :{message:[]};
   const res=new EventEmitter();res.statusCode=200;callback(res);res.emit('data',JSON.stringify({status:200,content}));res.emit('end');
  });return req;
 };
 try {
  // Warm this copy's own room cache (it must be the same module instance that
  // the probe reads from, i.e. the freshly required one).
  await probe.getRoomList();
  const report=await probe.probeRoomMessages('10');
  assert.equal(report.channel,true);
  assert.equal(report.report.length,2);
  // The channel stream has rows; the IM room stream answered 200 with none. The
  // report has to tell those two apart, otherwise an empty room and a broken
  // endpoint look identical.
  assert.deepEqual(report.report.map(r=>[r.source,r.ok,r.rows]),[['channel',true,2],['room',true,0]]);
 } finally { https.request=original; global.fetch=originalFetch; }
});

test('directory rows are openable: roomId falls back to channelId when the directory has none',async()=>{
 // FIXTURE-ROOMID — Regression: the public directory carries NO roomId column
 // (live 962-row fetch: id/channelId/serverId only). 1.21.0 assumed it existed,
 // shipped roomId:'' for all 531 members, and the UI disables rows without a
 // roomId — so every member row was dead on the live server.
 const originalFetch=global.fetch;
 global.fetch=async()=>({ok:true,json:async()=>[{id:1,ownerName:'测试',channelId:36393209,serverId:29266435,team:'TEAM X'}]});
 const path=require('node:path');
 for (const key of Object.keys(require.cache)) if (key.includes('modules'+path.sep+'pocket48')) delete require.cache[key];
 try {
  const dir=require('../modules/pocket48/room-directory');
  const roster=await dir.roster();
  const member=roster.flatMap(g=>g.members)[0];
  assert.equal(member.roomId,'36393209','没有 roomId 时必须回落到 channelId，否则整行不可点击');
  assert.equal(member.channelId,'36393209');
 } finally { global.fetch=originalFetch; }
});

test('directory parses both live shapes (bare array and {roomId:[...]})',async()=>{
 // FIXTURE-SHAPES — the same URL served a bare array first and a {roomId:[...]}
 // wrapper hours later. 1.21.0 only looked at data.roomId (undefined on the
 // array shape); a naive fix that only looks at arrays breaks on the wrapper.
 const dir=require('../modules/pocket48/room-directory');
 const row={id:1,ownerName:'测试',channelId:777,serverId:99,team:'TEAM X'};
 assert.deepEqual(dir.memberRows([row]),[row]);
 assert.deepEqual(dir.memberRows({roomId:[row]}),[row]);
 assert.deepEqual(dir.memberRows({members:[row]}),[row]);
 assert.equal(dir.memberRows({other:1}),null);
});

test('直播通知 resolves the conversation room from the channel id used by the member list',async()=>{
 // FIXTURE-NOTIF — the UI opens a member by their channelId (directory roomId),
 // but chatroom/msg/list/homeowner is keyed by the conversation room id. A strict
 // id match made 仅成员 always answer "直播通知需要从房间列表中选择成员".
 const originalFetch=global.fetch, originalHttps=require('node:https').request;
 const {EventEmitter}=require('node:events');
 global.fetch=async()=>({ok:true,json:async()=>[{id:6431,ownerName:'陈琳',channelId:1279493,serverId:1213951,team:'TEAM X'}]});
 const sent=[];
 require('node:https').request=(options,callback)=>{
  const req=new EventEmitter();let body='';req.write=s=>{body+=s;};req.setTimeout=()=>{};req.destroy=()=>{};
  req.end=()=>queueMicrotask(()=>{
   const input=JSON.parse(body); sent.push({path:options.path,body:input});
   const content=options.path.endsWith('/conversation/page')
     ? {conversations:[{targetType:0,targetId:'67207851',targetName:'房间',ownerId:'6431',ownerName:'陈琳'}]}
     : {message:[],nextTime:'0'};
   const res=new EventEmitter();res.statusCode=200;callback(res);res.emit('data',JSON.stringify({status:200,content}));res.emit('end');
  });return req;
 };
 const mkdir=require('node:path');
 for (const key of Object.keys(require.cache)) if (key.includes('modules'+mkdir.sep+'pocket48')) delete require.cache[key];
 try {
  const api=require('../modules/pocket48/api');
  await api.getRoomList();
  await api.getRoomMessages('1279493',undefined,'notifications');
  const call=sent.find(c=>c.path.includes('chatroom/msg/list/homeowner'));
  assert.ok(call,'通知接口必须被调用，而不是直接报"直播通知需要从房间列表中选择成员"');
  assert.equal(call.body.roomId,'67207851','必须用会话房间号');
  assert.equal(call.body.ownerId,'6431');
 } finally { global.fetch=originalFetch; require('node:https').request=originalHttps; }
});

test('a quiet channel is a complete answer for 仅成员, not a reason to fall back',async()=>{
 // FIXTURE-QUIET — 刘增艳's channel had no rows while 全部 had 22. Treating an
 // empty channel as "no answer" flattened the members view to 0 rows.
 const {EventEmitter}=require('node:events');
 const originalFetch=global.fetch, originalHttps=require('node:https').request;
 global.fetch=async()=>({ok:true,json:async()=>[{id:6431,ownerName:'x',channelId:1279493,serverId:1213951,team:'A'}]});
 const sent=[];
 require('node:https').request=(options,callback)=>{
  const req=new EventEmitter();let body='';req.write=s=>{body+=s;};req.setTimeout=()=>{};req.destroy=()=>{};
  req.end=()=>queueMicrotask(()=>{
   const input=JSON.parse(body); sent.push(options.path);
   const content=options.path.endsWith('/conversation/page')
     ? {conversations:[{targetType:0,targetId:'67207851',ownerId:'6431'}]}
     : options.path.endsWith('/team/message/list/homeowner') ? {message:[]} : {message:[]};
   const res=new EventEmitter();res.statusCode=200;callback(res);res.emit('data',JSON.stringify({status:200,content}));res.emit('end');
  });return req;
 };
 const sep=require('node:path').sep;
 for (const key of Object.keys(require.cache)) if (key.includes('modules'+sep+'pocket48')) delete require.cache[key];
 try {
  const api=require('../modules/pocket48/api');
  await api.getRoomList();
  const r=await api.getRoomMessages('1279493',undefined,'members');
  assert.equal(r.status,200);
  assert.equal(sent.filter(p=>p.includes('chatroom/msg/list')).length,0,'频道正常应答时不应再打房间流');
 } finally { global.fetch=originalFetch; require('node:https').request=originalHttps; }
});
