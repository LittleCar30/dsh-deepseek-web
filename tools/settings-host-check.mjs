import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { stringify, parse } from 'yaml'
import vm from 'node:vm'
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
 // Run the actual desktop's client ConfigForms too. The previous UI fixture
 // invented `mode: host`, masking the ready+writable snapshot regression.
 const cordis=await import(mod('cordis/lib/index.js'))
 const ctx=new cordis.Context()
 let allowWrites=true
 let client
 const events=new Map()
 const snapshots=[]
 // Snapshot storage and Remote transport are fixtures; all form derivation,
 // schema decoding, write ordering and recovery run the shipped client code.
 const createSnapshotStore=initial=>{
  let state=initial
  const listeners=new Set()
  return {getSnapshot:()=>state,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},
   set(value){state=value;for(const fn of listeners)fn()},
   update(fn){const next=structuredClone(state);fn(next);this.set(next)}}
 }
 const remote={
  $on(name,fn){events.set(name,fn);return()=>events.delete(name)},
  settings:{
   async describe(){return {ok:true,value:{writable:allowWrites,hasDocument:true,namespaces:settings.describe()}}},
   async mutate(ns,ops,revision){
    if(!allowWrites)return {ok:false,error:{message:'Read only'}}
    try{await settings.mutate(ns,ops,revision);return {ok:true,value:settings.describe().find(v=>v.ns===ns)}}
    catch(error){return {ok:false,error:{message:error.message}}}
   },
  },
 }
 ctx.provide('remote',remote)
 try{
  vm.runInNewContext(await readFile(path.join(hostRoot,'node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js'),'utf8'),{
   structuredClone,window:{__ModuleLoader__:{load(value){client=value.factory(name=>{
    if(name==='@deepseek-ai/cordis')return cordis
    if(name==='@deepseek-ai/dsh-client-store')return {createSnapshotStore}
    throw Error('Unexpected client import '+name)
   })}}},
  })
  client.apply(ctx)
  await ctx.fiber.await()
  const form=ctx.configForms.get(options.id)
  await ctx.configForms.describe().load()
  const ready=form.getSnapshot()
  assert.equal(ready.status,'ready');assert.equal(ready.writable,true)
  assert.equal(Object.hasOwn(ready,'mode'),false,'new desktop has no mode field')
  snapshots.push(ready)
  assert.equal(await form.mutate([{op:'set',path:['sendMode'],value:'auto'}],ready.revision),true)
  assert.equal(form.getSnapshot().value.sendMode,'auto')
  assert.equal(parse(await readFile(file,'utf8'))[0].config.sendMode,'auto')
  assert.equal(fiber.effectiveConfig.sendMode.get(),'auto','client write updates actual host live ref')
  assert.equal(await form.mutate([{op:'set',path:['sendMode'],value:'manual'}],ready.revision),false,'stale revision refused')
  assert.equal(form.getSnapshot().value.sendMode,'auto')
  assert.equal(await form.mutate([{op:'set',path:['rateLimit','maxRetries'],value:-1}],form.getSnapshot().revision),false)
  assert.equal(form.getSnapshot().value.rateLimit.maxRetries,5)
  allowWrites=false;await ctx.configForms.describe().load()
  assert.equal(form.getSnapshot().status,'ready');assert.equal(form.getSnapshot().writable,false)
  snapshots.push(form.getSnapshot())
  assert.equal(await form.mutate([{op:'set',path:['sendMode'],value:'manual'}],form.getSnapshot().revision),false)
  assert.equal(form.getSnapshot().value.sendMode,'auto')
  // Optional output for a browser harness using the real controller's shape.
  if(process.argv[3])await writeFile(path.resolve(process.argv[3]),JSON.stringify(snapshots,null,2))
  console.log('OK: actual DSH client ConfigForms ready+writable without mode; client → host → YAML/live refs, conflict recovery, invalid input and read-only refusal (storage/transport/editor fixtures)')
 }finally{await ctx.fiber.dispose()}
 console.log('OK: actual DSH '+JSON.parse(await readFile(path.join(hostRoot,'node_modules/@deepseek-ai/dsh-settings/package.json'),'utf8')).version+' SettingsForms schema projection, YAML roundtrip, live refs, conflict refusal, invalid-number rejection, reset/inherited values; profile I/O uses isolated test editor')
}finally{await rm(temp,{recursive:true,force:true})}
