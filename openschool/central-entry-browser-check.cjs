// Uses only loopback synthetic fixture. OIDC navigation is a boundary, not an authenticated session.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/USER/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
const base='http://127.0.0.1:15325';const out=process.argv[2];if(!out)throw Error('Evidence directory required');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/chrome-win/chrome.exe',headless:true});const results=[];
 async function run(name,{delay=0,deny=false,network=false,path='/c/new?model=circle-light',click=false,leave=false,cookie=false}={}){
 const ctx=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});await ctx.route('**/*',r=>new URL(r.request().url()).origin===base?r.fallback():r.abort());const page=await ctx.newPage();let gates=0,navs=0,gateStart=null,gateEnd=null,navigation=null;
 if(cookie)await ctx.addCookies([{name:'refreshToken',value:'synthetic-stale',url:base}]);
 await page.route('**/api/auth/central-entry',async route=>{gates++;gateStart=performance.now();if(delay)await new Promise(r=>setTimeout(r,delay));if(network){await route.abort();return;}if(deny){await route.fulfill({status:409,contentType:'application/json',body:'{"allowed":false}'});gateEnd=performance.now();return;}const r=await route.fetch();assert(!r.headers()['set-cookie'],'gate must not emit cookie');gateEnd=performance.now();await route.fulfill({response:r});});
 page.on('request',r=>{if(new URL(r.url()).pathname==='/oauth/openid'){navs++;navigation=performance.now();}});
 const pending=(click||leave||name==='slow')?page.waitForRequest('**/api/auth/central-entry'):null;
 const start=performance.now();await page.goto(base+path,{waitUntil:'domcontentloaded'});
 if(click||leave||name==='slow'){await pending;}
 if(name==='slow'){await page.getByRole('status').filter({hasText:/接續|Continuing/}).waitFor();assert.equal(await page.locator('details:has(a[href="/api/auth/central-logout"])').getAttribute('open'),null);await page.screenshot({path:out+'/pending-390.png',fullPage:true});}
 if(click){await page.locator('details:has(a[href="/api/auth/central-logout"]) > summary').click();assert.equal(await page.getByRole('status').filter({hasText:/接續|Continuing/}).count(),0);await page.locator('a[href="/api/auth/central-logout"]').click();}
 if(leave)await page.goto(base+'/login?redirect=false');
 if(!deny&&!network&&!click&&!leave&&!cookie&&!path.includes('error=')&&!path.includes('redirect=false'))await page.waitForURL('**/oauth/openid',{timeout:15000});
 else await page.waitForTimeout(delay+1000);
 const automatic=!(deny||network||click||leave||cookie||path.includes('error=')||path.includes('redirect=false'));
 assert.equal(navs,automatic?1:0,name+' navigation count');assert.equal(gates,(path.includes('error=')||path.includes('redirect=false'))?0:1,name+' gate count');
 if(name==='slow'){await page.goto(base+'/c/new?model=circle-light');await page.waitForTimeout(1000);assert.equal(gates,1,'same tab must not retry');assert.equal(navs,1);}
 if(name==='error'||name==='explicit-manual'){assert(await page.locator('details:has(a[href="/api/auth/central-logout"])').getAttribute('open')!==null);}
 if(name==='deny'){assert.equal(await page.locator('details:has(a[href="/api/auth/central-logout"])').getAttribute('open'),null);await page.screenshot({path:out+'/manual-recovery-390.png',fullPage:true});}
 const row={name,gates,navs,elapsedToNavigationMs:navigation?Math.round(navigation-start):null,gateMs:gateEnd&&gateStart?Math.round(gateEnd-gateStart):null,finalPath:new URL(page.url()).pathname};results.push(row);await ctx.close();
 }
 for(const [name,opts]of [['first',{}],['slow',{delay:1000}],['manual-during-pending',{delay:1000,click:true}],['leave-during-pending',{delay:1000,leave:true}],['deny',{deny:true}],['network',{network:true}],['error',{path:'/login?error=AUTH_FAILED&redirect_to=%2Fc%2Fnew'}],['explicit-manual',{path:'/login?redirect=false&redirect_to=%2Fc%2Fnew'}],['stale-cookie',{cookie:true}]])await run(name,opts);
 // Separate samples: new isolated contexts mean cold browser cache. No real provider latency.
 for(let i=0;i<5;i++)await run('cold-'+i);
 fs.writeFileSync(out+'/results.json',JSON.stringify({candidate:process.env.CHAT_SOURCE || 'uncommitted-recovery-presentation-on-431c96f8',createdAt:new Date().toISOString(),browser:browser.version(),limits:'Synthetic startup/auth refresh and OIDC boundary. Actual bundled React and central-entry gate; no real identity/session callback or load capacity claim.',results},null,2));console.log(JSON.stringify(results));await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
