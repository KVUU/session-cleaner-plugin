import { mkdtemp, writeFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, dirname, basename, parse } from 'node:path';
import { randomUUID } from 'node:crypto';

const exists=async path=>{try{await lstat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
/** One bounded real-runtime check using only a fresh, owned Session and directory. */
export async function verifyLive(ctx, tracker) {
  const root=await mkdtemp(join(tmpdir(),'dsh-cleaner-verification-'));
  const id=`session-cleaner-test-${randomUUID()}`;
  const report={id,at:new Date().toISOString(),passed:false};
  let handle;
  try {
    const keep=join(root,'existing.txt'),generated=join(root,'generated.txt');
    await writeFile(keep,'pre-existing verification fixture\n','utf8');
    handle=await ctx.agents.create({sessionId:id,meta:{cwd:root}});
    const execution={name:'write',arguments:{file_path:generated,content:'generated verification fixture\n'},callId:`verify-${randomUUID()}`,agent:handle.agent,signal:new AbortController().signal};
    await tracker.before(execution,root);
    await writeFile(generated,execution.arguments.content,'utf8');
    await tracker.after(execution,{isError:false,value:{operation:'create',path:generated,after:execution.arguments.content},content:[]},root);
    await ctx.sessions.flush(handle.agent.session);
    async function call(args) {
      const result=await ctx.tools.execute({name:'session_cleanup',arguments:args,callId:`verify-${randomUUID()}`,signal:new AbortController().signal});
      if(result.isError)throw new Error(result.error.message);
      return result.value;
    }
    const preview=await call({action:'preview',kind:'session',id});
    report.preview={files:preview.files.length,blocked:preview.blocked,warnings:preview.warnings};
    if(preview.blocked.length)throw new Error(preview.blocked.join('\n'));
    if(!preview.files.some(file=>file.path===generated&&file.kind==='generated'))throw new Error('真实运行验证：生成文件未进入清理预览。');
    const deleted=await call({action:'delete',token:preview.token});
    report.deletion={sessions:deleted.deletedSessionIds,files:deleted.deletedFiles,warnings:deleted.warnings};
    if(!deleted.deletedSessionIds.includes(id))throw new Error('真实运行验证：会话删除结果缺少测试会话。');
    if(await ctx.sessionPersistence.stat(id)||ctx.agents.get(id)||ctx.sessions.get(id))throw new Error('真实运行验证：测试会话仍存在。');
    if(await exists(generated))throw new Error('真实运行验证：生成文件仍存在。');
    if(!await exists(keep))throw new Error('真实运行验证：原有文件被清理。');
    report.passed=true;
  }catch(error){report.error=error.message||String(error);}
  finally {
    if(handle)try{await handle.dispose();}catch(error){report.cleanupError=error.message;}
    if(handle&&!ctx.agents.get(id)&&!ctx.sessions.get(id))try {
      if(await ctx.sessionPersistence.stat(id)) {
        const p=ctx.sessionPersistence,location=p.locate(handle.agent.session.header);
        const dir=resolve(dirname(location.path)),base=resolve(p.root),rel=relative(base,dir);
        if(location.kind!=='jsonl'||basename(dir)!==id||!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('Test session cleanup path mismatch');
        let cursor=parse(dir).root;
        for(const part of dir.slice(cursor.length).split(/[\\/]+/).filter(Boolean)){cursor=join(cursor,part);if((await lstat(cursor)).isSymbolicLink())throw new Error('Test session cleanup path contains a link');}
        const claim=await p.open(id,'write');
        try{await rm(dir,{recursive:true,force:false});}finally{await claim.close();}
        p.coldLogMemo?.delete(id);
        for(const workspace of ctx.workspaceRegistry.list())await workspace.detachSession(id);
        await ctx.workspaceRegistry.unarchiveSession(id);await ctx.workspaceRegistry.unpinSession(id);
        ctx.emit('api-session/removed',id);
      }
    }catch(error){report.cleanupError=error.message;}
    // Check the actual absolute owned root immediately before removing fixtures.
    const parent=resolve(tmpdir()),target=resolve(root),rel=relative(parent,target);
    if(!rel||rel.startsWith('..')||isAbsolute(rel)||!rel.startsWith('dsh-cleaner-verification-'))throw new Error('Verification cleanup path mismatch');
    await rm(target,{recursive:true,force:true});
  }
  return report;
}
