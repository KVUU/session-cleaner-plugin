window.__ModuleLoader__.load({
  id: '@local/session-cleaner',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'local.sessionCleaner';
    const en = {
      open:'Session cleanup', remove:'Delete permanently…', title:'Sessions & groups', sessions:'Sessions', groups:'Groups',
      close:'Close', search:'Search title or path', preview:'Review deletion', back:'Back', confirm:'Delete permanently',
      checking:'Preparing file list…', deleting:'Deleting…', empty:'No matching items', untitled:'Untitled', running:'Running',
      intro:'Delete a session or a whole group, with its local logs and attributable generated files.',
      detail:'This permanently removes the sessions and files listed below. Existing workspace files and shared files stay in place.',
      files:'Files and directories', count:'Sessions', warnings:'Retained files / coverage notes', blocked:'Stop these activities first',
      done:'Deletion completed', partial:'Deletion partially completed', refresh:'Refresh sidebar', reloadHint:'Refresh to clear any open conversation and reload the session list.',
      groupHint:'Includes every session in this group. The workspace directory and its existing files stay in place.',
      noFiles:'No associated local files found', retry:'Retry', cancel:'Cancel', generated:'Generated file', cache:'Cache',
      'session-data':'Session data', groupsCount:'sessions', error:'Operation failed', missing:'This item is no longer available.'
    };
    const zh = {
      open:'会话清理', remove:'彻底删除…', title:'会话与分组清理', sessions:'会话', groups:'分组',
      close:'关闭', search:'搜索标题或路径', preview:'查看删除清单', back:'返回', confirm:'彻底删除',
      checking:'正在核对关联文件…', deleting:'正在删除…', empty:'没有匹配的项目', untitled:'未命名会话', running:'运行中',
      intro:'删除单个会话或整个分组，同时清理对应本地日志和可确认归属的生成文件。',
      detail:'将永久删除下列会话及文件。工作目录中的原有文件和共享文件会保留。',
      files:'文件与目录', count:'会话数', warnings:'保留文件与追踪说明', blocked:'请先停止以下活动',
      done:'删除完成', partial:'部分删除已完成', refresh:'刷新左侧列表', reloadHint:'刷新页面可清除已打开的旧会话并重新加载列表。',
      groupHint:'包括这个分组中的全部会话。工作区目录及其中原有文件会保留。',
      noFiles:'未发现关联本地文件', retry:'重试', cancel:'取消', generated:'生成文件', cache:'缓存',
      'session-data':'会话数据', groupsCount:'个会话', error:'操作失败', missing:'此项目已不存在。'
    };
    const css = `
.sc-cleaner-trigger{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-width:32px;height:32px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:13px;padding:5px 8px}
.sc-cleaner-trigger:hover,.sc-cleaner-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.sc-cleaner-menu{display:flex;align-items:center;gap:8px;width:100%;border:0;border-top:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-state-error-primary);padding:10px 12px;text-align:left;font:inherit;font-size:13px;cursor:pointer}
.sc-cleaner-menu:hover{background:var(--dsw-alias-bg-layer-2)}
.sc-cleaner-shade{position:fixed;inset:0;z-index:1300;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:auto;background:color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent)}
.sc-cleaner-dialog{display:flex;flex-direction:column;width:min(780px,100%);max-height:85vh;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 12px 60px color-mix(in srgb,var(--dsw-alias-label-primary) 15%,transparent);font-size:14px;line-height:1.6}
.sc-cleaner-head,.sc-cleaner-foot{display:flex;align-items:center;gap:12px;justify-content:space-between;padding:18px 24px;flex-shrink:0}
.sc-cleaner-head{border-bottom:1px solid var(--dsw-alias-border-l1)}
.sc-cleaner-head h2{font-size:18px;font-weight:600;margin:0}.sc-cleaner-body{padding:18px 24px;overflow:auto;min-height:100px}.sc-cleaner-body p{margin:0 0 14px;color:var(--dsw-alias-label-secondary)}
.sc-cleaner-btn{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 13px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.sc-cleaner-btn:disabled{opacity:.45;cursor:default}.sc-cleaner-btn:focus-visible,.sc-cleaner-menu:focus-visible,.sc-cleaner-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.sc-cleaner-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.sc-cleaner-tabs{display:flex;gap:8px;margin-bottom:14px}.sc-cleaner-tab[aria-selected=true]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.sc-cleaner-search{box-sizing:border-box;width:100%;margin-bottom:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:9px 12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}
.sc-cleaner-row{display:flex;align-items:center;gap:12px;justify-content:space-between;padding:13px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sc-cleaner-name{font-weight:500;overflow-wrap:anywhere}.sc-cleaner-meta{font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.sc-cleaner-file{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;overflow-wrap:anywhere}.sc-cleaner-filelist{max-height:30vh;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}
.sc-cleaner-alert{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;margin:12px 0;background:var(--dsw-alias-bg-layer-2);white-space:pre-wrap;overflow-wrap:anywhere}.sc-cleaner-error{color:var(--dsw-alias-state-error-primary)}.sc-cleaner-success{color:var(--dsw-alias-state-success-primary)}
.sc-cleaner-body h3{font-size:14px;margin:14px 0 8px}.sc-cleaner-foot{border-top:1px solid var(--dsw-alias-border-l1);justify-content:flex-end}
@media(max-width:600px){.sc-cleaner-shade{padding:10px}.sc-cleaner-body,.sc-cleaner-head,.sc-cleaner-foot{padding:14px}.sc-cleaner-dialog{max-height:92vh}}
`;
    function Trash() {
      return h('svg',{width:16,height:16,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,'aria-hidden':true},
        h('path',{d:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7'}));
    }
    let current = null;
    const listeners = new Set();
    const subscribe = fn => {listeners.add(fn);return()=>listeners.delete(fn);};
    const publish = next => {current=next;for(const fn of listeners)fn();};
    const bytes = n => n>1048576 ? `${(n/1048576).toFixed(1)} MB` : n>1024 ? `${(n/1024).toFixed(1)} KB` : `${n||0} B`;
    async function api(action, input={}) {
      const response = await fetch('/api/local-session-cleaner', {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Session-Cleaner':'1'},body:JSON.stringify({action,...input})});
      const value = await response.json();
      if(!response.ok || value.error){const error=new Error(value.error || `${response.status}`);error.partial=value.partial;throw error;}
      return value;
    }
    return {
      inject:['slots','locale'],
      apply(ctx) {
        ctx.effect(()=>ctx.locale.register(NS,{en,zh}));
        ctx.effect(()=>()=>{publish(null);listeners.clear();});
        const t=ctx.locale.bind(NS);
        function useText(){React.useSyncExternalStore(fn=>ctx.locale.subscribe(fn),()=>ctx.locale.getSnapshot());return t;}
        function Footer({wide}) {
          const t=useText();
          return h('button',{className:'sc-cleaner-trigger',title:t('open'),'aria-label':t('open'),onClick:()=>publish({})},h('style',null,css),h(Trash),wide?h('span',null,t('open')):null);
        }
        function Menu({sessionId,displayTitle,useMenuOpenState}) {
          const t=useText();const [,setOpen]=useMenuOpenState();
          return h('button',{role:'menuitem',className:'sc-cleaner-menu',onClick:()=>{setOpen(false);publish({kind:'session',id:sessionId,title:displayTitle});}},h('style',null,css),h(Trash),t('remove'));
        }
        function Overlay(){const state=React.useSyncExternalStore(subscribe,()=>current);return state?h(Dialog,{key:state.id||'manager',target:state}):null;}
        function Dialog({target}) {
          const t=useText();const [catalog,setCatalog]=React.useState(null);const [tab,setTab]=React.useState('sessions');
          const [query,setQuery]=React.useState('');const [plan,setPlan]=React.useState(null);const [busy,setBusy]=React.useState(false);
          const [error,setError]=React.useState('');const [done,setDone]=React.useState(null);const ref=React.useRef(null);
          const close=()=>{if(!busy)publish(null);};
          const review=async item=>{setBusy(true);setError('');try{setPlan(await api('preview',item));}catch(e){setError(e.message);}finally{setBusy(false);}};
          React.useEffect(()=>{let active=true;api('list').then(data=>{if(active)setCatalog(data);}).catch(e=>{if(active)setError(e.message);});if(target.id)review(target);return()=>{active=false;};},[]);
          React.useEffect(()=>{const previous=document.activeElement;ref.current?.focus();return()=>previous?.isConnected&&previous.focus();},[]);
          const remove=async()=>{setBusy(true);setError('');try{setDone(await api('delete',{token:plan.token}));}catch(e){if(e.partial?.deletedSessionIds?.length)setDone({...e.partial,partial:true});setError(e.message);}finally{setBusy(false);}};
          const trap=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}if(e.key==='Tab'){const nodes=[...ref.current.querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex="0"]')];const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement===ref.current)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};
          const items=catalog?(tab==='groups'?catalog.workspaces:catalog.sessions.filter(s=>s.origin!=='subagent')):[];
          const filtered=items.filter(s=>`${s.title||''} ${s.cwd||s.path||''} ${s.id}`.toLowerCase().includes(query.toLowerCase()));
          let body;
          if(done)body=h(React.Fragment,null,h('h3',{className:'sc-cleaner-success'},t(done.partial?'partial':'done')),h('p',null,`${t('count')}: ${done.deletedSessionIds?.length||0} · ${t('files')}: ${done.deletedFiles?.length||0}`),...(done.warnings||[]).map((w,i)=>h('div',{className:'sc-cleaner-alert',key:i},String(w))),h('p',null,t('reloadHint')));
          else if(plan)body=h(React.Fragment,null,h('div',{className:'sc-cleaner-name'},plan.title||target.title),h('p',null,t('detail')),h('p',null,`${t('count')}: ${plan.sessionIds.length}`),plan.blocked?.length?h('div',{className:'sc-cleaner-alert sc-cleaner-error'},t('blocked'),...plan.blocked.map((b,i)=>h('div',{key:i},typeof b==='string'?b:JSON.stringify(b)))):null,h('h3',null,`${t('files')} (${plan.files.length})`),h('div',{className:'sc-cleaner-filelist'},plan.files.length?plan.files.map((file,i)=>h('div',{className:'sc-cleaner-file',key:i},h('div',null,file.path),h('div',{className:'sc-cleaner-meta'},`${t(file.kind)||file.kind} · ${bytes(file.bytes)}`))):h('div',{className:'sc-cleaner-file'},t('noFiles'))),plan.warnings?.length?h('details',{className:'sc-cleaner-alert'},h('summary',null,t('warnings')),...plan.warnings.map((w,i)=>h('div',{key:i},typeof w==='string'?w:JSON.stringify(w)))):null);
          else body=h(React.Fragment,null,h('p',null,t('intro')),h('div',{className:'sc-cleaner-tabs',role:'tablist'},...['sessions','groups'].map(value=>h('button',{role:'tab','aria-selected':tab===value,className:'sc-cleaner-btn sc-cleaner-tab',key:value,onClick:()=>setTab(value)},t(value)))),h('input',{className:'sc-cleaner-search',placeholder:t('search'),'aria-label':t('search'),value:query,onChange:e=>setQuery(e.target.value)}),tab==='groups'?h('p',null,t('groupHint')):null,!catalog?h('p',null,t('checking')):filtered.length?filtered.map(item=>h('div',{className:'sc-cleaner-row',key:item.id},h('div',null,h('div',{className:'sc-cleaner-name'},item.title||t('untitled')),h('div',{className:'sc-cleaner-meta'},item.cwd||item.path||item.id),h('div',{className:'sc-cleaner-meta'},tab==='groups'?`${item.sessionIds.length} ${t('groupsCount')}`:item.running?t('running'):'')),h('button',{className:'sc-cleaner-btn',disabled:busy,onClick:()=>review({kind:tab==='groups'?'workspace':'session',id:item.id})},t('preview')))):h('p',null,t('empty')));
          return h('div',{className:'sc-cleaner-shade',onMouseDown:e=>{if(e.target===e.currentTarget)close();}},h('style',null,css),h('section',{ref,role:'dialog','aria-modal':true,'aria-labelledby':'sc-cleaner-title',tabIndex:-1,className:'sc-cleaner-dialog',onKeyDown:trap},h('header',{className:'sc-cleaner-head'},h('h2',{id:'sc-cleaner-title'},t('title')),h('button',{className:'sc-cleaner-btn',disabled:busy,'aria-label':t('close'),onClick:close},'×')),h('div',{className:'sc-cleaner-body'},body,error?h('div',{role:'alert',className:'sc-cleaner-alert sc-cleaner-error'},error):null,busy?h('p',{role:'status'},t(plan?'deleting':'checking')):null),h('footer',{className:'sc-cleaner-foot'},done?h('button',{className:'sc-cleaner-btn',onClick:()=>location.reload()},t('refresh')):plan?h(React.Fragment,null,h('button',{className:'sc-cleaner-btn',disabled:busy,onClick:()=>{setPlan(null);setError('');}},t('back')),h('button',{className:'sc-cleaner-btn sc-cleaner-danger',disabled:busy||!!plan.blocked?.length,onClick:remove},t('confirm'))):null,h('button',{className:'sc-cleaner-btn',disabled:busy,onClick:close},t('close')))));
        }
        ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:'local.session-cleaner',order:20},Footer));
        ctx.slots.inject('sidebar.workspaces.session.menu.item',()=>ctx.slots.register({name:'sidebar.workspaces.session.menu.item',id:'local.session-cleaner.delete',order:600},Menu));
        ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:'local.session-cleaner.dialog',order:100},Overlay));
      }
    };
  }
});
