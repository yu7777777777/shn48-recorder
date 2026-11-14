const {chromium}=require('/app/server/node_modules/playwright');
const launch=chromium.launch.bind(chromium);
chromium.launch=async options=>{
 const browser=await launch({...options,executablePath:'/usr/bin/chromium'});
 const newPage=browser.newPage.bind(browser),newContext=browser.newContext.bind(browser);
 browser.newPage=options=>newPage({locale:'zh-CN',...options});
 browser.newContext=options=>newContext({locale:'zh-CN',...options});
 return browser;
};
