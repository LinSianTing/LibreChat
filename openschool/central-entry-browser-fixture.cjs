/** Isolated synthetic browser fixture, NOT a deployed auth server or OIDC acceptance. */
const express = require('express');
const session = require('express-session');
const ts=require('typescript');
const fs=require('node:fs');
const Module=require('node:module');
const gateModule=new Module('/app/entry-fixture.cjs');
gateModule._compile(ts.transpileModule(fs.readFileSync('/app/packages/api/src/openschool/entry.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,'/app/entry-fixture.cjs');
const { createCentralEntry }=gateModule.exports;
const app=express();app.disable('x-powered-by');app.use(express.json());
app.use(session({secret:'synthetic-browser-only-not-a-credential',resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax'}}));
app.get('/api/config',(_req,res)=>res.json({appTitle:'Synthetic central entry',centralLogoutEnabled:true,openidLoginEnabled:true,openidAutoRedirect:false,openidLabel:'Synthetic central account',emailLoginEnabled:false,registrationEnabled:false,socialLoginEnabled:true,socialLogins:['openid'],serverDomain:'http://127.0.0.1:15325',interface:{},modelSpecs:{list:[]}}));
app.post('/api/auth/refresh',(_req,res)=>res.status(401).json({message:'Synthetic unauthenticated browser'}));
app.get('/api/user',(_req,res)=>res.status(401).json({message:'Synthetic unauthenticated browser'}));
app.post('/api/auth/central-entry',createCentralEntry({enabled:()=>true}));
app.get('/oauth/openid',(_req,res)=>res.type('html').send('<h1>Synthetic OIDC boundary</h1><p>Navigation reached. No real authentication performed.</p>'));
app.get('/api/auth/central-logout',(_req,res)=>res.type('html').send('<h1>Synthetic recovery boundary</h1>'));
app.use('/api',(_req,res)=>res.json([]));
app.use(express.static('/app/client/dist'));
app.get(/.*/,(_req,res)=>res.sendFile('/app/client/dist/index.html'));
app.listen(3080,'0.0.0.0',()=>console.log('SYNTHETIC_BROWSER_FIXTURE_ONLY'));


