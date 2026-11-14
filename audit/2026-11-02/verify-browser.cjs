const {chromium}=require('../../app/server/node_modules/playwright');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
(async()=>{
 const out=path.join(__dirname,'production-1.32.0');fs.mkdirSync(out,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 const results=[];
 try{
  for(const width of [1440,390])for(const [label,url] of [['live','/'],['replays','/replays'],['daily','/daily'],['login','/admin/login']]){
   const page=await browser.newPage({viewport:{width,height:900}});const errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://<SERVER_IP>:3000'+url,{waitUntil:'domcontentloaded',timeout:45000});
   await page.waitForTimeout(3000);
   if(label==='daily')await page.getByText(/总结日报未开放|直播总结日报/).last().waitFor({timeout:35000});
   if(label==='login')await page.locator('input[type="password"]').waitFor({timeout:15000});
   const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,text:document.body.innerText.slice(0,100)}));
   assert.equal(errors.length,0,errors.join('\n'));assert.ok(layout.scroll<=layout.width+1,JSON.stringify(layout));
   await page.screenshot({path:path.join(out,`${label}-${width}.png`),fullPage:true});
   results.push({page:label,width,errors,overflow:false});await page.close();
  }
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({scenarios:results.length,passed:true}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
