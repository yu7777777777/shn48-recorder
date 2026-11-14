const express=require('/app/server/node_modules/express');
const {chromium}=require('/app/server/node_modules/playwright');
const assert=require('assert/strict');
(async()=>{
 const app=express();app.use(express.static('/build/client/dist'));app.get('*',(_req,res)=>res.sendFile('/build/client/dist/index.html'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium'});let total=0;
 try{
  for(const width of [320,360,390,420,430,768,1440])for(const pathname of ['/','/daily']){
   const page=await browser.newPage({viewport:{width,height:900},locale:'zh-CN'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/api/**',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data:route.request().url().includes('/daily')?{published:false,days:[]}:[]})}));
   await page.goto('http://127.0.0.1:'+server.address().port+pathname);await page.waitForTimeout(250);
   assert.equal(errors.length,0,errors.join('\n'));
   const size=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(size.scroll<=width,JSON.stringify(size));
   const nav=page.getByRole('navigation',{name:'公开内容分类'});await nav.getByRole('link',{name:'总结日报'}).waitFor();
   assert.equal(await nav.getByRole('link').count(),3);total++;await page.close();
  }
  console.log('PASS_PUBLIC_NAV_LAYOUT_SCENARIOS='+total);
 }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e.message);process.exitCode=1});
