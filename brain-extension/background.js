// SAP Cutover Brain — Background Service Worker v1
//
// New: clickAndCapture — for files whose href is empty (SAP uses JS click handlers).
//      Injects a programmatic click on the matching SAP element, SAP's own JS
//      triggers the download, onDeterminingFilename (tab-ID waiter) captures CDN URL.

function isSapDomain(url) {
  try { const h=new URL(url).hostname; return h==='sap.com'||h.endsWith('.sap.com'); }
  catch(e){return false;}
}

// Waiters keyed by chrome.downloads item ID (for fetchAndCapture)
const _dlWaiters = new Map();
// Waiters keyed by tabId (for clickAndCapture — catches next download from that tab)
const _clickWaiters = new Map();

// Passive webRequest cache — enriches DOM-found files only
const sapFileUrlCache = new Map();

chrome.webRequest.onBeforeRequest.addListener(
  details => {
    const url=details.url;
    if(!isSapDomain(url)) return;
    if(!/\.(xlsx?|pdf|pptx?|docx?|zip|xlsm)\b/i.test(url)) return;
    try {
      const raw=decodeURIComponent(url.split('/').pop().split('?')[0]);
      const key=raw.replace(/\.(xlsx?|pdf|pptx?|docx?|zip|xlsm)$/i,'').toLowerCase().replace(/\W+/g,'');
      if(key.length>=4) sapFileUrlCache.set(key,url);
    } catch(e){}
  },
  { urls:['https://*.sap.com/*'] }
);

// Fires BEFORE Chrome writes to disk — capture CDN URL, cancel write
// BDCQ pattern: return true (async suggest), cancel() first, suggest() inside cancel callback.
// This ensures Chrome holds the download paused until cancel completes — no "must be in progress" error.
chrome.downloads.onDeterminingFilename.addListener((item,suggest) => {
  // Case 1: download started by fetchAndCapture (keyed by download ID)
  if(_dlWaiters.has(item.id)){
    const resolve=_dlWaiters.get(item.id);
    _dlWaiters.delete(item.id);
    resolve(item.finalUrl||item.url||'');
    chrome.downloads.cancel(item.id,()=>{
      void chrome.runtime.lastError;
      chrome.downloads.erase({id:item.id},()=>{ void chrome.runtime.lastError; });
      try{suggest({filename:item.filename||'cancelled'});}catch(_){}
    });
    return true;
  }
  // Case 2: download triggered by clickAndCapture
  const matchedTabWaiter = _clickWaiters.has(item.tabId)
    ? item.tabId
    : _clickWaiters.size > 0 ? _clickWaiters.keys().next().value : null;
  if(matchedTabWaiter !== null){
    const resolve=_clickWaiters.get(matchedTabWaiter);
    _clickWaiters.delete(matchedTabWaiter);
    resolve(item.finalUrl||item.url||'');
    chrome.downloads.cancel(item.id,()=>{
      void chrome.runtime.lastError;
      chrome.downloads.erase({id:item.id},()=>{ void chrome.runtime.lastError; });
      try{suggest({filename:item.filename||'cancelled'});}catch(_){}
    });
    return true;
  }
  suggest();
});

// ── Message routing ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
  if(msg.action==='getFileCount'){respond({count:sapFileUrlCache.size});return;}
  handleAsync(msg,sender,respond);
  return true;
});

// Helper: safe base64 encode from ArrayBuffer (chunk size must be divisible by 3)
function toBase64(buffer) {
  const bytes=new Uint8Array(buffer);
  const CHUNK=8190; // 3×2730 — no interior padding in concatenated output
  let b64='';
  for(let i=0;i<bytes.length;i+=CHUNK)
    b64+=btoa(String.fromCharCode.apply(null,bytes.subarray(i,Math.min(i+CHUNK,bytes.length))));
  return b64;
}

