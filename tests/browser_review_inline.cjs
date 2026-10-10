/* Real Chromium selection, durable file roundtrip, revised anchors, keyboard/phone QA.
   Uses already available Playwright/Chromium; no installation. Overrides match browser_review.cjs. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process'),{pathToFileURL}=require('node:url');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pr-inline-'));
 const original=JSON.parse(fs.readFileSync(path.join(root,'skills/review-canvas/assets/example-review.json')));
 const render=(value,name)=>{const input=path.join(tmp,name+'.json'),output=path.join(tmp,name+'.html');fs.writeFileSync(input,JSON.stringify(value));const run=spawnSync(process.env.PYTHON||'python3',[path.join(root,'skills/review-canvas/scripts/render_review.py'),input,'--output',output],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);return pathToFileURL(output).href;};
 // Long surrounding text includes emoji where an 80-unit context slice would bisect a surrogate pair.
 original.files[1].patch='@@ -1,1 +1,2 @@\n '+ '🙂'.repeat(41)+' context\n+selected code marker';
 original.target.url='https://github.com/example/project/pull/7';
 const url=render(original,'original');const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true});
 try{
 const ctx=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}}),page=await ctx.newPage();
 const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('request',r=>{if(/^https?:/.test(r.url()))external.push(r.url());});page.on('dialog',d=>d.accept());
 const load=async target=>{await page.goto(target);await page.waitForFunction(()=>document.querySelector('#progress').textContent.includes('of 3'));};
 const save=async()=>{const pending=page.waitForEvent('download');await page.locator('#export-feedback').click();const download=await pending;const target=path.join(tmp,Date.now()+'-'+download.suggestedFilename());await download.saveAs(target);return {target,data:JSON.parse(fs.readFileSync(target))};};
 const restore=async(target,expected='Imported')=>{await page.locator('#import-feedback').setInputFiles(target);await page.waitForFunction(expected=>document.querySelector('#import-status').textContent.includes(expected),expected);};
 await load(url);
 // Actual pointer drag inside code: browser-produced selection, not a synthetic anchor.
 const code=page.locator('#file-1 .source code').last();await code.scrollIntoViewIfNeeded();const box=await code.boundingBox();
 await page.mouse.move(box.x+3,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+140,box.y+box.height/2,{steps:8});await page.mouse.up();
 await page.waitForFunction(()=>!document.querySelector('#comment-selection').disabled);
 const quote=await page.evaluate(()=>getSelection().toString());assert.ok(quote.includes('selected'));
 await page.locator('#comment-selection').click();assert.ok((await page.locator('#selected-quote').textContent()).length>0);
 const hostile='Check selected text 🙂 </textarea><img src="https://evil.invalid/a" onerror="globalThis.PWNED=1">';
 await page.locator('#comment-body').fill(hostile);
 const draftQuote=await page.locator('#selected-quote').textContent();
 await page.evaluate(()=>{const code=document.querySelector('#file-1 .source code');const r=document.createRange();r.selectNodeContents(code);const s=getSelection();s.removeAllRanges();s.addRange(r);});
 await page.locator('#save-comment').click();
 assert.equal(await page.locator('.inline-comment').count(),1);assert.ok(await page.locator('mark').count());assert.equal(await page.locator('.comment-body').textContent(),hostile);
 await page.locator('#file-1 .notes-details > summary').click();await page.locator('#notes-1').fill('file note');await page.locator('#general-notes').fill('general note');await page.getByRole('checkbox',{name:'Approve src/retry.py'}).check();
 let saved=await save();assert.equal(saved.data.comments.length,1);assert.equal(saved.data.comments[0].anchor.quote,draftQuote);assert.equal(saved.data.comments[0].attachment.state,'attached');assert.equal(saved.data.comments[0].anchor.snapshot.target.head_sha,original.target.head_sha);
 assert.equal(saved.data.feedback_schema_version,3);assert.equal(saved.data.comments[0].anchor.side,'new');assert.equal(saved.data.comments[0].anchor.start_line,2);assert.equal(saved.data.approvals.length,1);assert.ok(saved.data.comments[0].anchor.quote.length>0);
 await page.reload();assert.equal(await page.locator('.inline-comment').count(),0);assert.equal(await page.locator('#general-notes').inputValue(),'');
 await restore(saved.target);assert.equal(await page.locator('.inline-comment').count(),1);assert.equal(await page.locator('#notes-1').inputValue(),'file note');assert.ok(await page.getByRole('checkbox',{name:'Approve src/retry.py'}).isChecked());
 // Deliberate clears must never be overwritten by an older file.
 await page.locator('#file-1 .notes-details > summary').click();await page.locator('#notes-1').fill('');await restore(saved.target,'Import rejected');assert.equal(await page.locator('#notes-1').inputValue(),'');
 await page.reload();await restore(saved.target);await page.locator('#general-notes').fill('');await restore(saved.target,'Import rejected');assert.equal(await page.locator('#general-notes').inputValue(),'');
 await page.reload();await restore(saved.target);
 // Semantically identical reordered JSON keys must be idempotent.
 const ordered=structuredClone(saved.data);ordered.comments[0]=Object.fromEntries(Object.entries(ordered.comments[0]).reverse());const reordered=path.join(tmp,'reordered.json');fs.writeFileSync(reordered,JSON.stringify(ordered));await restore(reordered);assert.equal(await page.locator('.inline-comment').count(),1);
 // Restoring the same feedback again leaves nothing unexported, including its approvals.
 assert.equal(await page.locator('#save-state').isHidden(),true);await restore(saved.target);assert.equal(await page.locator('#save-state').isHidden(),true);
 const conflict=structuredClone(saved.data);conflict.comments[0].body='conflicting edit';const conflictPath=path.join(tmp,'conflict.json');fs.writeFileSync(conflictPath,JSON.stringify(conflict));await restore(conflictPath,'Import rejected');assert.equal(await page.locator('.comment-body').textContent(),hostile);
 // Edit, delete, undo all survive export.
 await page.getByRole('button',{name:'Edit comment',exact:true}).click();await page.locator('#comment-body').fill('edited');await page.locator('#save-comment').click();await page.getByRole('button',{name:'Delete comment',exact:true}).click();assert.equal(await page.locator('.inline-comment').count(),0);await page.locator('#undo-delete').click();assert.equal(await page.locator('.comment-body').textContent(),'edited');
 // Multirow selection through actual Range API validates original-source offsets (marks may split text nodes).
 await page.evaluate(()=>{const codes=document.querySelectorAll('#file-1 .source code');const range=document.createRange();range.setStart(codes[1].firstChild,0);range.setEnd(codes[2],codes[2].childNodes.length);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);});
 await page.waitForFunction(()=>!document.querySelector('#comment-selection').disabled);await page.locator('#comment-selection').click();await page.locator('#comment-body').fill('multirow emoji context');await page.locator('#save-comment').click();saved=await save();assert.equal(saved.data.comments.length,2);assert.ok(saved.data.comments[1].anchor.quote.includes('\n'));
 const revised=structuredClone(original);revised.target.head_sha='3'.repeat(40);revised.files[1].patch='+new header\n'+original.files[1].patch;revised.files[1].fingerprint='9'.repeat(64);
 await load(render(revised,'moved'));await restore(saved.target);assert.equal(await page.locator('#orphan-comments').isVisible(),false);assert.equal(await page.locator('.inline-comment').count(),2);assert.equal(await page.getByRole('checkbox',{name:'Approve src/retry.py'}).isChecked(),false);assert.equal(await page.locator('#file-1 .approval-changed').isVisible(),true);assert.equal(await page.locator('#notes-1').inputValue(),'');assert.ok((await page.locator('#retained-json').textContent()).includes('file note'));
 const moved=await save();assert.equal(moved.data.retained_reviews.length,1);assert.equal(moved.data.comments[0].anchor.snapshot.target.head_sha,original.target.head_sha);assert.equal(moved.data.approvals[0].fingerprint,original.files[1].fingerprint);assert.ok(moved.data.comments.every(c=>c.attachment.reason.includes('revised')));
 // Unchanged patch, changed quote/context, removed file and foreign PR remain conservative.
 const ambiguous=structuredClone(revised);ambiguous.files[1].patch=original.files[1].patch+'\n'+original.files[1].patch;await load(render(ambiguous,'ambiguous'));await restore(saved.target);assert.equal(await page.locator('#orphan-list .inline-comment').count(),2);
 const changed=structuredClone(revised);changed.files[1].patch='@@ -1,1 +1,1 @@\n+replacement code';await load(render(changed,'changed'));await restore(saved.target);assert.equal(await page.locator('#orphan-list .inline-comment').count(),2);
 const originalAnchor=saved.data.comments[0].anchor;await page.locator('#file-1 .comment-line').last().focus();await page.keyboard.press('Enter');await page.locator('#cancel-comment').click();
 // Select intended replacement, then explicit manual reattachment preserves old anchor in history.
 await page.evaluate(()=>{const code=[...document.querySelectorAll('#file-1 .source code')].find(c=>c.textContent.includes('replacement code'));const r=document.createRange();r.selectNodeContents(code);const s=getSelection();s.removeAllRanges();s.addRange(r);});await page.waitForFunction(()=>!document.querySelector('#comment-selection').disabled);
 await page.getByRole('button',{name:'Attach to selected text',exact:true}).first().click();await page.locator('#save-comment').click();const reattached=await save();assert.deepEqual(reattached.data.comments[0].history[0],originalAnchor);assert.equal(reattached.data.comments[0].anchor.snapshot.target.head_sha,revised.target.head_sha);
 const absent=structuredClone(revised);absent.files[1].patch=null;await load(render(absent,'absent'));await restore(saved.target);assert.equal(await page.locator('#orphan-list .inline-comment').count(),2);
 const foreign=structuredClone(saved.data);foreign.target.url='https://github.com/other/repo/pull/2';const foreignPath=path.join(tmp,'foreign.json');fs.writeFileSync(foreignPath,JSON.stringify(foreign));await restore(foreignPath,'Import rejected');assert.equal(await page.locator('#orphan-list .inline-comment').count(),2);
 const corrupt=path.join(tmp,'corrupt.json');fs.writeFileSync(corrupt,'{"feedback_schema_version":3,"feedback_schema_version":3}');await restore(corrupt,'Import rejected');
 await load(url);
 // A delayed older import must never overwrite the latest chosen file.
 await page.evaluate(()=>{const original=File.prototype.text;File.prototype.text=function(){if(this.name==='slow.json')return new Promise(resolve=>{globalThis.releaseOldImport=()=>original.call(this).then(resolve);});return original.call(this);};});
 const slow=path.join(tmp,'slow.json');fs.writeFileSync(slow,JSON.stringify(foreign));await page.locator('#import-feedback').setInputFiles(slow);await restore(saved.target);await page.evaluate(()=>globalThis.releaseOldImport());await page.waitForTimeout(100);assert.ok((await page.locator('#import-status').textContent()).startsWith('Imported'));assert.equal(await page.locator('.inline-comment').count(),2);
 await page.reload();
 await page.locator('#file-1 .comment-line').last().click();await page.locator('#comment-body').fill('unsaved draft');const draftDialog=page.waitForEvent('dialog');const draftReload=page.reload();assert.equal((await draftDialog).type(),'beforeunload');await draftReload;
 // Phone keyboard workflow and enlarged text both modes. Diff scrolls independently.
 for(const theme of ['light','dark']){if(await page.locator('html').getAttribute('data-theme')!==theme)await page.locator('#theme-toggle').click();for(const width of [1440,390,320])for(const scale of [1,2]){await page.setViewportSize({width,height:1000});await page.evaluate(scale=>document.documentElement.style.fontSize=16*scale+'px',scale);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${theme}/${width}/${scale} overflow`);}}
 await page.setViewportSize({width:320,height:900});await page.evaluate(()=>document.documentElement.style.fontSize='16px');await page.locator('#file-1 .comment-line').last().focus();await page.keyboard.press('Enter');assert.ok(await page.locator('#comment-body').evaluate(e=>e===document.activeElement));await page.keyboard.type('Phone keyboard comment');await page.locator('#save-comment').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('.inline-comment').count(),1);await page.locator('#comment-index .comment-jump').first().click();assert.equal(await page.locator(':focus').getAttribute('class'),'inline-comment');
 await page.locator('#export-feedback').hover();assert.equal(await page.locator('#export-feedback').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(215, 166, 189)');
 await page.screenshot({path:path.join(tmp,'inline-phone-dark.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:path.join(tmp,'inline-desktop-dark.png'),fullPage:true});
 assert.deepEqual(external,[]);assert.deepEqual(errors,[]);assert.equal(await page.locator('img,iframe,svg').count(),0);assert.equal(await page.evaluate(()=>Boolean(globalThis.PWNED)),false);
 await ctx.close();console.log(`PASS: pointer selection, multirow Unicode, comment edit/delete/undo, file save/reload/import, conflicts including cleared notes, revised anchors, retained snapshots, orphans/manual reattach/history, invalid/foreign imports, desktop/phone 100/200 text, keyboard focus, hover, CSP/no network. Artifacts: ${tmp}`);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
