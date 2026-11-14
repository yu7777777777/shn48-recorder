const {createRequire}=require('node:module');
const fs=require('node:fs');const path=require('node:path');
const deps=createRequire(path.resolve('app/server/package.json'));
const {chromium}=deps('playwright');const express=deps('express');
const out=__dirname;
async function run(){
 const app=express();const dist=path.join(out,'workspace/app/client/dist');
 app.use('/api',(req,res)=>{if(req.path==='/admin/auth/session')return res.json({success:true,authenticated:false,data:{authenticated:false}});if(req.path.endsWith('/health'))return res.json({success:true,data:{status:'ok'}});if(req.path==='/public/live')return res.json({success:true,data:{liveList:[]}});if(req.path==='/public/replays')return res.json({success:true,data:{list:[],next:'0'}});return res.status(401).json({success:false,error:'Audit unauthenticated mock'});});
 app.use(express.static(dist));app.get('*',(_,res)=>res.sendFile(path.join(dist,'index.html')));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const results=[];
 try{
  const local='http://127.0.0.1:'+server.address().port;
  for(const entry of [{name:'local-home',url:local},{name:'local-replays',url:local+'/replays'},{name:'local-admin-login',url:local+'/admin/login'},{name:'local-admin-protected',url:local+'/admin/archive'},{name:'production-home',url:'http://<SERVER_IP>:3000'},{name:'production-replays',url:'http://<SERVER_IP>:3000/replays'},{name:'production-replay-detail',url:'http://<SERVER_IP>:3000/replays/1322464033778765824'}]){
   const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'});const page=await context.newPage();
   const item={...entry,pageErrors:[],consoleErrors:[],httpErrors:[],failedRequests:[],blockedRequests:[]};
   page.on('pageerror',error=>item.pageErrors.push(error.message));page.on('console',msg=>{if(msg.type()==='error')item.consoleErrors.push(msg.text());});
   page.on('response',res=>{if(res.status()>=400)item.httpErrors.push({url:res.url(),status:res.status()});});
   page.on('requestfailed',req=>item.failedRequests.push({url:req.url(),error:req.failure()?.errorText}));
   await context.route('**/*',route=>{const req=route.request(),url=new URL(req.url());if(!['http:','https:'].includes(url.protocol))return route.continue();const permitted=url.origin===new URL(entry.url).origin;const forbidden=/\/(download|export)(\/|\?|$)|\.(m3u8|mp4|flv|ts|m4s|mp3|aac)(\?|$)/i.test(url.pathname)||req.resourceType()==='media'||(entry.name.startsWith('production')&&url.pathname.startsWith('/admin'));if(!permitted||forbidden){item.blockedRequests.push(req.url());return route.abort('blockedbyclient');}return route.continue();});
   try{const response=await page.goto(entry.url,{waitUntil:'networkidle',timeout:30000});item.status=response?.status();await page.waitForTimeout(1500);item.finalUrl=page.url();item.title=await page.title();item.bodyText=(await page.locator('body').innerText()).slice(0,10000);item.screenshot=entry.name+'.png';await page.screenshot({path:path.join(out,item.screenshot),fullPage:true});item.links=await page.locator('a').evaluateAll(nodes=>nodes.map(a=>({text:a.textContent,href:a.getAttribute('href')})));item.horizontalOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);}catch(error){item.error=error.stack;}
   results.push(item);fs.writeFileSync(path.join(out,'smoke-results.json'),JSON.stringify(results,null,2));await context.close();
  }
 }finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 console.log(JSON.stringify(results.map(({name,status,finalUrl,pageErrors,httpErrors,error})=>({name,status,finalUrl,pageErrors,httpErrors,error})),null,2));
}
run().catch(error=>{console.error(error);process.exitCode=1;});
