// Browser fixture for the production injected function, supplied by the local
// verification harness. All URLs and page data belong to that fixture.
export async function runPageAssetsCases(operation) {
  const results = [], inventories = {};
  const expect = (condition, message) => { if (!condition) throw Error(message); };
  const list = async (params = {}) => {
    const value = await operation('assets', params);
    if (value?.__aosCompanionError) throw Object.assign(Error(value.__aosCompanionError.message), value.__aosCompanionError);
    return value;
  };
  const check = async (name, callback) => {
    const started = performance.now();
    try { await callback(); results.push({name, passed:true, ms:performance.now()-started}); }
    catch (error) { results.push({name, passed:false, error:error.message, code:error.code??null}); }
  };
  const fixture = document.querySelector('#fixture');
  fixture.innerHTML = `<img id="hero" alt="local fixture image" src="/images/hero.svg"><div id="background">CSS background and pseudo image</div>
    <video id="movie" controls preload="none" poster="/images/poster.svg"><source src="/media/sample.mp4" type="video/mp4"></video>
    <div id="shadow-host"></div><svg id="logo" width="110" height="60" viewBox="0 0 110 60" xmlns="http://www.w3.org/2000/svg"><title>テストのロゴ</title><path d="M10 50L55 10L100 50Z" fill="#2463b5"/></svg>`;
  const shadow=fixture.querySelector('#shadow-host').attachShadow({mode:'open'});
  shadow.innerHTML='<style>.shadow-picture { background-image:url("/images/shadow.svg") }</style><div class="shadow-picture">Shadow DOM background</div>';
  const adopted = new CSSStyleSheet();adopted.replaceSync('@font-face {font-family:fixture-shadow;src:url("/fonts/shadow.woff2")}');shadow.adoptedStyleSheets=[adopted];
  const hero=fixture.querySelector('#hero');await hero.decode();
  const initial=await list();inventories.initial=initial;
  const asset = (suffix, inventory=initial) => inventory.assets.find(item=>item.url?.endsWith(suffix));
  await check('page identity and six file kinds',async()=>{
    expect(initial.pageUrl===location.href&&typeof initial.pageInstanceId==='string','page identity mismatch');
    for(const kind of ['image','video','font','stylesheet','script','other']) expect(initial.assets.some(item=>item.kind===kind),'missing '+kind);
    expect(initial.summary.totalCount===initial.assets.length,'summary mismatch');
  });
  await check('one image merges attribute, computed style and observed resource sources',async()=>{
    const image=asset('/images/hero.svg');expect(image,'hero missing');
    for(const kind of ['attribute','computedStyle','resource'])expect(image.sources.some(item=>item.kind===kind),'source missing: '+kind);
    expect(initial.assets.filter(item=>item.url===image.url).length===1,'duplicate image');
  });
  await check('stylesheet relative paths, imports, font face and grouping rules',async()=>{
    expect(asset('/fonts/body.woff2')?.kind==='font','font relative path mismatch');
    expect(asset('/styles/nested/extra.css')?.kind==='stylesheet','import missing');
    expect(asset('/styles/images/imported.svg')?.kind==='image','import base URL mismatch');
    expect(asset('/images/grouped.svg')?.sources.some(item=>item.kind==='cssRule'),'grouping rule missing');
  });
  await check('pseudo element image provenance',async()=>{
    expect(asset('/images/before.svg')?.sources.some(item=>item.kind==='computedStyle'&&item.pseudo==='::before'),'pseudo source missing');
  });
  await check('open Shadow DOM and adopted stylesheets',async()=>{
    expect(asset('/images/shadow.svg')?.sources.some(item=>item.kind==='computedStyle'),'shadow image missing');
    expect(asset('/fonts/shadow.woff2')?.kind==='font','adopted font missing');
  });
  await check('inline SVG returns a string with title and path',async()=>{
    const svg=initial.inlineSvgs.find(item=>item.name==='テストのロゴ');expect(svg&&typeof svg.markup==='string','SVG markup is not a string');
    const parsed=new DOMParser().parseFromString(svg.markup,'image/svg+xml');expect(parsed.querySelector('path')&&!parsed.querySelector('parsererror'),'invalid SVG markup');
    expect(svg.markupTruncated===false,'unexpected SVG truncation');
  });
  await check('explicit kind filtering and SVG omission',async()=>{
    const filtered=await list({kinds:['video'],includeInlineSvgs:false});expect(filtered.assets.length===1&&filtered.assets[0].kind==='video','video filter mismatch');expect(filtered.inlineSvgs.length===0,'SVG omission failed');
  });
  await check('asset and element limits are visible',async()=>{
    const limited=await list({limit:1,maxElements:2});expect(limited.assets.length<=1&&limited.limits.assetLimitReached&&limited.limits.elementLimitReached&&limited.truncated,'limits missing');
  });
  await check('large inline SVG and full serialized byte limit',async()=>{
    const large=document.createElementNS('http://www.w3.org/2000/svg','svg');large.style.display='none';large.appendChild(document.createTextNode('日本語'.repeat(15000)));fixture.appendChild(large);
    try {const limited=await list({maxBytes:10000});inventories.bounded=limited;expect(new TextEncoder().encode(JSON.stringify(limited)).length<=10000,'byte limit exceeded');expect(limited.truncated&&limited.limits.outputLimitReached,'large output limit missing');}
    finally {large.remove();}
  });
  await check('unreadable cross-origin stylesheet is reported',async()=>{
    expect(initial.unreadableStylesheets.some(url=>url?.includes('/foreign.css')),'missing inaccessible stylesheet');
  });
  await check('inventory issues no explicit fetch and preserves page markup',async()=>{
    const originalFetch=globalThis.fetch, before=fixture.innerHTML;let calls=0;
    globalThis.fetch=()=>{calls++;throw Error('unexpected inventory fetch');};
    try {const result=await list();expect(calls===0&&result.explicitFetchesRequested===0,'unexpected fetch');expect(fixture.innerHTML===before,'page markup changed');}
    finally {globalThis.fetch=originalFetch;}
  });
  await check('fresh inventory reflects newly displayed content',async()=>{
    const added=document.createElement('img');added.src='/images/later.svg';added.alt='new content';fixture.appendChild(added);await added.decode();
    const next=await list();inventories.afterNewContent=next;
    expect(!asset('/images/later.svg')&&asset('/images/later.svg',next),'new content missing');expect(next.id!==initial.id&&next.pageInstanceId===initial.pageInstanceId,'inventory/document identity mismatch');
  });
  await check('page URL tokens and oversized query are omitted within the byte bound',async()=>{
    const original=location.href;history.replaceState(null,'','?token=dummy-private-token&long='+'x'.repeat(20000));
    try {const result=await list({maxBytes:10000});expect(result.pageUrlRedacted&&!JSON.stringify(result).includes('dummy-private-token'),'page URL token leaked');expect(new TextEncoder().encode(JSON.stringify(result)).length<=10000,'long URL byte limit exceeded');}
    finally {history.replaceState(null,'',original);}
  });
  return {schema:'aos.chrome_companion.page_assets_browser_cases.v1',passed:results.filter(item=>item.passed).length,failed:results.filter(item=>!item.passed).length,cases:results,inventories};
}
