import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stringify, parse } from 'yaml'
const hostRoot=path.resolve(process.argv[2]??'.runtime/compat-20261109/host/dsh')
const mod=name=>pathToFileURL(path.join(hostRoot,'node_modules/@deepseek-ai',name)).href
const { SettingsForms }=await import(mod('dsh-settings/lib/types/index.js'))
const { volatileForm, isVolatilePath }=await import(mod('dsh-settings/lib/types/schema.js'))
const { resolveConfig }=await import(mod('cordis/lib/index.js'))
const { volatileEntries,updateVolatile }=await import(mod('cosmokit/lib/index.js'))
const bundleDir=path.join(hostRoot,'web-plugin-test')
await mkdir(bundleDir,{recursive:true})
await copyFile(path.resolve('lib/index.js'),path.join(bundleDir,'index.mjs'))
const runtime=await import(pathToFileURL(path.join(bundleDir,'index.mjs')).href+'?'+Date.now())
const { Config }=runtime
const temp=await mkdtemp(path.join(os.tmpdir(),'dsh-settings-host-'))
try{
 const file=path.join(temp,'cordis.patch.yml')
 const inherited={rateLimit:{enabled:true,maxRetries:5},review:{enabled:false}}
 const raw={selectors:{editor:'textarea'},streamIdleTimeoutMs:123456,liveThinking:false}
 const options={id:'llm-deepseek-web',config:raw}
 const fiber={runtime,state:2,uid:1,ctx:{},effectiveConfig:resolveConfig(runtime,raw)}
 fiber.ctx.fiber=fiber
 const entry={id:1,options,fiber}
 const settings=Object.create(SettingsForms.prototype)
 settings.revisions=new Map();settings.presentations=new Map()
 const merge=(a,b)=>Object.fromEntries([...new Set([...Object.keys(a),...Object.keys(b)])].map(k=>[k,b[k]===undefined?a[k]:(a[k]&&b[k]&&typeof a[k]==='object'&&typeof b[k]==='object'&&!Array.isArray(a[k])&&!Array.isArray(b[k])?merge(a[k],b[k]):b[k])]))
 settings.ownerContext={emit(){},configEditor:{
  entries:()=>[entry],configuration:()=>[{entry,inherited,override:options.config}],
  async edit(target,change){
   const next=change(options.config,inherited)
   const parsed=resolveConfig(runtime,merge(inherited,next))
   await writeFile(file,stringify([{id:options.id,config:next}]))
   for(const {path:keys,ref} of volatileEntries(fiber.effectiveConfig)){
    const source=keys.reduce((v,k)=>v[k],parsed);updateVolatile(ref,source)
   }
   options.config=next
  }
 }}
 const form=volatileForm(Config)
 for(const key of ['browser','channel','profileDir','toolAllowlist'])assert.ok(isVolatilePath(Config,[key]),key+' must be editable')
 assert.equal(form.dict.channel.type,'union')
 const initial=settings.describe()[0]
 assert.deepEqual(initial.value.toolAllowlist,[])
 await settings.mutate(options.id,[
  {op:'set',path:['browser'],value:'attach'},
  {op:'set',path:['channel'],value:'chrome'},
  {op:'set',path:['profileDir'],value:'D:/Profiles/测试'},
  {op:'set',path:['rateLimit','maxRetries'],value:7},
  {op:'set',path:['liveThinking'],value:true},
  {op:'set',path:['toolAllowlist'],value:['apply_patch','mcp__test__*']},
 ],initial.revision)
 const saved=settings.describe()[0]
 assert.equal(saved.value.browser,'attach');assert.equal(saved.value.channel,'chrome')
 assert.equal(saved.value.profileDir,'D:/Profiles/测试');assert.equal(saved.value.rateLimit.maxRetries,7)
 assert.equal(saved.value.liveThinking,true);assert.deepEqual(saved.value.toolAllowlist,['apply_patch','mcp__test__*'])
 assert.equal(options.config.streamIdleTimeoutMs,123456);assert.deepEqual(options.config.selectors,{editor:'textarea'})
 assert.equal(fiber.effectiveConfig.liveThinking.get(),true,'actual runtime volatile reference updated')
 assert.equal(parse(await readFile(file,'utf8'))[0].config.channel,'chrome')
 await assert.rejects(()=>settings.mutate(options.id,[{op:'set',path:['liveThinking'],value:false}],initial.revision),/changed since it was read/)
 await assert.rejects(()=>settings.mutate(options.id,[{op:'set',path:['rateLimit','maxRetries'],value:-1}],saved.revision))
 assert.equal(settings.describe()[0].value.rateLimit.maxRetries,7)
 await assert.rejects(()=>settings.mutate(options.id,[{op:'set',path:['stateFile'],value:'other'}],saved.revision),/not volatile/)
 await settings.mutate(options.id,[{op:'unset',path:['profileDir']}],saved.revision)
 assert.equal(settings.describe()[0].value.profileDir,undefined)
 const latest=settings.describe()[0]
 await settings.mutate(options.id,[{op:'unset',path:['rateLimit','maxRetries']}],latest.revision)
 assert.equal(settings.describe()[0].value.rateLimit.maxRetries,5)
 console.log('OK: actual DSH '+JSON.parse(await readFile(path.join(hostRoot,'node_modules/@deepseek-ai/dsh-settings/package.json'),'utf8')).version+' SettingsForms schema projection, YAML roundtrip, live refs, conflict refusal, invalid-number rejection, reset/inherited values; profile I/O uses isolated test editor')
}finally{await rm(temp,{recursive:true,force:true})}
