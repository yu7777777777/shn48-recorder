import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../../server/package.json',import.meta.url));
const express=require('express'),{chromium}=require('playwright');
// The console asks one question of each member: "do I follow them, and what did
// they say?" The left panel is therefore a follow manager over the FULL member
// roster — the room list only ever contains members already followed, so it
// cannot be used to add one. This test proves both directions of follow work
// against the friendship API, that the transcript is one column with a scope
// filter, and that the account/check-in dialog still behaves.
test('follow manager toggles the account follow list and reads one transcript',async()=>{
 const app=express(),dist=fileURLToPath(new URL('../dist/',import.meta.url));app.use(express.static(dist));app.get('*',(_,r)=>r.sendFile(dist+'index.html'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});let signed=false,current='1048';
 // The server's follow set is the single source of truth; the UI must reflect it,
 // not a local guess, so this mock stores it and re-derives the roster each read.
 let followed=new Set(['2001']);const followCalls=[];
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const scopeCalls=[];
 // roomState comes from the server's background probe. 246 of the real 531
 // members have a revoked channel, so the row flag and the "已收回" group are
 // part of the contract, not decoration.
 const roster=()=>({followedCount:followed.size,goneCount:1,openCount:2,totalCount:3,groups:[
   {teamName:'TEAM X',members:[
     {ownerId:'2001',ownerName:'SNH48-王睿琦',roomId:'67362328',groupName:'SNH48',followed:followed.has('2001'),roomState:'ok'},
     {ownerId:'2002',ownerName:'SNH48-杨冰怡',roomId:'67333093',groupName:'SNH48',followed:followed.has('2002'),roomState:'ok'}]},
   {teamName:'',members:[
     {ownerId:'63',ownerName:'袋王',roomId:'67236601',groupName:'官方',followed:followed.has('63'),roomState:'gone'}]},
 ]});
 await page.route('**/api/**',route=>{
 const u=new URL(route.request().url()),p=u.pathname,m=route.request().method();const send=data=>route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data})});
 if(p.endsWith('/switch')){assert.deepEqual(route.request().postDataJSON(),{userId:'2048'});current='2048';signed=false;followed=new Set();return send({authenticated:true});}
 if(p.endsWith('/profile'))return send({nickname:current==='1048'?'测试账号':'测试小号',userId:current,level:12,accounts:[{userId:'1048',nickname:'测试账号',kind:'main',current:current==='1048'},{userId:'2048',nickname:'测试小号',kind:'small',current:current==='2048'}]});
 if(p.endsWith('/checkin')){if(m==='POST')signed=true;return send({hasCheck:signed,checkinDays:28});}
 if(p.endsWith('/rooms/67362328/messages')){
   const scope=u.searchParams.get('scope'),older=u.searchParams.has('nextTime');scopeCalls.push(scope);
   // 全部消息 carries fan chatter as well as the member's own lines; 仅成员 is
   // the member plus the live/翻牌 notification stream.
   if(scope==='notifications')return send({message:[],nextTime:'0'});
   if(scope==='all')return send({message:[{msgId:older?'f2':'f1',senderName:'粉丝甲',msgTime:Date.now(),bodys:JSON.stringify({text:older?'更早的弹幕':'直播间弹幕一条'})}],nextTime:older?'0':'1234'});
   return send({message:[{msgId:older?'2':'1',senderName:'测试成员',msgTime:Date.now(),bodys:JSON.stringify({text:older?'更早的消息':'晚上好，今天也辛苦啦。'})}],nextTime:older?'0':'1234'});
 }
 // Follow/unfollow mutate the account's follow set. The DELETE must be matched
 // before the POST branch, or unfollow silently no-ops.
 if(p.endsWith('/friendships/roster'))return send(roster());
 // Read-only self-test: reports which upstream endpoint actually has rows.
 if(p.endsWith('/diagnose')){
   assert.match(p,/\/rooms\/67362328\/diagnose$/);
   return send({roomId:'67362328',channel:true,directoryError:'',report:[{source:'channel',ok:true,http:200,code:200,rows:1},{source:'room',ok:true,http:200,code:200,rows:0}]});
 }
 if(p.includes('/friendships/followed/')){const id=decodeURIComponent(p.split('/').pop());followCalls.push(['remove',id]);followed.delete(id);return send({ownerId:id,followed:false});}
 if(p.endsWith('/friendships/followed')){const id=String(route.request().postDataJSON().ownerId);followCalls.push(['add',id]);followed.add(id);return send({ownerId:id,followed:true});}
 return send({authenticated:true,health:'ok'});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/admin/pocket48`);

 // The page is one header button plus the workspace: no account card, no check-in card.
 await page.getByRole('button',{name:'账号与签到'}).click();
 await page.getByRole('heading',{name:'账号与签到设置'}).waitFor();
 await page.locator('.p48-profile').getByText('测试账号',{exact:true}).waitFor();
 await page.getByRole('button',{name:'立即签到'}).click();
 await page.getByRole('button',{name:'今日已完成'}).waitFor();
 await page.keyboard.press('Escape');
 await page.getByRole('heading',{name:'账号与签到设置'}).waitFor({state:'detached'});

 // The roster is the full member list, so people you do NOT follow are visible
 // and can be added — the whole point of replacing the room list here.
 await page.getByRole('button',{name:'关注 TEAM X · 杨冰怡',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'取消关注 TEAM X · 王睿琦',exact:true}).count(),1,'已关注成员显示为可取消');
 assert.equal(await page.getByRole('button',{name:'关注 袋王',exact:true}).count(),1,'无队伍成员也能关注');
 await page.locator('.p48-rooms-foot').getByText('已关注').waitFor();

 // ADD a follow: this is what the old room list could never do.
 await page.getByRole('button',{name:'关注 TEAM X · 杨冰怡',exact:true}).click();
 await page.getByRole('button',{name:'取消关注 TEAM X · 杨冰怡',exact:true}).waitFor();
 assert.deepEqual(followCalls.at(-1),['add','2002']);

 // 首次点开房间必须直接读到消息。回归点：作用域合并时"从未请求过的数据源"
 // 边界是 -Infinity，永远不等于共享前沿，于是刷新把它整条跳过，房间一直是空的，
 // 只有切换一次作用域才恢复。
 // 全部 / 已关注 两个视图共用同一份名单：切换只做筛选，不重新取数，
 // 以免 500+ 行名单滚动时行对象被替换、星标状态闪烁。
 const memberScope=page.getByRole('group',{name:'成员范围'});
 const viewAll=memberScope.getByRole('button',{name:/^全部/}),viewFollowed=memberScope.getByRole('button',{name:/^已关注/});
 await viewFollowed.click();
 await page.getByRole('button',{name:'取消关注 TEAM X · 王睿琦',exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'关注 TEAM X · 杨冰怡',exact:true}).count(),0,'已关注视图不含未关注成员');
 assert.equal(await page.getByRole('button',{name:'关注 袋王',exact:true}).count(),0);

 await viewAll.click();
 // Back to the full roster: the unfollowed members (and 袋王) reappear.
 // A revoked room must be labelled where the reader decides, not only after
 // clicking: the row carries a tag and the 已收回 group isolates those members.
 await page.locator('.p48-room-open.gone').first().waitFor({state:'visible'});
 assert.equal(await page.locator('.p48-room-gone').count(),1,'已收回的行在名单里就有标记');
 assert.match(await page.locator('.p48-room-open.gone').first().getAttribute('aria-label'),/房间已收回/, '可访问名称说明房间已收回');
 const viewGone=memberScope.getByRole('button',{name:/已收回/});
 await viewGone.click();
 await page.locator('.p48-room-open.gone').first().waitFor({state:'visible'});
 assert.equal(await page.getByRole('button',{name:'取消关注 TEAM X · 王睿琦',exact:true}).count(),0,'已收回视图只含被收回的房间');
 await viewGone.click();
 await page.getByRole('button',{name:'取消关注 TEAM X · 王睿琦',exact:true}).waitFor();
 // 正常 is 已收回's counterpart: only rows whose room probe answered "ok". A
 // revoked room and a member with no room id belong to neither bucket.
 const viewOpen=memberScope.getByRole('button',{name:/^正常/});
 await viewOpen.click();
 await page.getByRole('button',{name:'取消关注 TEAM X · 王睿琦',exact:true}).waitFor();
 assert.equal(await page.locator('.p48-room-open.gone').count(),0,'正常视图不含被收回的房间');
 assert.equal(await page.getByRole('button',{name:'关注 袋王',exact:true}).count(),0,'正常视图不含已收回成员');
 await viewOpen.click();
 await page.getByRole('button',{name:'取消关注 TEAM X · 王睿琦',exact:true}).waitFor();
 // 队伍标题是折叠控件：20+ 个队伍全部展开时，要翻到底才能找到某个队伍。
 // 收起后该队的成员行必须真正离开可见列表，而不是只换成零高度。
 const teamX=page.locator('.p48-room-group-toggle').filter({hasText:'TEAM X'});
 assert.equal(await teamX.getAttribute('aria-expanded'),'true','默认展开');
 await teamX.click();
 assert.equal(await teamX.getAttribute('aria-expanded'),'false','点击后收起');
 assert.equal(await page.getByRole('button',{name:'取消关注 TEAM X · 王睿琦',exact:true}).count(),0,'收起后成员行不再出现');
 assert.equal(await page.getByRole('button',{name:'关注 袋王',exact:true}).count(),1,'其他队伍不受影响');
 // 收起状态记在 localStorage，下次打开仍然折叠。
 const stored=await page.evaluate(()=>localStorage.getItem('pocket48.collapsedTeams'));
 assert.match(stored,/TEAM X/,'折叠状态已持久化');
 await teamX.click();
 await page.getByRole('button',{name:'取消关注 TEAM X · 王睿琦',exact:true}).waitFor();
 // 一键收起/展开全部队伍：已选中的成员所在队伍保持展开，否则选中的行会凭空消失。
 await page.getByRole('button',{name:/收起全部队伍/}).click();
 assert.equal(await teamX.getAttribute('aria-expanded'),'false','TEAM X 已收起');
 // 批量按钮始终描述"点一下会发生什么"：全收起时它变成展开入口。
 // （此视图下只有 TEAM X 一个队伍，点开后别处没有可展开的行。）
 await page.getByRole('button',{name:/展开全部队伍/}).click();
 assert.equal(await teamX.getAttribute('aria-expanded'),'true','一键展开后恢复');
 await page.getByRole('button',{name:'取消关注 TEAM X · 王睿琦',exact:true}).waitFor();
 // 在已关注视图里点开成员，消息照样要读得到（筛选不能影响读取链路）。
 await viewFollowed.click();
 await page.getByRole('button',{name:'TEAM X · 王睿琦',exact:true}).click();
 await page.getByLabel('消息列表').getByText('直播间弹幕一条').waitFor();
 await viewAll.click();
 // 房间读不到东西时，页面要能自证是哪个环节没数据：折叠面板里一键探测。
 const diagnose=page.locator('.p48-diagnose');
 await diagnose.getByText('看不到消息？检查读取链路').click();
 await diagnose.getByRole('button',{name:'探测该房间的消息接口'}).click();
 await diagnose.locator('.p48-diagnose-text').getByText(/"channel"/,{exact:false}).waitFor();

 // A single transcript, defaulting to the member+fan view.
 const stream=page.getByLabel('消息列表');
 assert.equal(await page.locator('.p48-stream').count(),1,'消息区只有一栏');
 assert.equal(await page.locator('.p48-message-columns').count(),0,'并排双栏已移除');
 // Clicking a member opens their room even when not currently followed.
 await page.getByRole('button',{name:'袋王，房间已收回',exact:true}).click();
 await page.getByRole('button',{name:'TEAM X · 王睿琦',exact:true}).click();
 await stream.getByText('直播间弹幕一条').waitFor();
 // "加载更早消息" is pinned below the transcript, not inside it. While it lived at
 // the end of the scroll area a long conversation pushed it out of view and only
 // its dashed border peeked out at the bottom edge.
 assert.equal(await stream.locator('.p48-history').count(),0,'加载更早消息不再位于滚动区内');
 assert.equal(await page.locator('.p48-stream-foot .p48-history').count(),1,'加载更早消息固定在消息区底栏');
 await page.getByRole('button',{name:'加载更早消息'}).click();
 await stream.getByText('更早的弹幕').waitFor();

 // Switching scope re-reads the same room with the members-only stream.
 await page.getByRole('button',{name:'仅成员'}).click();
 await stream.getByText('晚上好，今天也辛苦啦。').waitFor();
 assert.equal(await stream.getByText('直播间弹幕一条').count(),0,'仅成员视图不含粉丝消息');
 assert.ok(scopeCalls.includes('members'),'仅成员按 members 作用域请求');
 await page.getByRole('button',{name:'加载更早消息'}).click();
 await stream.getByText('更早的消息').waitFor();

 assert.equal(await page.getByText('监听动态',{exact:false}).count(),0,'监听动态标签页已删除');
 await page.screenshot({animations:'disabled',path:fileURLToPath(new URL('../../docs/pocket48-preview.png',import.meta.url)),fullPage:true});

 await page.setViewportSize({width:390,height:844});await page.addStyleTag({content:'*,*::before,*::after{transition:none!important;animation:none!important}'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({animations:'disabled',path:fileURLToPath(new URL('../../docs/pocket48-mobile.png',import.meta.url)),fullPage:true});
 await page.setViewportSize({width:1440,height:1000});

 // REMOVE a follow, and confirm the row returns to the unfollowed state.
 await page.getByRole('button',{name:'取消关注 TEAM X · 杨冰怡',exact:true}).click();
 await page.getByRole('button',{name:'关注 TEAM X · 杨冰怡',exact:true}).waitFor();
 assert.deepEqual(followCalls.at(-1),['remove','2002']);

 // Switching account re-reads the follow set, which differs per account.
 await page.getByRole('button',{name:'账号与签到'}).click();
 await page.getByLabel('主号 / 小号',{exact:true}).selectOption('2048');
 await page.getByRole('button',{name:'切换账号',exact:true}).click();
 await page.locator('.p48-profile').getByText('测试小号',{exact:true}).waitFor();
 await page.getByRole('button',{name:'关注 TEAM X · 王睿琦',exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
