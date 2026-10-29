import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactTracker } from './artifacts.js';
import { SessionCleaner } from './backend.js';
import { verifyLive } from './verify-live.js';

export const inject = ['connection','tools','agents','agentLoop','sessions','sessionPersistence','sessionQuery','workspaceRegistry','workingDirectory','storageDomain'];
const PARAMS = {
  type:'object', properties:{
    action:{type:'string',enum:['list','preview','delete'],description:'list 列出会话与分组；preview 返回删除清单及短期 token；delete 永久删除清单中的会话和关联本地文件。'},
    kind:{type:'string',enum:['session','workspace'],description:'preview 时选择单个会话或整个分组。'},
    id:{type:'string',description:'preview 时填写 list 返回的会话或分组 id。'},
    token:{type:'string',description:'delete 时填写最近一次 preview 返回的 token；清单发生变化后重新预览。'}
  }, required:['action'], additionalProperties:false
};
export async function apply(ctx) {
  const root = ctx.sessionPersistence.root;
  if(typeof root !== 'string') throw new Error('会话清理需要当前 JSONL 本地持久化后端。');
  const packageRoot = dirname(fileURLToPath(import.meta.url));
  const stateDir = join(dirname(resolve(root)), 'session-cleaner-state');
  await mkdir(stateDir, {recursive:true});
  const tracker = new ArtifactTracker({stateDir:join(stateDir,'artifacts'),protectedRoots:[packageRoot,process.env.DSH_HOME,process.resourcesPath].filter(Boolean)});
  const cleaner = new SessionCleaner(ctx,{stateDir,tracker});
  let chain = Promise.resolve();
  const enqueue = fn => {
    const job=chain.then(fn);
    chain=job.catch(error=>ctx.logger.warn(`session-cleaner tracking: ${error.message}`));
    return job;
  };
  const cwdOf = exec => exec.agent?.session ? ctx.workingDirectory.get(exec.agent.session) : undefined;
  ctx.on('tools/pre-execute', async (exec,next)=>{
    const decision=await next();
    if(decision.kind==='allow' && exec.agent) {
      const cwd=cwdOf(exec);
      if(cwd) await enqueue(()=>tracker.before(exec,cwd));
    }
    return decision;
  });
  ctx.on('tools/result',(exec,result)=>{
    if(!exec.agent)return;
    const cwd=cwdOf(exec);
    if(cwd) void enqueue(()=>tracker.after(exec,result,cwd)).catch(()=>{});
  });
  async function operation(input,callerSessionId) {
    await chain;
    if(!input||typeof input!=='object')throw new Error('缺少操作参数。');
    if(input.action==='list')return cleaner.catalog();
    if(input.action==='preview')return cleaner.preview(input);
    if(input.action==='delete')return cleaner.remove(input,callerSessionId);
    throw new Error('未知清理操作。');
  }
  const releaseRoute=await ctx.connection.fetch.register({
    path:'/api/local-session-cleaner', methods:['POST'], requestBody:'buffered',
    async fetch(request) {
      try {
        if(request.headers.get('X-Session-Cleaner')!=='1')return Response.json({error:'缺少客户端操作标识。'},{status:400});
        const text=await request.text();
        if(text.length>65536)return Response.json({error:'请求过大。'},{status:413});
        return Response.json(await operation(JSON.parse(text)),{headers:{'Cache-Control':'no-store'}});
      }catch(error){return Response.json({error:error.message||String(error),...(error.partial?{partial:error.partial}:{})},{status:409,headers:{'Cache-Control':'no-store'}});}
    }
  });
  ctx.effect(()=>releaseRoute);
  ctx.effect(()=>ctx.tools.register({
    name:'session_cleanup',
    description:'列出、预览并永久删除会话或工作区分组，同时清理对应本地日志、缓存及明确归属的生成文件。删除前先 preview；只对用户指定的目标执行 delete。',
    parameters:PARAMS,
    output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value,null,2)}]},
    async execute(args,exec){return operation(args,exec.agent?.id);},
    isConcurrencySafe:args=>args?.action==='list',
    presentCall:args=>({card:'generic',title:`会话清理 · ${args.action}`,kind:args.action==='delete'?'delete':'read',rawInput:args})
  }));
  ctx.effect(()=>async()=>{await chain;});
  const verification={at:new Date().toISOString(),route:'/api/local-session-cleaner',stateDir};
  try {
    const catalog=await cleaner.catalog();
    verification.sessionCount=catalog.sessions.length;
    verification.workspaceCount=catalog.workspaces.length;
    const sample=catalog.sessions.find(item=>!item.running&&item.origin!=='subagent')||catalog.sessions[0];
    if(sample){
      const preview=await cleaner.preview({kind:'session',id:sample.id});
      verification.preview={id:sample.id,sessionCount:preview.sessionIds.length,fileCount:preview.files.length,blocked:preview.blocked,warnings:preview.warnings};
    }
  }catch(error){verification.error=error.message||String(error);}
  const verifyFile=join(stateDir,'live-verification-v1.json');
  let existingVerification;
  try{existingVerification=JSON.parse(await readFile(verifyFile,'utf8'));}catch{}
  if(existingVerification?.passed)verification.liveTest=existingVerification;
  else {
    verification.liveTest=await verifyLive(ctx,tracker);
    await writeFile(verifyFile,JSON.stringify(verification.liveTest,null,2),'utf8');
  }
  await writeFile(join(stateDir,'runtime-check.json'),JSON.stringify(verification,null,2),'utf8');
}