async function handleAsync(msg,sender,respond){
  try{ await _handleAsync(msg,sender,respond); }
  catch(err){ try{respond({ok:false,error:'SW error: '+String(err)});}catch(_){} }
}
async function _handleAsync(msg,sender,respond){
  const {action,tabId}=msg;

  // ── scanCutoverFiles ────────────────────────────────────────────────────────
  if(action==='scanCutoverFiles'){
    // Auto-scroll all frames to trigger SAP lazy URL generation — exact BDCQ logic
    await new Promise(resolve=>{
      chrome.scripting.executeScript({
        target:{tabId,allFrames:true},
        func:async()=>{
          const scrollEls=[...document.querySelectorAll('*')].filter(el=>{
            try{
              const s=window.getComputedStyle(el);
              return /auto|scroll/.test(s.overflow+s.overflowY)
                  &&el.scrollHeight>el.clientHeight+80
                  &&el.clientHeight>60;
            }catch(e){return false;}
          }).sort((a,b)=>b.scrollHeight-a.scrollHeight).slice(0,8);

          for(const el of scrollEls){
            const step=Math.max(80,el.clientHeight*0.5);
            for(let y=0;y<=el.scrollHeight;y+=step){
              el.scrollTop=y;
              await new Promise(r=>setTimeout(r,160));
            }
            // Dispatch hover events — SAP uses mouseenter to fetch download tokens
            el.querySelectorAll('a,[role="link"],[data-file],[data-url]').forEach(a=>{
              a.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));
              a.dispatchEvent(new MouseEvent('mouseover', {bubbles:true}));
            });
            el.scrollTop=0;
            await new Promise(r=>setTimeout(r,150));
          }
          for(let y=0;y<=document.body.scrollHeight;y+=window.innerHeight*0.6){
            window.scrollTo(0,y);
            await new Promise(r=>setTimeout(r,140));
          }
          window.scrollTo(0,0);
        },
      },()=>resolve());
      setTimeout(resolve,25000); // cap at 25 s
    });

    chrome.scripting.executeScript({
      target:{tabId,allFrames:true},
      func:async function scan(){
        const FILE_EXT=/\.(xlsx?|pdf|docx?|pptx?|zip)\b/i;
        function cn(s){return(s||'').replace(/\s*\((SAP\s+Partner|SAP\s+Customer|SAP\s+Internal|Public|Partner|Customer)\)\s*$/i,'').replace(/\s+/g,' ').trim();}
        function rh(h){if(!h||/^(javascript:|#)/i.test(h))return'';try{return/^https?:\/\//i.test(h)?h:new URL(h,location.origin).href;}catch(e){return'';}}
        function gext(t,u){const m=(t+' '+u).match(/\.(xlsx?|pdf|docx?|pptx?|zip)/i);return m?m[1].toLowerCase():'';}

        // ── Scope: prefer [role="main"] to avoid scanning the sidebar/search list ──
        // On the SAP Fiori master-detail layout the left panel is the "master"
        // and the right detail panel has role="main". Scanning only the detail
        // panel gives us the 15 files for the selected roadmap, not all 200+.
        const scope=document.querySelector('[role="main"]')||
                    document.querySelector('main')||
                    document.querySelector('.sapMPage')||
                    document.body;

        const files=[],seenN=new Set(),seenU=new Set();
        function add(name,url,access,raw,type){
          const k=name.toLowerCase().replace(/\W/g,'');
          if(!name||name.length<3||seenN.has(k))return;
          if(url&&seenU.has(url))return;
          seenN.add(k);if(url)seenU.add(url);
          files.push({name,url:url||'',access:access||'Unknown',ext:gext(raw||name,url||''),noUrl:!url,type:type||'document'});
        }

        // Strategy 1A: "Files" heading walk
        Array.from(scope.querySelectorAll('*')).filter(el=>{
          if(el.children.length>2)return false;
          const t=(el.textContent||'').trim();return t==='Files'||t==='Files:';
        }).forEach(h=>{
          let n=h;for(let i=0;i<8;i++){
            if(!n.parentElement)break;n=n.parentElement;
            const ls=n.querySelectorAll('a');
            if(ls.length>0){ls.forEach(a=>{const t=(a.textContent||'').trim();const nm=cn(t);const hf=rh(a.getAttribute('href'));if(nm&&nm.length>=3)add(nm,hf,'Unknown',t);});break;}
          }
        });

        // Strategy 1B: "Document located by URL" marker walk
        // Scans the WHOLE document — the 22 files are in the LEFT search-results
        // panel which is NOT inside [role="main"]. Using document ensures we find all.
        const DOC_LABEL='Document located by URL';
        const ACCESS=/\((Public|Partner|Customer|Internal|SAP\s+\w+)\)/i;
        const cardDiag=[];
        // SAP UI5 renders links as <a>, <span class="sapMLnk">, or custom elements —
        // broad selector so we don't miss any clickable element type.
        const LINK_SEL='a,[role="link"],[role="button"],button,[class*="sapMLnk"],[class*="sapMLink"],[class*="sapMText"]';
        Array.from(document.querySelectorAll('*')).filter(el=>{
          if(el.children.length>0)return false;
          return(el.textContent||'').trim()===DOC_LABEL;
        }).forEach(marker=>{
          let node=marker;
          for(let i=0;i<18;i++){
            if(!node.parentElement)break;
            node=node.parentElement;
            // Look for any clickable/text element carrying the file name
            const clickables=node.querySelectorAll(LINK_SEL);
            if(clickables.length>0){
              let bestName='',bestUrl='';
              // Prefer elements with an access marker or file extension in text
              clickables.forEach(el=>{
                const t=(el.textContent||'').replace(/\s+/g,' ').trim();
                const h=el.getAttribute('href')||'';
                const resolved=rh(h);
                if(!bestName&&(ACCESS.test(t)||FILE_EXT.test(t)))bestName=cn(t);
                if(!bestUrl&&resolved)bestUrl=resolved;
              });
              // If no access-marker link found, take longest text in the card as title
              if(!bestName){
                let longest='';
                Array.from(node.querySelectorAll('*')).forEach(el=>{
                  if(el.children.length>0)return;
                  const t=(el.textContent||'').trim();
                  if(t===DOC_LABEL||t.length<4)return;
                  if(t.length>longest.length)longest=t;
                });
                if(longest.length>=4)bestName=cn(longest);
              }
              // Sweep all attributes for URL patterns
              node.querySelectorAll('*').forEach(el=>{
                Array.from(el.attributes||[]).forEach(attr=>{
                  const v=attr.value||'';
                  if(/\/(download|content|\$value|attachment|file|asset)/i.test(v)){
                    const u=v.startsWith('http')?v:(v.startsWith('/')?location.origin+v:'');
                    if(u&&!bestUrl)bestUrl=u;
                  }
                  if(FILE_EXT.test(v)){
                    const u=v.startsWith('http')?v:(v.startsWith('/')?location.origin+v:'');
                    if(u&&!bestUrl)bestUrl=u;
                  }
                });
                const oc=el.getAttribute('onclick')||'';
                const ocm=oc.match(/(?:href|open|navigate|url)\s*[=(,'"]\s*['"]?([^'")\s]+\.(?:pdf|xlsx?|pptx?|docx?|zip)|\/[^'")\s]+(?:download|content|\$value)[^'")\s]*)/i);
                if(ocm&&!bestUrl)bestUrl=rh(ocm[1]);
              });
              if(bestName&&bestName.length>=3){
                add(bestName,bestUrl,'Public',bestName+' '+bestUrl);
                cardDiag.push({name:bestName,url:bestUrl,html:node.innerHTML.substring(0,600)});
              }
              break;
            }
          }
        });

        // Strategy 1C: Task / Deliverable items — same search-results page, different type label
        ['Task','Deliverable'].forEach(label=>{
          Array.from(document.querySelectorAll('*')).filter(el=>
            el.children.length===0&&(el.textContent||'').trim()===label
          ).forEach(marker=>{
            let node=marker;
            for(let i=0;i<20;i++){
              if(!node.parentElement)break;
              node=node.parentElement;
              if(node.querySelectorAll('a,[role="link"]').length>8)break; // nav area
              const links=Array.from(node.querySelectorAll('a,[role="link"]'));
              const titleLink=links.find(a=>{
                const t=(a.textContent||'').replace(/\s+/g,' ').trim();
                return t.length>5&&t!==label&&t!==DOC_LABEL&&!/^(Public|Partner|Customer|Internal|SAP\s)/.test(t);
              });
              if(titleLink){
                const title=cn(titleLink.textContent||'');
                const href=rh(titleLink.getAttribute('href')||'');
                if(title.length>=3)add(title,href,'Task',title+' '+href,'task');
                break;
              }
            }
          });
        });

        // Strategy 2: <a> with file extension OR access marker in visible text (fallback)
        // OR logic: catches files like "How to Approach Remote Cutover (Public)"
        // that have the access marker but no extension in the display name.
        // Excludes Tasks/Deliverables which have neither.
        const ACCESS_MARKER=/\((Public|Partner|Customer|Internal|SAP\s+(?:Internal|Partner|Customer))\)/i;
        scope.querySelectorAll('a').forEach(a=>{
          const text=(a.textContent||'').trim(),href=rh(a.getAttribute('href')||'');
          const hasExt=FILE_EXT.test(text)||FILE_EXT.test(href);
          const hasAccess=ACCESS_MARKER.test(text);
          if(!hasExt&&!hasAccess)return; // skip Tasks and Deliverables
          const n=cn(text)||cn(decodeURIComponent((href.split('/').pop()||'').split('?')[0]));
          if(n&&n.length>=3)add(n,href,hasAccess?'Public':'Unknown',text+' '+href);
        });

        // Strategy 3: data-* attributes (within scope)
        scope.querySelectorAll('[data-download-url],[data-file-url],[data-url],[data-href]').forEach(el=>{
          ['data-download-url','data-file-url','data-url','data-href'].forEach(attr=>{
            const u=el.getAttribute(attr)||'';if(!u||!FILE_EXT.test(u))return;
            const t=(el.textContent||'').trim(),n=cn(t)||cn(decodeURIComponent(u.split('/').pop().split('?')[0]));
            if(n&&n.length>=3)add(n,u.startsWith('http')?u:rh(u),'Unknown',t+' '+u);
          });
        });

        // Strategy 4: Performance resource entries
        // Enrich existing files AND add SAP API file entries (not arbitrary CDN URLs)
        try{performance.getEntriesByType('resource').forEach(e=>{
          const url=e.name;
          if(!FILE_EXT.test(url))return;
          const rawName=decodeURIComponent(url.split('/').pop().split('?')[0]),name=cn(rawName);
          // Try to enrich an existing file first
          const ex=files.find(f=>f.noUrl&&name&&
            (f.name.toLowerCase().replace(/\W/g,'').startsWith(name.toLowerCase().replace(/\W/g,'').substring(0,20))||
             name.toLowerCase().replace(/\W/g,'').startsWith(f.name.toLowerCase().replace(/\W/g,'').substring(0,20))));
          if(ex){ex.url=url;ex.noUrl=false;if(!ex.ext)ex.ext=gext('',url);return;}
          // Do NOT add new files from performance cache — enrichment only
        });}catch(e){}

        // Strategy 5: Re-fetch actual SAP API calls seen in performance timeline (no guessing)
        const apiProbeUrls=new Set();
        try{performance.getEntriesByType('resource').filter(e=>
          (e.initiatorType==='fetch'||e.initiatorType==='xmlhttprequest')&&
          /me\.sap\.com/.test(e.name)&&
          !/\.(css|js|png|jpg|svg|woff|ico)(\?|$)/i.test(e.name)
        ).slice(0,30).forEach(e=>apiProbeUrls.add(e.name));}catch(e2){}
        await Promise.allSettled([...apiProbeUrls].slice(0,30).map(async url=>{
          try{
            const r=await fetch(url,{credentials:'include'});
            if(!r.ok)return;
            const ct=r.headers.get('content-type')||'';
            if(!ct.includes('json')&&!ct.includes('odata'))return;
            const text=await r.text();
            if(text.length<20)return;
            try{
              const data=JSON.parse(text);
              const items=Array.isArray(data)?data:(data.value||data.d?.results||data.results||data.items||data.files||[]);
              if(Array.isArray(items))items.forEach(item=>{
                const name=cn(item.FileName||item.fileName||item.Title||item.title||item.Name||item.name||item.DocumentName||'');
                const dlUrl=item.DownloadUrl||item.downloadUrl||item.ContentUrl||item.contentUrl||
                            item.Url||item.url||item.FileUrl||item.fileUrl||item.LinkUrl||item.linkUrl||'';
                if(name.length<3)return;
                const ex=files.find(f=>f.noUrl&&f.name.toLowerCase().replace(/\W/g,'').startsWith(name.toLowerCase().replace(/\W/g,'').substring(0,15)));
                if(ex&&dlUrl){ex.url=dlUrl;ex.noUrl=false;}
              });
            }catch(_){}
          }catch(_){}
        }));

        const phases=[];
        scope.querySelectorAll('h1,h2,h3,h4').forEach((h,i)=>{
          const t=(h.textContent||'').replace(/\s+/g,' ').trim();
          if(t.length>3&&t.length<120)phases.push({id:'h-'+i,name:t,sequence:i});
        });

        return{ok:true,allFiles:files,phases,
          pageText:(document.body?.innerText||'').substring(0,300000),
          pageTitle:document.title,pageUrl:location.href,roadmapGuid:rid,
          scopeUsed:scope===document.body?'body':'main',cardDiag};
      }
    },results=>{
      if(chrome.runtime.lastError){respond({ok:false,error:chrome.runtime.lastError.message});return;}
      if(!results||!results.length){respond({ok:false,error:'Scan returned nothing — reload page.'});return;}

      const byName=new Map(),seenUrls=new Set();
      let pageText='',pageTitle='',pageUrl='',phases=[],roadmapGuid='',scopeUsed='',cardDiag=[];

      results.forEach(r=>{
        const d=r&&r.result;if(!d||!d.allFiles)return;
        if(!pageText&&d.pageText)pageText=d.pageText;
        if(!pageTitle&&d.pageTitle)pageTitle=d.pageTitle;
        if(!pageUrl&&d.pageUrl)pageUrl=d.pageUrl;
        if(!phases.length&&d.phases)phases=d.phases;
        if(!roadmapGuid&&d.roadmapGuid)roadmapGuid=d.roadmapGuid;
        if(!scopeUsed&&d.scopeUsed)scopeUsed=d.scopeUsed;
        if(!cardDiag.length&&d.cardDiag)cardDiag=d.cardDiag;
        d.allFiles.forEach(f=>{
          const k=f.name.toLowerCase().replace(/\W/g,'');
          if(f.url&&seenUrls.has(f.url))return;
          const ex=byName.get(k);
          if(!ex){byName.set(k,f);if(f.url)seenUrls.add(f.url);}
          else if(ex.noUrl&&!f.noUrl){byName.set(k,f);if(f.url)seenUrls.add(f.url);}
        });
      });

      let allFiles=Array.from(byName.values());

      // Enrich from webRequest cache (for DOM-found files with no URL)
      allFiles.forEach(f=>{
        if(!f.noUrl)return;
        const k=f.name.toLowerCase().replace(/\W+/g,'');
        let c=sapFileUrlCache.get(k);
        if(!c)for(const[ck,cv]of sapFileUrlCache){
          if(ck.startsWith(k.substring(0,Math.min(k.length,20)))||k.startsWith(ck.substring(0,Math.min(ck.length,20)))){c=cv;break;}
        }
        if(c){f.url=c;f.noUrl=false;}
      });

      // Safety cap: if scope fell back to body and too many files found, something went wrong
      const tooMany = allFiles.length > 30;
      if(tooMany) allFiles = allFiles.slice(0, 30);

      // ── MAIN world enrichment: read SAP UI5 OData model for download URLs ────
      // SAP Fiori stores all entity data (incl. download URLs) in the UI5 OData
      // model cache. Clicking elements in isolated world never surfaces this data,
      // but we can read it directly from the MAIN world JavaScript context.
      chrome.scripting.executeScript({
        target:{tabId,allFrames:true},
        world:'MAIN',
        func:()=>{
          const urlMap={};
          const modelDump=[];
          try{
            if(typeof sap==='undefined'||!sap.ui||!sap.ui.getCore)return{urlMap,modelDump};
            const core=sap.ui.getCore();
            function tryEntity(entity){
              if(!entity||typeof entity!=='object')return;
              const title=(entity.Title||entity.FileName||entity.Name||
                           entity.DisplayName||entity.DocumentName||'').trim();
              const url=entity.Url||entity.DownloadUrl||entity.FileUrl||
                        entity.ContentUrl||entity.LinkUrl||entity.HRef||
                        entity.href||entity.Href||'';
              if(title&&url&&url.startsWith('http')){
                const k=title.toLowerCase().replace(/\W+/g,'');
                if(!urlMap[k])urlMap[k]=url;
              }
              // SAP OData $value pattern: use __metadata.uri
              if(title&&!urlMap[title.toLowerCase().replace(/\W+/g,'')]&&entity.__metadata&&entity.__metadata.uri){
                urlMap[title.toLowerCase().replace(/\W+/g,'')]=entity.__metadata.uri+'/$value';
              }
            }
            // Approach A: all registered element binding contexts
            Object.values(core.mElements||{}).slice(0,2000).forEach(el=>{
              try{
                const ctx=el.getBindingContext&&el.getBindingContext();
                if(ctx){tryEntity(ctx.getObject&&ctx.getObject());}
              }catch(e){}
            });
            // Approach B: OData model internal data cache
            Object.values(core.mModels||{}).forEach(model=>{
              try{
                Object.values(model.oData||{}).forEach(tryEntity);
                // OData v4 internal maps
                ['_mEntitySets','_mPathToEntityType'].forEach(prop=>{
                  Object.values(model[prop]||{}).forEach(tryEntity);
                });
              }catch(e){}
            });
            // Dump first 10 model entries for debugging
            Object.values(core.mModels||{}).slice(0,2).forEach(model=>{
              Object.entries(model.oData||{}).slice(0,10).forEach(([k,v])=>{
                if(v&&typeof v==='object')modelDump.push({k,v:JSON.stringify(v).substring(0,300)});
              });
            });
          }catch(e){modelDump.push({err:String(e)});}
          return{urlMap,modelDump};
        }
      },enrichRes=>{
        const ed=enrichRes?.[0]?.result||{urlMap:{},modelDump:[]};
        const em=ed.urlMap||{};
        // Enrich noUrl files with model URLs
        allFiles.forEach(f=>{
          if(!f.noUrl)return;
          const k=f.name.toLowerCase().replace(/\W+/g,'');
          let u=em[k];
          if(!u)for(const[mk,mv]of Object.entries(em)){
            if(mk.startsWith(k.substring(0,Math.min(k.length,15)))||k.startsWith(mk.substring(0,Math.min(mk.length,15)))){u=mv;break;}
          }
          if(u){f.url=u;f.noUrl=false;}
        });
        // Add model dump to cardDiag for debugging
        if(ed.modelDump&&ed.modelDump.length)cardDiag.push({name:'_MODEL_DUMP',data:ed.modelDump,urlMap:em});

        // Strategy 6: ALM Search API + per-node detail fetch.
        // GET /node/detail/{roadmapId}/{nodeId} returns full XML with description + procedure steps.
        chrome.scripting.executeScript({
          target:{tabId,allFrames:true},
          world:'MAIN',
          func:async(rgHint,stHint)=>{
            if(!location.hostname.includes('alm.me.sap.com'))return null;
            const src=window.location.hash+window.location.href;
            const rg=(src.match(/roadmapguids?\/([a-zA-Z0-9_-]{6,})/i)||[null,rgHint])[1];
            const st=(src.match(/searchresult\/([^/&?#]+)/i)||[null,stHint])[1];
            if(!rg||!st)return null;
            let csrf='';
            try{csrf=window.jQuery?.ajaxSettings?.headers?.['x-csrf-token']||'';}catch(e){}
            if(!csrf){try{
              const r=await fetch('/ui/act-rmv-service-ui/v1/api/v1/RmvService/',
                {credentials:'include',headers:{'x-csrf-token':'Fetch'}});
              csrf=r.headers.get('x-csrf-token')||'';
            }catch(e){}}
            if(!csrf)return null;
            const res=await fetch('/ui/act-rmv-service-ui/v1/api/v1/search',{
              method:'POST',credentials:'include',
              headers:{
                'Content-Type':'application/json','Accept':'application/json',
                'x-csrf-token':csrf,'x-requested-with':'XMLHttpRequest'
              },
              body:JSON.stringify({
                searchTerm:decodeURIComponent(st),pageIndex:'0',pageSize:'50',
                roadmaps:[rg],language:'EN',types:[]
              })
            });
            if(!res.ok)return null;
            const d=await res.json();
            const items=d.value||[];
            // Fetch full detail for every NODE-type item in parallel (GET, no CSRF needed)
            const detailMap={};
            await Promise.allSettled(
              items
                .filter(it=>it.TECHNICALTYPE==='NODE')
                .map(async it=>{
                  // SAP node GUIDs are 32 uppercase hex chars with no dashes.
                  // Scan all string fields to find one matching that pattern.
                  const sapGuidEntry=Object.entries(it).find(([,v])=>typeof v==='string'&&/^[0-9A-Fa-f]{32}$/.test(v));
                  const guid=sapGuidEntry?sapGuidEntry[1]:(it.KEY||it.NODE_KEY||it.GUID||'');
                  if(!guid)return;
                  const ctrl=new AbortController();
                  const timer=setTimeout(()=>ctrl.abort(),10000);
                  try{
                    const r=await fetch(
                      `/ui/act-rmv-service-ui/v1/api/v1/node/detail/${rg}/${guid}`,
                      {credentials:'include',signal:ctrl.signal}
                    );
                    clearTimeout(timer);
                    const data=await r.json();
                    const descHtml=data.description||'';
                    if(!descHtml)return;
                    detailMap[guid]={
                      descHtml,
                      ancestorDetail:data.ancestorDetail||'',
                      leadingWorkstream:data.leadingWorkstream||'',
                    };
                  }catch(e){clearTimeout(timer);}
                })
            );
            return items.map(it=>{
              const sapE=Object.entries(it).find(([,v])=>typeof v==='string'&&/^[0-9A-Fa-f]{32}$/.test(v));
              const sapGuid=sapE?sapE[1]:(it.KEY||it.NODE_KEY||it.GUID||'');
              return {...it,_detail:detailMap[sapGuid]||null,_sapGuid:sapGuid};
            });
          },
          args:[roadmapGuid,'cutover']
        },apiRes=>{
          void chrome.runtime.lastError;
          const apiItems=apiRes?.flatMap(r=>Array.isArray(r?.result)?r.result:[])||[];
          function stripHtml(s){return(s||'').replace(/<[^>]+>/g,'').trim();}
          function cn2(s){return(s||'').replace(/\s*\((Public|Partner|Customer|Internal|SAP\s+\w+)\)\s*$/i,'').replace(/\s+/g,' ').trim();}
          function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
          apiItems.forEach(item=>{
            const name=cn2(item.NAME||'');
            const url=item.URL||'';
            const isDoc=item.TECHNICALTYPE==='DOCUMENT';
            const snippets=item['DESCRIPTION@com.sap.vocabularies.Search.v1.Snippets']||[];
            const snippet=stripHtml(Array.isArray(snippets)?snippets.join(' '):String(snippets));
            const desc=item.DESCRIPTION||snippet;
            const tags=item.TAGS||'';
            const iType=item.TYPE||'';
            const guid=item._sapGuid||item.KEY||item.NODE_KEY||item.GUID||'';
            const ext=(url.match(/\.(xlsx?|pdf|pptx?|docx?)/i)||['',''])[1].toLowerCase();
            if(!name||name.length<3)return;
            const k=name.toLowerCase().replace(/\W/g,'');
            const ex=allFiles.find(f=>{
              const fk=f.name.toLowerCase().replace(/\W/g,'');
              return fk===k||fk.startsWith(k.substring(0,Math.min(k.length,20)))||k.startsWith(fk.substring(0,Math.min(fk.length,20)));
            });
            if(isDoc){
              if(ex){if(url&&ex.noUrl){ex.url=url;ex.noUrl=false;}if(!ex.ext&&ext)ex.ext=ext;}
              else allFiles.push({name,url,ext,noUrl:!url,type:'document',desc,tags,guid});
            }else{
              if(!ex){
                const detail=item._detail;
                const typeLabel=iType==='TSK'?'Task':iType==='DEL'?'Deliverable':'Node';
                const fullDescHtml=detail?.descHtml||'';
                const ancestor=detail?.ancestorDetail||'';
                const breadcrumb=ancestor.split('@$@').map(s=>s.split('||')[0]).filter(Boolean).join(' > ');
                const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(name)}</title>`+
                  `<style>body{font-family:Segoe UI,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#222}`+
                  `h1{font-size:1.4em}h2{font-size:1.1em;margin-top:1.5em}p,li{line-height:1.6}`+
                  `.m{color:#666;font-size:.9em}ol{padding-left:1.5em}strong{font-weight:600}</style></head><body>`+
                  `<h1>${esc(name)}</h1>`+
                  `<p class="m"><strong>Type:</strong> ${esc(typeLabel)}`+
                  (breadcrumb?` &nbsp;|&nbsp; <strong>Path:</strong> ${esc(breadcrumb)}`:'')+
                  `</p>`+
                  (tags?`<p class="m"><strong>Scenarios:</strong> ${esc(tags)}</p>`:'')+
                  (fullDescHtml?`<h2>Description</h2>${fullDescHtml}`:(desc?`<h2>Description</h2><p>${esc(desc)}</p>`:''))+
                  (guid?`<p class="m"><strong>GUID:</strong> ${esc(guid)}</p>`:'')+
                  `</body></html>`;
                allFiles.push({name,url:'',ext:'html',noUrl:true,type:'task',inMemory:true,content:html,tags,guid});
              }
            }
          });
          respond({ok:true,allFiles,phases,pageText,pageTitle,pageUrl,roadmapGuid,scopeUsed,tooMany,cardDiag});
        });
      });
    });
    return;
  }

  // ── captureTaskPage ──────────────────────────────────────────────────────────
  // Opens a SAP Roadmap task URL in a background tab, waits for the SPA to render,
  // extracts the full text content, and returns it as base64 HTML.
  if(action==='captureTaskPage'){
    const taskUrl=msg.url;
    if(!taskUrl||!taskUrl.startsWith('http')){respond({ok:false,error:'No URL for task page'});return;}
    const taskTab=await new Promise(resolve=>{
      chrome.tabs.create({url:taskUrl,active:false},tab=>resolve(tab));
    });
    // Wait for tab to finish loading (SPA navigation + rendering)
    await new Promise(resolve=>{
      function onUpdated(id,info){
        if(id===taskTab.id&&info.status==='complete'){
          chrome.tabs.onUpdated.removeListener(onUpdated);resolve();
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
      setTimeout(resolve,20000); // max 20s
    });
    await new Promise(r=>setTimeout(r,4000)); // wait for SPA to finish rendering
    const extractRes=await new Promise(resolve=>{
      chrome.scripting.executeScript({
        target:{tabId:taskTab.id,allFrames:true},
        func:()=>{
          const main=document.querySelector('[role="main"]')||document.querySelector('main')||document.body;
          return{title:document.title,text:(main.innerText||main.textContent||'').substring(0,200000),url:location.href};
        }
      },results=>{
        void chrome.runtime.lastError;
        const r=results?.find(fr=>fr.result?.text&&fr.result.text.length>50)?.result||results?.[0]?.result;
        resolve(r&&r.text?{ok:true,...r}:{ok:false,error:'No content extracted'});
      });
    });
    chrome.tabs.remove(taskTab.id,()=>{void chrome.runtime.lastError;});
    if(!extractRes.ok){respond({ok:false,error:extractRes.error});return;}
    const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(extractRes.title)}</title></head><body><h1>${esc(extractRes.title)}</h1><pre style="white-space:pre-wrap;font-family:inherit">${esc(extractRes.text)}</pre></body></html>`;
    const bytes=new TextEncoder().encode(html);
    const CHUNK=8190;let b64='';
    for(let i=0;i<bytes.length;i+=CHUNK)b64+=btoa(String.fromCharCode.apply(null,bytes.subarray(i,Math.min(i+CHUNK,bytes.length))));
    respond({ok:true,base64:b64,size:bytes.length,taskUrl:extractRes.url});
    return;
  }

  // ── fetchAndCapture ─────────────────────────────────────────────────────────
  // chrome.downloads handles SAP auth (SameSite cookies, redirects).
  // onDeterminingFilename captures CDN URL before disk write → cancel → fetch bytes here.
  if(action==='fetchAndCapture'){
    const fileUrl=msg.url;
    if(!isSapDomain(fileUrl)){respond({ok:false,error:'Blocked: not SAP domain'});return;}

    const cdnUrl=await new Promise((resolve,reject)=>{
      chrome.downloads.download(
        {url:fileUrl,filename:'sap-brain-tmp/'+(msg.name||'tmp.bin'),saveAs:false,conflictAction:'uniquify'},
        id=>{
          if(chrome.runtime.lastError||!id){
            reject(new Error(chrome.runtime.lastError?.message||'Download failed to start'));return;
          }
          _dlWaiters.set(id,resolve);
          setTimeout(()=>{
            if(_dlWaiters.has(id)){
              _dlWaiters.delete(id);
              chrome.downloads.cancel(id,()=>{ void chrome.runtime.lastError; chrome.downloads.erase({id},()=>{ void chrome.runtime.lastError; }); });
              reject(new Error('No download triggered after 15s — URL is not a direct file link.'));
            }
          },15000);
        }
      );
    }).catch(e=>({error:e.message}));

    if(cdnUrl&&cdnUrl.error){respond({ok:false,error:cdnUrl.error});return;}
    if(!cdnUrl){respond({ok:false,error:'No CDN URL captured'});return;}

    // Fetch CDN signed URL from service worker (no cookies needed — token in URL)
    try{
      const resp=await fetch(cdnUrl,{credentials:'omit'});
      if(!resp.ok) throw new Error('CDN HTTP '+resp.status);
      const buffer=await resp.arrayBuffer();
      if(buffer.byteLength<500) throw new Error('Response too small ('+buffer.byteLength+' bytes)');
      respond({ok:true,base64:toBase64(buffer),size:buffer.byteLength,cdnUrl});
    }catch(fetchErr){
      // Fallback: try executeScript on SAP tab (extension <all_urls> bypasses CORS)
      chrome.scripting.executeScript({
        target:{tabId,allFrames:true},
        func:async(url)=>{
          try{
            const resp=await fetch(url,{credentials:'omit'});
            if(!resp.ok)return{ok:false,error:'HTTP '+resp.status};
            const buf=await resp.arrayBuffer();
            if(buf.byteLength<500)return{ok:false,error:'Too small'};
            const CHUNK=8190,bytes=new Uint8Array(buf);let b64='';
            for(let i=0;i<bytes.length;i+=CHUNK)b64+=btoa(String.fromCharCode.apply(null,bytes.subarray(i,Math.min(i+CHUNK,bytes.length))));
            return{ok:true,base64:b64,size:buf.byteLength};
          }catch(e){return{ok:false,error:String(e)};}
        },
        args:[cdnUrl]
      },results2=>{
        if(chrome.runtime.lastError){respond({ok:false,error:chrome.runtime.lastError.message,cdnUrl});return;}
        const s=results2?.find(r=>r.result?.ok===true);
        if(s){respond({...s.result,cdnUrl});return;}
        // All else failed → chrome.downloads to Downloads/
        chrome.downloads.download({
          url:cdnUrl||fileUrl,filename:'SAP-Cutover-Brain/'+(msg.name||'file.bin'),
          conflictAction:'uniquify',saveAs:false,
        },dlId=>{respond({ok:false,usedDownloads:true,downloadId:dlId,error:fetchErr.message});});
      });
    }
    return;
  }

  // ── clickAndCapture ─────────────────────────────────────────────────────────
  // For files whose <a> href is empty/javascript — SAP uses click handlers.
  // Injects a click on the element whose text matches the file name.
  // SAP's JS initiates the browser download → onDeterminingFilename (tab waiter) fires.
  if(action==='clickAndCapture'){
    const {fileName}=msg;

    // Step 1: inject into MAIN world — patch window.open + anchor.click + fetch
    // to intercept whatever URL SAP navigates to when the element is clicked.
    // SAP UI5 ignores isTrusted=false synthetic events for business logic, but it
    // DOES call window.open / hidden-anchor.click / fetch to initiate the download.
    const clickResult = await new Promise(resolve => {
      chrome.scripting.executeScript({
        target:{tabId,allFrames:true},
        world:'MAIN',
        func:async(name)=>{
          const clean=name.replace(/\s*\([^)]*\)\s*$/,'').trim();
          function textOf(el){return(el.textContent||'').replace(/\s+/g,' ').trim();}
          function matches(t){
            // require at least 6 chars to avoid spurious nav-menu matches
            if(t.length<6&&name.length>6)return false;
            return t===name||t===clean||t.startsWith(name)||t.startsWith(clean);
          }
          // Pass 1: link/button/SAP UI5 link elements
          let target=Array.from(document.querySelectorAll(
            'a,[role="link"],[role="button"],button,[class*="sapMLnk"],[class*="sapMLink"],[class*="sapMText"],[class*="Link"],[class*="link"],[class*="Item"],[class*="item"]'
          )).find(el=>matches(textOf(el)));
          // Pass 2: any leaf text node
          if(!target){
            target=Array.from(document.querySelectorAll('*')).find(el=>{
              if(el.children.length>0)return false;
              return matches(textOf(el));
            });
          }
          if(!target)return{ok:false,error:'Element not found for: '+name};

          // Patch window.open, hidden-anchor click, fetch to capture the URL SAP opens
          let capturedUrl='';
          const origOpen=window.open;
          window.open=function(url,...args){
            if(url&&/^https?:\/\//.test(url)&&!capturedUrl)capturedUrl=String(url);
            return origOpen.apply(window,arguments);
          };
          const origAnchorClick=HTMLAnchorElement.prototype.click;
          HTMLAnchorElement.prototype.click=function(){
            const h=this.href||'';
            if(/^https?:\/\//.test(h)&&!capturedUrl)capturedUrl=h;
            origAnchorClick.call(this);
          };
          const origFetch=window.fetch;
          window.fetch=function(url,...args){
            const u=typeof url==='string'?url:(url&&url.url)||'';
            if(u&&!capturedUrl&&/\/(download|content|\$value|attachment|file)/i.test(u))
              capturedUrl=u.startsWith('http')?u:new URL(u,location.origin).href;
            return origFetch.apply(window,arguments);
          };

          // Ensure link doesn't open a new tab
          if(target.getAttribute&&target.getAttribute('target')==='_blank')
            target.setAttribute('target','_self');

          // Dispatch full pointer+mouse sequence
          const rect=target.getBoundingClientRect();
          const cx=Math.round(rect.left+rect.width/2),cy=Math.round(rect.top+rect.height/2);
          const opts={bubbles:true,cancelable:true,view:window,button:0,buttons:1,clientX:cx,clientY:cy};
          ['pointerdown','mousedown','mouseup','click','pointerup'].forEach(type=>{
            target.dispatchEvent(new (type.startsWith('pointer')?PointerEvent:MouseEvent)(
              type,{...opts,...(type.startsWith('pointer')?{isPrimary:true,pointerId:1}:{})}
            ));
          });

          // Wait for SAP's async handler to fire (it may fetch a token first)
          await new Promise(r=>setTimeout(r,5000));

          // Restore originals
          window.open=origOpen;
          HTMLAnchorElement.prototype.click=origAnchorClick;
          window.fetch=origFetch;

          return{ok:true,capturedUrl,clicked:target.tagName+': '+textOf(target).substring(0,60)};
        },
        args:[fileName]
      },results=>{
        if(chrome.runtime.lastError){resolve({ok:false,error:chrome.runtime.lastError.message});return;}
        // Pick the frame that actually found and clicked the element
        const r=results?.find(fr=>fr.result?.ok===true)?.result
               ||results?.[0]?.result;
        resolve(r||{ok:false,error:'No result from click script'});
      });
    });

    if(!clickResult?.ok){respond({ok:false,error:clickResult?.error||'Click failed'});return;}

    // Step 2a: if the intercepted URL is a SAP file URL, use fetchAndCapture flow
    const intercepted=clickResult.capturedUrl||'';
    if(intercepted&&/^https?:\/\//.test(intercepted)){
      // Re-use the fetchAndCapture CDN-capture flow: chrome.downloads triggers
      // SAP auth/redirect chain, onDeterminingFilename captures CDN URL, we fetch it.
      const cdnUrl2=await new Promise((resolve,reject)=>{
        chrome.downloads.download(
          {url:intercepted,filename:'sap-brain-tmp/'+(msg.name||'tmp.bin'),saveAs:false,conflictAction:'uniquify'},
          id=>{
            if(chrome.runtime.lastError||!id){
              reject(new Error(chrome.runtime.lastError?.message||'Download failed'));return;
            }
            _dlWaiters.set(id,resolve);
            setTimeout(()=>{
              if(_dlWaiters.has(id)){
                _dlWaiters.delete(id);
                chrome.downloads.cancel(id,()=>{ void chrome.runtime.lastError; chrome.downloads.erase({id},()=>{ void chrome.runtime.lastError; }); });
                reject(new Error('CDN capture timeout for intercepted URL'));
              }
            },15000);
          }
        );
      }).catch(e=>({error:e.message}));

      if(cdnUrl2&&!cdnUrl2.error){
        try{
          const resp=await fetch(cdnUrl2,{credentials:'omit'});
          if(!resp.ok)throw new Error('CDN HTTP '+resp.status);
          const buffer=await resp.arrayBuffer();
          if(buffer.byteLength<500)throw new Error('Too small');
          respond({ok:true,base64:toBase64(buffer),size:buffer.byteLength,cdnUrl:cdnUrl2});return;
        }catch(_){}
      }
    }

    // Step 2b: fall back — wait for onDeterminingFilename (SAP may have opened new tab)
    const cdnUrl=await new Promise((resolve,reject)=>{
      _clickWaiters.set(tabId,resolve);
      setTimeout(()=>{
        if(_clickWaiters.has(tabId)){
          _clickWaiters.delete(tabId);
          reject(new Error(intercepted
            ? 'CDN fetch failed for: '+intercepted.substring(0,80)
            : 'Click on "'+fileName+'" did not trigger a download'));
        }
      },8000);
    }).catch(e=>({error:e.message}));

    if(cdnUrl&&cdnUrl.error){respond({ok:false,error:cdnUrl.error});return;}
    if(!cdnUrl){respond({ok:false,error:'No CDN URL from click'});return;}

    try{
      const resp=await fetch(cdnUrl,{credentials:'omit'});
      if(!resp.ok)throw new Error('CDN HTTP '+resp.status);
      const buffer=await resp.arrayBuffer();
      if(buffer.byteLength<500)throw new Error('Too small ('+buffer.byteLength+' bytes)');
      respond({ok:true,base64:toBase64(buffer),size:buffer.byteLength,cdnUrl});
    }catch(fetchErr){
      chrome.downloads.download({
        url:cdnUrl,filename:'SAP-Cutover-Brain/'+(msg.name||'file.bin'),
        conflictAction:'uniquify',saveAs:false,
      },dlId=>{respond({ok:false,usedDownloads:true,downloadId:dlId,error:fetchErr.message});});
    }
    return;
  }

  // ── downloadRoadmapFile (explicit Downloads/ fallback) ──────────────────────
  if(action==='downloadRoadmapFile'){
    if(!isSapDomain(msg.url)){respond({ok:false,error:'Blocked'});return;}
    chrome.downloads.download({
      url:msg.url,filename:'SAP-Cutover-Brain/'+(msg.name||'file.bin'),
      conflictAction:'uniquify',saveAs:false,
    },id=>{
      if(chrome.runtime.lastError)respond({ok:false,error:chrome.runtime.lastError.message});
      else if(!id)respond({ok:false,error:'Download failed to start'});
      else respond({ok:true,downloadId:id});
    });
    return;
  }
}
