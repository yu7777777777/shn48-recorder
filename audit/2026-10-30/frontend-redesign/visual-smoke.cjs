'use strict';
// Run from the repository root with the bundled Node executable. No production network.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const deps = createRequire(path.join(root, 'app/server/package.json'));
const express = deps('express');
const { chromium } = deps('playwright');
const dist = path.resolve(root, process.env.AUDIT_DIST || 'app/client/dist');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(__dirname, 'run-' + stamp);
fs.mkdirSync(out, { recursive: false });
const lives = [
 {liveId:'live-1',title:'今天也一起聊聊天',memberName:'SNH48-王睿琦',groupName:'SNH48',category:'视频直播',startTime:'2026-10-30T08:00:00Z'},
 {liveId:'live-2',title:'周五的练习室日记',memberName:'GNZ48-陈珂',groupName:'GNZ48',category:'电台',startTime:'2026-10-30T08:10:00Z'},
 {liveId:'live-3',title:'下班后的一点小分享',memberName:'BEJ48-张笑盈',groupName:'BEJ48',category:'视频直播',startTime:'2026-10-30T08:20:00Z'}
];
const replays = [...lives,...lives].map((x,i)=>({...x,replayId:'replay-'+(i+1),liveType:i%3===1?2:1,title:['秋日散步与今天的小确幸','晚安电台：听一首喜欢的歌','练习室下班后的日常分享','新舞台准备中，来聊聊近况','周末见面之前的碎碎念','一起记录普通但开心的一天'][i],duration:1800+i*331,startTime:'2026-10-29T11:30:00Z'}));
const recordings = replays.slice(0,3).map((x,i)=>({id:'recording-'+i,title:x.memberName+'-'+x.title,status:'done',source:'pocket48',container:'mp4',fileSize:1024*1024*233,createdAt:x.startTime,coverSource:'smart'}));
const members = [{userId:'2001',nickname:'SNH48-王睿琦',groupId:'1:101',groupIds:['1:101'],groupName:'SNH48 · TEAM X'},{userId:'2002',nickname:'SNH48-杨冰怡',groupId:'1:101',groupIds:['1:101'],groupName:'SNH48 · TEAM X'},{userId:'2003',nickname:'GNZ48-陈珂',groupId:'3:301',groupIds:['3:301'],groupName:'GNZ48 · TEAM G'}];
const roster = {followedCount:1,goneCount:1,openCount:2,totalCount:3,groups:[{teamName:'TEAM X',members:[{ownerId:'2001',ownerName:'SNH48-王睿琦',roomId:'67362328',groupName:'SNH48',followed:true,roomState:'ok'},{ownerId:'2002',ownerName:'SNH48-杨冰怡',roomId:'67333093',groupName:'SNH48',followed:false,roomState:'ok'}]},{teamName:'',members:[{ownerId:'63',ownerName:'袋王',roomId:'67236601',groupName:'官方',followed:false,roomState:'gone'}]}]};
const unknownApi = [];
function mock(req,res){
 const p=req.path;
 const send=data=>res.json({success:true,authenticated:true,data});
 if(req.method!=='GET')return res.status(405).json({success:false,error:'Audit is read-only'});
 if(p==='/public/live')return send({liveList:lives});
 if(p==='/public/replays')return send({list:replays,next:'0',hasMore:false});
 if(/^\/public\/replays\/[^/]+\/summary$/.test(p))return send({summary:'成员分享了练习、舞台准备与日常心情。这是用于独立截图验证的虚构内容。',chapters:[{title:'开场问候',summary:'聊聊今天的练习日常。'},{title:'近况分享',summary:'舞台准备中的小故事。'}],highlights:[]});
 // No real media requested. The expected no-playUrl state is identified in the report.
 if(p.endsWith('/play'))return send({protocol:'hls',auditMockNoMedia:true});
 if(p.endsWith('/download/status'))return send({status:'idle'});
 if(/^\/public\/replays\/[^/]+$/.test(p))return send({replay:replays.find(x=>p.endsWith('/'+x.replayId))||replays[0]});
 if(p.endsWith('/auth/session') && String(req.headers.referer || '').includes('/admin/login'))return res.json({success:true,authenticated:false,data:{authenticated:false}});
 if(p.endsWith('/auth/session')||p.endsWith('/auth/status'))return send({authenticated:true,health:'ok',credentialsPresent:true,nickname:'截图验证账号',userId:'1048'});
 if(p==='/admin/backup115/')return send({enabled:false,configured:false,jobs:[],files:[]});
 if(p.endsWith('/health'))return send({status:'ok',uptime:86500,storage:{free:560*1024**3,total:1024**4,used:464*1024**3,usedPercent:45.3}});
 if(p.endsWith('/recordings/active'))return send([]);
 if(p.endsWith('/recordings/storage'))return send({files:[],fileCount:3,totalBytes:699*1024**2});
 if(p.endsWith('/recordings/cover-batch'))return send({status:'idle'});
 if(p.endsWith('/recordings'))return send(recordings);
 if(p.endsWith('/bilibili/queue'))return send([]);
 if(p.endsWith('/auto-recording'))return send({enabled:true,members:[{id:'2001',name:'SNH48-王睿琦',priority:50}],maxConcurrent:2,pollInterval:60,active:[],pending:[],lastPollAt:'2026-10-30T08:30:00Z'});
 if(p.endsWith('/members'))return send({list:members,groups:[{groupId:'1:101',groupName:'SNH48 · TEAM X'},{groupId:'3:301',groupName:'GNZ48 · TEAM G'}]});
 if(p.endsWith('/friendships/roster'))return send(roster);
 if(p.endsWith('/auto-checkin'))return send({enabled:false,start:'09:00',end:'11:00'});
 if(p.endsWith('/replay-watch'))return send({enabled:false,memberId:'2001',memberName:'SNH48-王睿琦',lastQueued:0});
 if(p.endsWith('/profile'))return send({nickname:'截图验证账号',userId:'1048',level:12,accounts:[{userId:'1048',nickname:'截图验证账号',kind:'main',current:true}]});
 if(p.endsWith('/checkin'))return send({hasCheck:true,checkinDays:28});
 if(p.endsWith('/messages'))return send({message:[{msgId:'message-1',senderName:'SNH48-王睿琦',msgTime:1793347200000,bodys:JSON.stringify({text:'晚上好！今天的练习顺利结束啦。'})},{msgId:'message-2',senderName:'SNH48-王睿琦',msgTime:1793347260000,bodys:JSON.stringify({text:'明天也继续加油，大家记得早点休息。'})}],nextTime:'0'});
 unknownApi.push({method:req.method,path:p});return res.status(501).json({success:false,error:'Unmocked audit endpoint: '+p});
}
const cases=[
 {name:'live-list',url:'/',ready:'.public-live-card',text:'今天也一起聊聊天'},
 {name:'replay-list',url:'/replays',ready:'.replay-card',text:'秋日散步与今天的小确幸'},
 {name:'replay-detail',url:'/replays/replay-1',ready:'.public-replay-summary',text:'内容总结'},
 {name:'admin-overview',url:'/admin/overview',ready:'.admin-main h1',text:'系统总览'},
 {name:'admin-auto-record',url:'/admin/auto-record',ready:'.admin-main h1',text:'自动录制'},
 {name:'admin-pocket48',url:'/admin/pocket48',ready:'.p48-room-open',text:'王睿琦',room:true},
 {name:'admin-archive',url:'/admin/archive',ready:'.archive-record-card',text:'秋日散步与今天的小确幸'},
 {name:'admin-login',url:'/admin/login',ready:'input',text:'登录'}
];
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function run(){
 const manifest=[];function walk(dir){for(const f of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,f.name);if(f.isDirectory())walk(p);else manifest.push({file:path.relative(dist,p).replaceAll('\\','/'),sha256:sha(p),bytes:fs.statSync(p).size});}}walk(dist);
 const app=express();app.use('/api',mock);app.get('/favicon.ico',(_,res)=>res.status(204).end());app.use(express.static(dist));app.get('*',(_,res)=>res.sendFile(path.join(dist,'index.html')));
 let server,browser;const results=[];const metadata={startedAt:new Date().toISOString(),dist,manifest,node:process.version,chromePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',fixtureLimitations:['API为固定虚构数据，认证仅本地mock，不验证真实鉴权/接口/录制任务。','无媒体流；回放详情截图中的“播放接口没有返回播放地址”为明确模拟的无流状态，不是生产故障。','缺省图片为空，覆盖团体色封面和头像fallback；不访问外部图片。'],unknownApi};
 try{
 server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
 const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:metadata.chromePath,args:['--disable-background-networking']});metadata.browserVersion=browser.version();
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}])for(const entry of cases){
 const item={name:entry.name,route:entry.url,viewport,pageErrors:[],consoleErrors:[],consoleWarnings:[],httpErrors:[],failedRequests:[],blockedExternalRequests:[],interactions:[]};
 const context=await browser.newContext({viewport,locale:'zh-CN',timezoneId:'Asia/Shanghai',serviceWorkers:'block'});const page=await context.newPage();page.setDefaultTimeout(12000);
 page.on('pageerror',e=>item.pageErrors.push(e.message));page.on('console',m=>{if(m.type()==='error')item.consoleErrors.push(m.text());if(m.type()==='warning')item.consoleWarnings.push(m.text());});page.on('response',r=>{if(r.status()>=400)item.httpErrors.push({url:r.url(),status:r.status()});});page.on('requestfailed',r=>item.failedRequests.push({url:r.url(),failure:r.failure()?.errorText}));
 await context.route('**/*',route=>{const u=new URL(route.request().url());if(['http:','https:'].includes(u.protocol)&&u.origin!==origin){item.blockedExternalRequests.push(u.href);return route.abort('blockedbyclient');}return route.continue();});
 try{
 const response=await page.goto(origin+entry.url,{waitUntil:'networkidle',timeout:30000});item.status=response.status();await page.locator(entry.ready).first().waitFor();await page.getByText(entry.text,{exact:false}).first().waitFor();
 if(entry.room){await page.locator('.p48-room-open').filter({hasText:'王睿琦'}).first().click();await page.getByText('晚上好！今天的练习顺利结束啦。',{exact:false}).first().waitFor();item.interactions.push('打开王睿琦房间并验证消息');}
 await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(250);
 item.finalPath=new URL(page.url()).pathname;item.bodyText=(await page.locator('body').innerText()).slice(0,14000);
 item.layout=await page.evaluate(()=>{const w=innerWidth;return {viewport:w,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,horizontalOverflow:Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)>w+1,overflowElements:[...document.querySelectorAll('body *')].map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {tag:e.tagName,className:typeof e.className==='string'?e.className:'',left:Math.round(r.left),right:Math.round(r.right),display:s.display,visibility:s.visibility};}).filter(e=>e.display!=='none'&&e.visibility!=='hidden'&&e.left>=0&&e.right>w+1).slice(0,30)};});
 item.screenshot=entry.name+'-'+viewport.width+'.png';await page.screenshot({path:path.join(out,item.screenshot),fullPage:true,animations:'disabled'});
 if(viewport.width===390&&entry.name==='admin-overview'){const menu=page.getByRole('button',{name:'展开导航'});if(await menu.count()){await menu.click();await page.locator('.sidebar.open').waitFor();const extra='admin-mobile-menu-390.png';await page.screenshot({path:path.join(out,extra),animations:'disabled'});item.extraScreenshot=extra;item.interactions.push('打开移动端导航');}}
 item.pass=item.status===200&&item.finalPath===entry.url&&item.pageErrors.length===0&&item.consoleErrors.length===0&&item.httpErrors.length===0&&!item.layout.horizontalOverflow;
 }catch(e){item.error=e.stack;item.pass=false;try{item.screenshot=entry.name+'-'+viewport.width+'-failure.png';await page.screenshot({path:path.join(out,item.screenshot),fullPage:true});item.bodyText=(await page.locator('body').innerText()).slice(0,14000);}catch{}}
 results.push(item);await context.close();console.log(JSON.stringify({name:item.name,width:viewport.width,pass:item.pass,error:item.error,pageErrors:item.pageErrors,consoleErrors:item.consoleErrors,overflow:item.layout?.horizontalOverflow}));
 }
 }finally{if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}metadata.finishedAt=new Date().toISOString();metadata.serverClosed=true;fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({metadata,results},null,2));}
 const failed=results.filter(x=>!x.pass);const report=['# 前端美化独立浏览器截图审计','', '- 时间：'+metadata.startedAt,'- 构建目录：'+dist,'- Chrome：'+metadata.browserVersion,'- Node：'+metadata.node,'- 场景：'+results.length+'，通过：'+(results.length-failed.length)+'，失败：'+failed.length,'- 绑定127.0.0.1随机端口；测试进程内服务；finally关闭Chrome与HTTP服务。','- 不启动生产server、不连接生产、不读取凭据、不修改源码/测试/文档/dist。','','## 可复现命令','','从仓库根目录执行（PowerShell）：','','    & "C:/Users/Administrator/.dsh/dsh-runtimes/dsh-plugin-desktop-primary-runtime/dependencies/node/bin/node.exe" audit/2026-10-30/frontend-redesign/visual-smoke.cjs','','可选环境变量：CHROMIUM_PATH指定Chrome；AUDIT_DIST指定待验证dist。每次运行新建run-时间戳目录，避免覆盖历史证据。先由lead完成最终前端构建，再执行相同命令。','','## 限制','',...metadata.fixtureLimitations.map(x=>'- '+x),'','## 页面与截图','',...results.map(x=>'- '+x.name+' / '+x.viewport.width+'px：'+(x.pass?'PASS':'FAIL')+'；截图 ['+x.screenshot+']('+x.screenshot+')；pageerror '+x.pageErrors.length+'；console error '+x.consoleErrors.length+'；横向溢出 '+x.layout?.horizontalOverflow+(x.error?'；'+x.error.split('\n')[0]:'')),'','## 发现','',...(failed.length?failed.map(x=>'- '+x.name+' '+x.viewport.width+'px: '+(x.error||JSON.stringify({pageErrors:x.pageErrors,consoleErrors:x.consoleErrors,httpErrors:x.httpErrors,layout:x.layout}))):['- 当前mock场景未发现pageerror、console error、HTTP错误或页面级横向溢出。']),'','构建文件SHA-256、全部请求错误、页面文本、溢出元素和环境详情见 results.json。'];fs.writeFileSync(path.join(out,'REPORT.md'),report.join('\n'));console.log('AUDIT_OUTPUT='+out);if(failed.length||unknownApi.length)process.exitCode=1;
}
run().catch(e=>{console.error(e);process.exitCode=1;});
