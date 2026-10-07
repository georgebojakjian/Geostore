/* Geostore shop — app logic. Data comes from data.js (+ packs); orders go to your Cloudflare server. */
(function(){
  'use strict';
  var D = window.GEOSTORE_DATA || {settings:{},products:[]};
  var S = D.settings || {};
  var API = String(S.apiUrl || '').replace(/\/+$/, '');
  if (API && !/^https:\/\//.test(API)) API = '';
  var $ = function(id){ return document.getElementById(id); };
  var $$ = function(sel, root){ return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function money(n){ n = Math.round(n * 100) / 100; return '$' + (n % 1 === 0 ? String(n) : n.toFixed(2)); }
  function round2(n){ return Math.round(n * 100) / 100; }
  function safeUrl(u){ u = String(u || ''); return /^https:\/\/[^\s"'<>]+$/.test(u) ? u : ''; }
  function store(k, v){ try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch(e) {} return null; }
  function toast(m){ var t = $('toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(function(){ t.classList.remove('show'); }, 2600); }
  function copyText(t, done){ function ok(){ if (done) done(); } if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(ok, ok); else { try { var a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); } catch(e) {} ok(); } }

  /* ---------------- catalogue data ---------------- */
  var every = (D.products || []).slice(), seen = {};
  every.forEach(function(p){ seen[p.id] = 1; });
  (window.GEOSTORE_PACKS || []).forEach(function(pk){ (pk.products || []).forEach(function(p){ if (!seen[p.id]){ seen[p.id] = 1; every.push(p); } }); });
  every.forEach(function(p){
    p.type = p.type === 'digital' ? 'digital' : 'code';
    if (!p.variants || !p.variants.length) p.variants = [{name:'Standard', sample:p.sample || ''}];
    p.sample = p.variants[0].sample;
  });
  var live = every.filter(function(p){ return p.published !== false; });
  var ALL = live.filter(function(p){ return p.type === 'code'; });
  var WEBS = ALL.filter(function(p){ return p.group === 'website'; });
  var CODES = ALL.filter(function(p){ return p.group !== 'website'; });
  var DIGITAL = live.filter(function(p){ return p.type === 'digital'; });
  var TOPUPS = ((D.gift && D.gift.topups) || []).filter(function(t){ return t && t.id && t.name; });
  var BRANDS = ((D.gift && D.gift.brands) || []).filter(function(b){ return b && b.name && b.regions && b.regions.length; });
  var HOT = String(S.featured || 'itunes,apple,pubg,roblox,google play,steam,playstation,xbox,free fire,netflix,amazon,spotify,razer,fortnite,mobile legends,valorant').toLowerCase().split(',').map(function(x){ return x.trim(); }).filter(Boolean);
  function hotRank(name){ var n = String(name || '').toLowerCase(); for (var i = 0; i < HOT.length; i++) if (n.indexOf(HOT[i]) > -1) return i; return 999; }
  BRANDS.sort(function(a, b){ return hotRank(a.name) - hotRank(b.name) || a.name.localeCompare(b.name); });
  function byId(id){ return live.filter(function(p){ return p.id === id; })[0]; }
  function sp(p){ return +p.stylePrice > 0 ? +p.stylePrice : Math.max(1, Math.ceil(p.price / 2)); }

  document.title = (S.storeName || 'Geostore') + ' — Gift cards, game credit & website code';
  $$('[data-brand]').forEach(function(e){ e.textContent = S.storeName || 'Geostore'; });
  $('year').textContent = new Date().getFullYear();
  $$('[data-contact]').forEach(function(a){ a.href = 'mailto:' + (S.email || ''); });

  var SHELL = document.documentElement.classList.contains('shell'), SCR = $('scr'), SCRSRC = SHELL ? SCR : window;
  function curY(){ return SHELL ? SCR.scrollTop : (window.pageYOffset || 0); }
  /* ---------------- scroll lock + modals ---------------- */
  var lockN = 0, lockY = 0, lastFocus = null, onClose = {};
  function lockScroll(){ if (SHELL){ if (lockN++ === 0){ lockY = SCR.scrollTop; SCR.style.overflowY = 'hidden'; document.body.classList.add('locked'); } return; } if (lockN++ === 0){ lockY = window.pageYOffset || 0; document.body.style.top = (-lockY) + 'px'; document.body.classList.add('locked'); } }
  function unlockScroll(){ if (SHELL){ if (lockN > 0 && --lockN === 0){ document.body.classList.remove('locked'); SCR.style.overflowY = ''; SCR.scrollTop = lockY; } return; } if (lockN > 0 && --lockN === 0){ document.body.classList.remove('locked'); document.body.style.top = ''; window.scrollTo(0, lockY); } }
  function openModal(m, from){
    lastFocus = from || document.activeElement;
    if (!m.classList.contains('open')){ m.classList.add('open'); lockScroll(); }
    m.setAttribute('aria-hidden', 'false');
    if (m.id === 'cartM') { tabOver = 'cart'; if (typeof tabShow === 'function') tabShow(); } else if (m.id === 'acctM') { tabOver = 'acct'; if (typeof tabShow === 'function') tabShow(); }
    var sh = m.querySelector('.sheet'); if (sh) sh.scrollTop = 0;
  }
  function closeModal(m){
    if (!m.classList.contains('open')) return;
    m.classList.remove('open'); m.setAttribute('aria-hidden', 'true'); unlockScroll();
    if (m.id === 'pm'){ demoSeq++; $('pmDemo').srcdoc = ''; fullCache = {}; $('demoWrap').classList.remove('fs'); }
    if (onClose[m.id]) onClose[m.id]();
    if (m.id === 'cartM' || m.id === 'acctM'){ tabOver = null; if (typeof tabShow === 'function') tabShow(); }
    if (lastFocus && lastFocus.focus) try { lastFocus.focus({preventScroll:true}); } catch(e) {}
  }
  $$('.modal').forEach(function(m){ m.addEventListener('click', function(e){ if (e.target === m || e.target.closest('[data-close]')) closeModal(m); }); });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') $$('.modal.open').forEach(closeModal); });

  /* ---------------- theme ---------------- */
  (function(){
    var root = document.documentElement, meta = document.querySelector('meta[name=theme-color]');
    function paint(){ var d = root.getAttribute('data-theme') === 'dark'; $$('[data-theme-toggle]').forEach(function(b){ b.setAttribute('aria-checked', d ? 'true' : 'false'); }); if (meta) meta.setAttribute('content', d ? '#060d08' : '#f3f7ef'); }
    $$('[data-theme-toggle]').forEach(function(b){ b.addEventListener('click', function(){ var n = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; root.setAttribute('data-theme', n); try { localStorage.setItem('geostore_theme', n); } catch(e) {} paint(); }); });
    paint();
  })();

  /* header + liquid bottom bar */
  var tabBase = 'home', tabOver = null, reduceMotion = false;
  try { reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch(e) {}
  var Tab = (function(){
    var bar = $('tabbar'), bg = $('tbPath'), bub = $('tbBubble'), ico = $('tbIco'), items = $$('.tb-it');
    var ICON = {home:'i-home', shop:'i-shop', cart:'i-bag', acct:'i-user'}, IDX = {home:0, shop:1, cart:2, acct:3};
    var W = 0, cx = 0, v = 0, target = 0, raf = 0, key = 'home';
    function path(x){
      var H = bar.clientHeight + 14, top = 14, R = 30, depth = 36;
      x = Math.max(R + 20, Math.min(W - R - 20, x));
      return 'M0,' + top + ' L' + (x - R - 22) + ',' + top +
        ' C' + (x - R - 4) + ',' + top + ' ' + (x - R + 2) + ',' + (top + depth * .15) + ' ' + (x - R + 5) + ',' + (top + depth * .45) +
        ' C' + (x - R + 8) + ',' + (top + depth * .95) + ' ' + (x - 18) + ',' + (top + depth + 2) + ' ' + x + ',' + (top + depth + 2) +
        ' C' + (x + 18) + ',' + (top + depth + 2) + ' ' + (x + R - 8) + ',' + (top + depth * .95) + ' ' + (x + R - 5) + ',' + (top + depth * .45) +
        ' C' + (x + R - 2) + ',' + (top + depth * .15) + ' ' + (x + R + 4) + ',' + top + ' ' + (x + R + 22) + ',' + top +
        ' L' + W + ',' + top + ' L' + W + ',' + H + ' L0,' + H + ' Z';
    }
    function draw(){ bg.setAttribute('d', path(cx)); bub.style.transform = 'translate3d(' + cx + 'px,0,0)'; }
    function step(){
      var dx = target - cx; v += dx * .13; v *= .70; cx += v; draw();
      if (Math.abs(dx) < .4 && Math.abs(v) < .4){ cx = target; v = 0; draw(); raf = 0; return; }
      raf = requestAnimationFrame(step);
    }
    function measure(){ W = bar.clientWidth; target = (IDX[key] + .5) * W / 4; if (!raf){ cx = target; draw(); } }
    function set(k){
      if (!(k in IDX)) return; var changed = k !== key; key = k;
      items.forEach(function(b){ b.classList.toggle('on', b.dataset.k === k); });
      ico.setAttribute('href', '#' + ICON[k]);
      if (changed){ bub.classList.remove('pop'); void bub.offsetWidth; bub.classList.add('pop'); }
      W = bar.clientWidth; if (!W) return; target = (IDX[k] + .5) * W / 4;
      if (reduceMotion || !changed){ cx = target; draw(); } else if (!raf) raf = requestAnimationFrame(step);
    }
    window.addEventListener('resize', measure); window.addEventListener('orientationchange', function(){ setTimeout(measure, 120); });
    setTimeout(function(){ measure(); set('home'); }, 0);
    return {set: set};
  })();
  function tabShow(){ Tab.set(tabOver || tabBase); }
  (function(){                                       // keyboard open: hide the bar only while the on-screen keyboard is really showing
    var vv = window.visualViewport, base = window.innerHeight, on = false;
    function chk(){
      if (!vv) return;
      var open = (base - vv.height) > 140 && /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
      if (open !== on){ on = open; document.body.classList.toggle('typing', open); }
    }
    window.addEventListener('resize', function(){ if (!on) base = Math.max(base, window.innerHeight); chk(); });
    if (vv){ vv.addEventListener('resize', chk); }
    document.addEventListener('focusout', function(){ setTimeout(function(){ if (!/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')){ on = false; document.body.classList.remove('typing'); } }, 150); });
    SCRSRC.addEventListener('scroll', function(){ if (on && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')){ on = false; document.body.classList.remove('typing'); } }, {passive:true});
    window.addEventListener('pageshow', function(){ on = false; document.body.classList.remove('typing'); base = window.innerHeight; });
  })();
  // tapping any bar item first closes an open window, so the bar always works (tapping the open tab again closes it)
  $('tabbar').addEventListener('click', function(e){
    var it = e.target.closest('.tb-it'); if (!it) return;
    var open = $$('.modal.open'); if (!open.length) return;
    var mine = it.hasAttribute('data-opencart') ? 'cartM' : it.hasAttribute('data-openacct') ? 'acctM' : '';
    var same = open.some(function(m){ return m.id === mine; });
    open.forEach(closeModal);
    if (same){ e.stopPropagation(); e.preventDefault(); return; }
    var href = it.getAttribute('href');
    if (href && href.charAt(0) === '#'){            // Home / Shop: scroll after the window has released the page
      e.preventDefault(); var tg = document.querySelector(href);
      setTimeout(function(){ var top = (tg && href !== '#top') ? Math.max(0, tg.getBoundingClientRect().top - (SHELL ? SCR.getBoundingClientRect().top : 0) + curY() - 56) : 0; (SHELL ? SCR : window).scrollTo({top: top, behavior: 'smooth'}); }, 30);
    }
  }, true);
  (function(){
    var hdr = $('hdr'), shop = $('shop'), tick = false;
    function upd(){ tick = false; var y = curY(); hdr.classList.toggle('scrolled', y > 8); var nb = y > shop.offsetTop - 160 ? 'shop' : 'home'; if (nb !== tabBase){ tabBase = nb; tabShow(); } }
    SCRSRC.addEventListener('scroll', function(){ if (!tick){ tick = true; requestAnimationFrame(upd); } }, {passive:true}); upd();
  })();

  /* ---------------- images (logos / flags) ---------------- */
  document.addEventListener('error', function(e){
    var t = e.target; if (!t || t.tagName !== 'IMG') return;
    if (t.classList.contains('flag')){ var s = document.createElement('span'); s.className = 'flag ph'; s.textContent = t.getAttribute('data-c') || '🌍'; t.replaceWith(s); }
    else if (t.hasAttribute('data-ph')){ var sp2 = document.createElement('span'); sp2.textContent = t.getAttribute('data-ph'); t.replaceWith(sp2); }
  }, true);
  function logoHTML(url, name){
    var u = safeUrl(url), ph = esc((name || '?').trim().charAt(0).toUpperCase());
    return u ? '<img src="' + esc(u) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-ph="' + ph + '">' : '<span>' + ph + '</span>';
  }
  var regionNames = null;
  try { regionNames = new Intl.DisplayNames(['en'], {type:'region'}); } catch(e) {}
  function regionLabel(code){
    code = String(code || '').toUpperCase();
    if (!code || code === 'GLOBAL') return 'Global';
    if (code === 'EU') return 'Europe';
    try { return (regionNames && regionNames.of(code)) || code; } catch(e) { return code; }
  }
  function flagHTML(code){
    code = String(code || '').toLowerCase();
    if (!/^[a-z]{2}$/.test(code)) return '<span class="flag ph">🌍</span>';
    return '<img class="flag" src="https://flagcdn.com/w80/' + code + '.png" alt="" loading="lazy" referrerpolicy="no-referrer" data-c="' + code.toUpperCase() + '">';
  }

  /* ---------------- lazy previews for code / website cards ---------------- */
  var prevIO = ('IntersectionObserver' in window) ? new IntersectionObserver(function(es){
    es.forEach(function(e){ if (e.isIntersecting){ prevIO.unobserve(e.target); mountPreview(e.target); } });
  }, {rootMargin:'250px'}) : null;
  function mountPreview(w){
    if (w.getAttribute('data-ok')) return; w.setAttribute('data-ok', '1');
    var p = byId(w.dataset.id); if (!p) return;
    var f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts'); f.tabIndex = -1; f.setAttribute('aria-hidden', 'true'); f.title = 'Preview of ' + p.title; f.srcdoc = p.sample;
    w.appendChild(f); scaleOne(w);
  }
  function scaleOne(w){
    var f = w.querySelector('iframe'); if (!f) return;
    var W = +w.dataset.w || 800, s = w.clientWidth / W;
    f.style.width = W + 'px'; f.style.transform = 'scale(' + s + ')'; f.style.height = (w.clientHeight / s) + 'px';
  }
  function scalePreviews(){ $$('.prev[data-ok]').forEach(scaleOne); }
  window.addEventListener('resize', scalePreviews);
  function watchPreviews(root){ $$('.prev:not([data-ok])', root).forEach(function(w){ prevIO ? prevIO.observe(w) : mountPreview(w); }); }

  var rvIO = ('IntersectionObserver' in window) ? new IntersectionObserver(function(es){ es.forEach(function(e){ if (e.isIntersecting){ e.target.classList.add('in'); rvIO.unobserve(e.target); } }); }, {threshold:.1}) : null;
  $$('.rv').forEach(function(el){ rvIO ? rvIO.observe(el) : el.classList.add('in'); });

  /* ---------------- shop: tabs, chips, grids ---------------- */
  var tab = null, q = '';
  var tabs = [];
  if (BRANDS.length || DIGITAL.length || TOPUPS.length) tabs.push({id:'gift', label:'Gift cards & games', n:BRANDS.length + DIGITAL.length + TOPUPS.length});
  if (WEBS.length) tabs.push({id:'sites', label:'Websites', n:WEBS.length});
  if (CODES.length) tabs.push({id:'code', label:'Code', n:CODES.length});
  function showTab(id){
    tab = id;
    $$('#seg button').forEach(function(b){ b.classList.toggle('on', b.dataset.t === id); b.setAttribute('aria-selected', b.dataset.t === id ? 'true' : 'false'); });
    ['gift','sites','code'].forEach(function(t){ var el = $('panel' + t.charAt(0).toUpperCase() + t.slice(1)); if (el) el.hidden = t !== id; });
    if (id === 'gift') renderGift(); if (id === 'sites') renderWebs(); if (id === 'code') renderCodes();
  }
  $('seg').innerHTML = tabs.map(function(t){ return '<button type="button" role="tab" data-t="' + t.id + '">' + esc(t.label) + '<b>' + t.n + '</b></button>'; }).join('');
  $('seg').hidden = tabs.length < 2;
  $('seg').addEventListener('click', function(e){ var b = e.target.closest('button[data-t]'); if (b) showTab(b.dataset.t); });
  $('navGift').hidden = !tabs.some(function(t){ return t.id === 'gift'; });
  $('navSites').hidden = !WEBS.length; $('navCode').hidden = !CODES.length;
  $$('[data-tabgo]').forEach(function(a){ a.addEventListener('click', function(){ $('q').value = ''; q = ''; applySearch(); if (tabs.some(function(t){ return t.id === a.dataset.tabgo; })) showTab(a.dataset.tabgo); }); });

  function chipRow(el, list, cur, attr){
    el.innerHTML = list.map(function(c){ return '<button type="button" class="chip' + (c === cur ? ' on' : '') + '" ' + attr + '="' + esc(c) + '">' + esc(c) + '</button>'; }).join('');
    el.hidden = list.length < 3;
  }
  /* code snippets */
  var cat = 'All', shown = 9;
  var cats = ['All']; CODES.forEach(function(p){ if (p.category && cats.indexOf(p.category) < 0) cats.push(p.category); });
  chipRow($('chips'), cats, cat, 'data-c');
  $('chips').addEventListener('click', function(e){ var b = e.target.closest('.chip'); if (!b) return; cat = b.dataset.c; chipRow($('chips'), cats, cat, 'data-c'); shown = 9; renderCodes(); });
  function cardHTML(p, wide){
    var multi = p.variants.length > 1;
    return '<article class="card rv" data-open="' + esc(p.id) + '"><div class="prev" data-id="' + esc(p.id) + '" data-w="' + (wide ? 1200 : 800) + '"><span class="tag">' + esc(p.category || 'Code') + '</span>' + (multi ? '<span class="tag r">' + p.variants.length + ' styles</span>' : (p.files && p.files.length ? '<span class="tag r">📦 Project files</span>' : '')) + '</div>' +
      '<div class="cbody"><h3>' + esc(p.title) + '</h3><p>' + esc(p.tagline || '') + '</p><div class="crow"><span class="price">' + money(p.price) + (multi ? '<small>all styles</small>' : '') + '</span><span class="btns"><button type="button" class="btn btn-ghost btn-sm" data-view="' + esc(p.id) + '">Preview</button><button type="button" class="btn btn-primary btn-sm" data-add="' + esc(p.id) + '">Add</button></span></div></div></article>';
  }
  function renderCodes(){
    var all = CODES.filter(function(p){ return cat === 'All' || p.category === cat; });
    $('more').hidden = all.length <= shown; $('more').textContent = 'Show more (' + (all.length - shown) + ' more)';
    $('grid').innerHTML = all.slice(0, shown).map(function(p){ return cardHTML(p); }).join('') || '<p class="empty">Nothing here yet.</p>';
    watchPreviews($('grid')); $$('#grid .rv').forEach(function(e){ e.classList.add('in'); });
  }
  $('more').addEventListener('click', function(){ shown += 9; renderCodes(); });
  /* websites */
  var wshown = 6;
  function renderWebs(){
    $('wMore').hidden = WEBS.length <= wshown; $('wMore').textContent = 'Show more websites (' + (WEBS.length - wshown) + ' more)';
    $('wgrid').innerHTML = WEBS.slice(0, wshown).map(function(p){ return cardHTML(p, true); }).join('');
    watchPreviews($('wgrid')); $$('#wgrid .rv').forEach(function(e){ e.classList.add('in'); });
  }
  $('wMore').addEventListener('click', function(){ wshown += 6; renderWebs(); });
  function clickGrid(e){
    var v = e.target.closest('[data-view]'), a = e.target.closest('[data-add]'), c = e.target.closest('[data-open]');
    if (v){ e.stopPropagation(); return openProduct(byId(v.dataset.view), v); }
    if (a){ e.stopPropagation(); addToCart(a.dataset.add, 'all'); return openCart(a); }
    if (c) openProduct(byId(c.dataset.open), c);
  }
  $('grid').addEventListener('click', clickGrid); $('wgrid').addEventListener('click', clickGrid);

  /* gift cards: brand tiles + other digital items */
  var gcat = 'All', gshown = 24;
  function giftCats(){ var l = ['All']; BRANDS.forEach(function(b){ var c = b.cat || 'Gift cards'; if (l.indexOf(c) < 0) l.push(c); }); return l; }
  function brandTile(b){
    var n = b.regions.length;
    return '<button type="button" class="brand-tile" data-brand-id="' + esc(b.id || b.name) + '"><span class="logo-box">' + logoHTML(b.logo, b.name) + '</span><b>' + esc(b.name) + '</b><small>' + (n > 1 ? n + ' regions' : esc(regionLabel(b.regions[0].region))) + '</small></button>';
  }
  function topupTile(t){
    return '<button type="button" class="brand-tile" data-topup="' + esc(t.id) + '"><span class="logo-box">' + logoHTML(t.logo, t.name) + '</span><b>' + esc(t.name) + '</b><small>Game top-up</small></button>';
  }
  function digitalTile(p){
    return '<button type="button" class="brand-tile" data-dbuy="' + esc(p.id) + '"><span class="logo-box">' + (safeUrl(p.icon) ? logoHTML(p.icon, p.title) : '<span style="font-size:2rem">' + esc(p.icon || '🎁') + '</span>') + '</span><b>' + esc(p.title) + '</b><small>' + money(p.price) + ' · tap to add</small></button>';
  }
  function renderGift(){
    var cl = giftCats(); chipRow($('gChips'), cl, gcat, 'data-g');
    var list = BRANDS.filter(function(b){ return gcat === 'All' || (b.cat || 'Gift cards') === gcat; });
    $('gMore').hidden = list.length <= gshown; $('gMore').textContent = 'Show more (' + (list.length - gshown) + ' more)';
    $('brands').innerHTML = list.slice(0, gshown).map(brandTile).join('');
    $('brands').hidden = !list.length;
    $('dgrid').className = 'brands'; $('dgrid').innerHTML = gcat === 'All' ? TOPUPS.slice(0, 12).map(topupTile).join('') + DIGITAL.slice(0, 8).map(digitalTile).join('') : '';
  }
  function renderBest(){
    var hot = BRANDS.filter(function(b){ return hotRank(b.name) < 999; }).map(function(b){ return {r:hotRank(b.name), h:brandTile(b)}; })
      .concat(TOPUPS.filter(function(t){ return hotRank(t.name) < 999; }).map(function(t){ return {r:hotRank(t.name), h:topupTile(t)}; }))
      .sort(function(a, b){ return a.r - b.r; }).slice(0, 10);
    $('bestGrid').innerHTML = hot.map(function(x){ return x.h; }).join(''); $('bestSec').hidden = !hot.length;
  }
  $('bestGrid').addEventListener('click', function(e){ clickTiles(e); });
  $('gChips').addEventListener('click', function(e){ var b = e.target.closest('.chip'); if (!b) return; gcat = b.dataset.g; gshown = 24; renderGift(); });
  $('gMore').addEventListener('click', function(){ gshown += 24; renderGift(); });
  function clickTiles(e){
    var tp = e.target.closest('[data-topup]'); if (tp){ var tg2 = TOPUPS.filter(function(x){ return x.id === tp.dataset.topup; })[0]; if (tg2) openTopup(tg2, tp); return; }
    var b = e.target.closest('[data-brand-id]'), d = e.target.closest('[data-dbuy]');
    if (b){ var br = BRANDS.filter(function(x){ return String(x.id || x.name) === b.dataset.brandId; })[0]; if (br) openGift(br, b); }
    if (d){ addToCart(d.dataset.dbuy, 'all'); openCart(d); }
  }
  $('brands').addEventListener('click', clickTiles); $('dgrid').addEventListener('click', clickTiles);

  /* ---------------- full catalogue: search + filters ---------------- */
  var CM = {type:'all', cat:'All', q:'', sort:'pop', shown:40};
  var TYPES = [['all','All'],['gift','Gift cards'],['topup','Game top-ups'],['digital','Digital'],['web','Websites'],['code','Code']];
  function allItems(){
    var out = [];
    BRANDS.forEach(function(b){ out.push({k:'gift', name:b.name, cat:b.cat || 'Gift cards', rank:hotRank(b.name), html:brandTile(b), price:null}); });
    TOPUPS.forEach(function(t){ out.push({k:'topup', name:t.name, cat:'Game top-ups', rank:hotRank(t.name), html:topupTile(t), price:null}); });
    DIGITAL.forEach(function(p){ out.push({k:'digital', name:p.title, cat:'Digital', rank:998, html:digitalTile(p), price:+p.price}); });
    function pt(p, kind){ return '<button type="button" class="brand-tile" data-open="' + esc(p.id) + '"><span class="logo-box"><span>' + esc((p.title || '?').charAt(0).toUpperCase()) + '</span></span><b>' + esc(p.title) + '</b><small>' + esc(p.category || kind) + '</small><span class="pr">' + money(p.price) + '</span></button>'; }
    WEBS.forEach(function(p){ out.push({k:'web', name:p.title, cat:p.category || 'Websites', rank:997, html:pt(p, 'Website'), price:+p.price}); });
    CODES.forEach(function(p){ out.push({k:'code', name:p.title, cat:p.category || 'Code', rank:997, html:pt(p, 'Code'), price:+p.price}); });
    return out;
  }
  var CMALL = null;
  function renderCatalog(){
    if (!CMALL) CMALL = allItems();
    var term = CM.q.trim().toLowerCase();
    var base = CMALL.filter(function(x){ return CM.type === 'all' || x.k === CM.type; });
    var cats = ['All']; base.forEach(function(x){ if (cats.indexOf(x.cat) < 0) cats.push(x.cat); });
    if (cats.indexOf(CM.cat) < 0) CM.cat = 'All';
    var counts = {}; CMALL.forEach(function(x){ counts[x.k] = (counts[x.k] || 0) + 1; });
    $('cmTypes').innerHTML = TYPES.filter(function(t){ return t[0] === 'all' || counts[t[0]]; }).map(function(t){ return '<button type="button" class="chip' + (CM.type === t[0] ? ' on' : '') + '" data-ct="' + t[0] + '">' + t[1] + ' (' + (t[0] === 'all' ? CMALL.length : counts[t[0]]) + ')</button>'; }).join('');
    $('cmCats').innerHTML = cats.length > 2 ? cats.map(function(c){ return '<button type="button" class="chip' + (CM.cat === c ? ' on' : '') + '" data-cc="' + esc(c) + '">' + esc(c) + '</button>'; }).join('') : ''; $('cmCats').hidden = cats.length <= 2;
    var list = base.filter(function(x){ return (CM.cat === 'All' || x.cat === CM.cat) && (!term || (x.name + ' ' + x.cat).toLowerCase().indexOf(term) > -1); });
    list.sort(function(a2, b2){
      if (CM.sort === 'az') return a2.name.localeCompare(b2.name);
      if (CM.sort === 'lo' || CM.sort === 'hi'){ var pa = a2.price == null ? 1e9 : a2.price, pb = b2.price == null ? 1e9 : b2.price; return CM.sort === 'lo' ? pa - pb : (b2.price == null ? -1 : 0) || pb - pa; }
      return a2.rank - b2.rank || a2.name.localeCompare(b2.name);
    });
    $('cmCount').textContent = list.length + (list.length === 1 ? ' product' : ' products');
    $('cmGrid').innerHTML = list.slice(0, CM.shown).map(function(x){ return x.html; }).join('') || '<p class="empty" style="grid-column:1/-1">Nothing matches. Try another word or filter.</p>';
    $('cmMore').hidden = list.length <= CM.shown; $('cmMore').textContent = 'Show more (' + (list.length - CM.shown) + ' more)';
  }
  $('allCount').textContent = '(' + (BRANDS.length + TOPUPS.length + DIGITAL.length + WEBS.length + CODES.length) + ')';
  $('allBtn').addEventListener('click', function(){ CM = {type:'all', cat:'All', q:'', sort:'pop', shown:40}; $('cmQ').value = ''; $('cmSort').value = 'pop'; renderCatalog(); openModal($('cm'), $('allBtn')); });
  var cmT = null;
  $('cmQ').addEventListener('input', function(){ clearTimeout(cmT); var v = this.value; cmT = setTimeout(function(){ CM.q = v; CM.shown = 40; renderCatalog(); }, 160); });
  $('cmSort').addEventListener('change', function(){ CM.sort = this.value; renderCatalog(); });
  $('cmTypes').addEventListener('click', function(e){ var b = e.target.closest('[data-ct]'); if (!b) return; CM.type = b.dataset.ct; CM.cat = 'All'; CM.shown = 40; renderCatalog(); });
  $('cmCats').addEventListener('click', function(e){ var b = e.target.closest('[data-cc]'); if (!b) return; CM.cat = b.dataset.cc; CM.shown = 40; renderCatalog(); });
  $('cmMore').addEventListener('click', function(){ CM.shown += 40; renderCatalog(); });
  $('cmGrid').addEventListener('click', function(e){ clickGrid(e); clickTiles(e); });

  /* search across everything */
  function applySearch(){
    var term = q.trim().toLowerCase(), box = $('results');
    if (term.length < 2){ box.hidden = true; $('bestSec').hidden = !$('bestGrid').children.length; $('panels').hidden = false; $('seg').hidden = tabs.length < 2; return; }
    $('panels').hidden = true; $('seg').hidden = true; $('bestSec').hidden = true; box.hidden = false;
    function has(s){ return String(s || '').toLowerCase().indexOf(term) > -1; }
    var tpm = TOPUPS.filter(function(t){ return has(t.name) || has('top up') && has(t.name); });
    var gb = BRANDS.filter(function(b){ return has(b.name) || has(b.cat); }), dg = DIGITAL.filter(function(p){ return has(p.title) || has(p.tagline); });
    var wb = WEBS.filter(function(p){ return has(p.title) || has(p.tagline) || has(p.category); }), cd = CODES.filter(function(p){ return has(p.title) || has(p.tagline) || has(p.category); });
    var html = '';
    if (gb.length || dg.length || tpm.length) html += '<h2 class="sh" style="font-size:1.15rem">Gift cards &amp; digital</h2><div class="brands" style="margin-bottom:22px">' + tpm.slice(0, 8).map(topupTile).join('') + gb.slice(0, 15).map(brandTile).join('') + dg.slice(0, 8).map(digitalTile).join('') + '</div>';
    if (wb.length) html += '<h2 class="sh" style="font-size:1.15rem">Websites</h2><div class="grid sites" style="margin-bottom:22px">' + wb.slice(0, 6).map(function(p){ return cardHTML(p, true); }).join('') + '</div>';
    if (cd.length) html += '<h2 class="sh" style="font-size:1.15rem">Code</h2><div class="grid" style="margin-bottom:22px">' + cd.slice(0, 9).map(function(p){ return cardHTML(p); }).join('') + '</div>';
    box.innerHTML = html || '<p class="empty">Nothing matches “' + esc(q.trim()) + '”. Try another word.</p>';
    watchPreviews(box); $$('.rv', box).forEach(function(e){ e.classList.add('in'); });
  }
  $('results').addEventListener('click', function(e){ clickGrid(e); clickTiles(e); });
  var qT = null;
  $('q').addEventListener('input', function(){ q = this.value; clearTimeout(qT); qT = setTimeout(applySearch, 120); });

  /* all-access */
  var AA = S.allAccess;
  if (AA && AA.enabled && ALL.length){
    $('pass').hidden = false; $('passTitle').textContent = AA.title || 'All-Access Pass'; $('passDesc').textContent = AA.description || 'Every code and website, plus every new one.';
    $('passPrice').textContent = money(AA.price);
    $('passBuy').addEventListener('click', function(){ addToCart('ALL', 'all'); openCart(); });
  }

  /* ---------------- product window (code / website) ---------------- */
  function guardFn(){
    var t;
    function note(m){var n=document.getElementById('__dm');if(!n){n=document.createElement('div');n.id='__dm';n.style.cssText='position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;background:#111;color:#fff;border:1px solid #8cf04d;padding:10px 16px;border-radius:99px;font:600 13px system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5);max-width:92vw;text-align:center;opacity:0;transition:opacity .2s;pointer-events:none';document.body.appendChild(n)}n.textContent=m;n.style.opacity=1;clearTimeout(t);t=setTimeout(function(){n.style.opacity=0},2800)}
    document.addEventListener('click',function(e){
      var a=e.target.closest&&e.target.closest('a[href]');if(!a)return;
      var h=a.getAttribute('href')||'';
      if(h.length>1&&h.charAt(0)==='#'){e.preventDefault();var el=document.getElementById(h.slice(1));if(el)el.scrollIntoView({behavior:'smooth'});else note('Demo: this link has no page in the preview');return}
      e.preventDefault();
      note(h==='#'||h===''?'Demo link — in your real site this goes to your own page':'Demo: this link goes to another page ('+h.slice(0,40)+') that you add in your real site');
    },true);
    document.addEventListener('submit',function(e){if(!e.defaultPrevented){e.preventDefault();note('Demo form — connect it to your email or server in your real site')}});
    window.open=function(u){note('Demo: this would open '+String(u||'a new page').slice(0,50)+' in your real site');return null};
  }
  function guard(html){
    html = String(html || '');
    var g = '<script>(' + guardFn.toString() + ')()<\/script>', i = html.lastIndexOf('</body>');
    return i < 0 ? html + g : html.slice(0, i) + g + html.slice(i);
  }
  /* runs INSIDE the preview frame: view-only protection (a deterrent — it cannot stop a determined developer) */
  function protectFn(){
    var st = document.createElement('style');
    st.textContent = '*{-webkit-user-select:none!important;user-select:none!important;-webkit-touch-callout:none!important}input,textarea{-webkit-user-select:text!important;user-select:text!important}@media print{html{display:none!important}}';
    document.head.appendChild(st);
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='260' height='170'><text x='20' y='95' transform='rotate(-24 130 85)' font-family='Arial,sans-serif' font-size='17' font-weight='700' fill='%23888' fill-opacity='.9'>GEOSTORE PREVIEW</text></svg>";
    var w = document.createElement('div');
    w.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;opacity:.10;background-image:url("data:image/svg+xml,' + svg.replace(/#/g, '%23') + '")';
    document.body.appendChild(w);
    function inField(e){ return /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || ''); }
    ['contextmenu','copy','cut','dragstart','selectstart'].forEach(function(n){ document.addEventListener(n, function(e){ if (n !== 'contextmenu' && inField(e)) return; e.preventDefault(); }, true); });
    document.addEventListener('keydown', function(e){
      var k = String(e.key || '').toLowerCase(), m = e.ctrlKey || e.metaKey;
      if (k === 'f12' || (m && (k === 's' || k === 'u' || k === 'p' || (!inField(e) && (k === 'c' || k === 'a' || k === 'x'))) || (m && e.shiftKey && (k === 'i' || k === 'j' || k === 'c')))) e.preventDefault();
    }, true);
  }
  function protect(html){
    var g = '<script>(' + protectFn.toString() + ')()<\/script>', i = html.lastIndexOf('</body>');
    return i < 0 ? html + g : html.slice(0, i) + g + html.slice(i);
  }
  var cur = null, curV = 0, opt = 'all', fullCache = {}, demoSeq = 0;
  function loadFull(p, i){
    if (!API || p.type === 'digital') return Promise.resolve(null);
    var k = p.id + '/' + i; if (fullCache[k]) return Promise.resolve(fullCache[k]);
    return fetch(API + '/api/preview/' + encodeURIComponent(p.id) + '/' + i).then(function(r){ return r.ok ? r.json() : null; }).then(function(j){
      if (!j || !j.k || !j.d) return null;
      var bin = atob(j.d), a = new Uint8Array(bin.length), kk = j.k;
      for (var x = 0; x < bin.length; x++) a[x] = bin.charCodeAt(x) ^ kk.charCodeAt(x % kk.length);
      return (fullCache[k] = new TextDecoder().decode(a));
    }).catch(function(){ return null; });
  }
  function loadDemo(p, i, v){
    var my = ++demoSeq;
    if (!API){ $('pmDemo').srcdoc = guard(v.sample); return; }
    $('pmLoad').hidden = false; $('pmDemo').srcdoc = '';
    loadFull(p, i).then(function(h){ if (my !== demoSeq) return; $('pmLoad').hidden = true; $('pmDemo').srcdoc = h ? guard(protect(h)) : guard(v.sample); });
  }
  function showVariant(i){
    curV = i; loadDemo(cur, i, cur.variants[i]);
    $$('#pmVars .vt').forEach(function(b, k){ b.classList.toggle('on', k === i); });
    renderOpts();
  }
  function renderOpts(){
    var n = cur.variants.length; $('pmOpts').hidden = n < 2;
    if (n < 2){ opt = 'all'; return; }
    $('pmOpts').innerHTML =
      '<label class="op"><input type="radio" name="opt" value="all"' + (opt === 'all' ? ' checked' : '') + '><span>All ' + n + ' styles <b>' + money(cur.price) + '</b><small>best value</small></span></label>' +
      '<label class="op"><input type="radio" name="opt" value="one"' + (opt === 'one' ? ' checked' : '') + '><span>Only “' + esc(cur.variants[curV].name) + '” <b>' + money(sp(cur)) + '</b><small>one style</small></span></label>';
  }
  $('pmOpts').addEventListener('change', function(e){ if (e.target.name === 'opt') opt = e.target.value; });
  function openProduct(p, from){
    if (!p) return;
    cur = p; opt = 'all';
    $('pmTitle').textContent = p.title; $('pmSub').textContent = (p.category ? p.category + ' · ' : '') + (p.tagline || '');
    var pf = $('pmFiles'); pf.hidden = !(p.files && p.files.length); pf.textContent = pf.hidden ? '' : '📦 Includes: ' + p.files.map(function(f){ return f.name + (f.size ? ' (' + (f.size > 1048576 ? (f.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(f.size / 1024)) + ' KB') + ')' : ''); }).join(' · ') + ' — downloadable after payment';
    $('pmVars').hidden = p.variants.length < 2;
    $('pmVars').innerHTML = p.variants.map(function(v, k){ return '<button type="button" class="vt' + (k === 0 ? ' on' : '') + '" data-v="' + k + '">' + esc(v.name) + '</button>'; }).join('');
    $('pmGuideTab').hidden = !p.guide; $('pmGuide').innerHTML = p.guide || '';
    $('pmHint').textContent = p.variants.length > 1 ? 'Every style is shown in full. Buying unlocks the complete code.' : 'Buying unlocks the complete code.';
    $('pmDemo').className = 'demo' + (p.group === 'website' ? ' tall' : ''); $('demoWrap').classList.remove('fs'); $('pmFs').textContent = '⛶ Full screen';
    showVariant(0); showPmTab('demo'); openModal($('pm'), from);
  }
  $('pmVars').addEventListener('click', function(e){ var b = e.target.closest('.vt'); if (b) showVariant(+b.dataset.v); });
  function showPmTab(t){ $$('#pm .tab').forEach(function(b){ b.classList.toggle('on', b.dataset.tab === t); }); $('demoWrap').hidden = t !== 'demo'; $('demoNote').hidden = t !== 'demo'; $('pmGuide').hidden = t !== 'guide'; }
  $$('#pm .tab').forEach(function(b){ b.addEventListener('click', function(){ showPmTab(b.dataset.tab); }); });
  $('pmFs').addEventListener('click', function(){ var w = $('demoWrap'), on = w.classList.toggle('fs'); this.textContent = on ? '✕ Close full screen' : '⛶ Full screen'; });
  function chosen(){ return opt === 'one' && cur.variants.length > 1 ? curV : 'all'; }
  $('pmAdd').addEventListener('click', function(){ addToCart(cur.id, chosen()); });
  $('pmBuy').addEventListener('click', function(){ addToCart(cur.id, chosen(), true); closeModal($('pm')); openCart(); });

  /* ---------------- gift sheet: regions -> amounts ---------------- */
  var gb = null, gr = null;
  /* game top-up: Player ID form + amounts */
  var tcur = null, tdef = null;
  function openTopup(g, from){
    tcur = g; gb = null;
    $('gmTitle').textContent = g.name; $('gmLogo').innerHTML = logoHTML(g.logo, g.name); $('gmSub').textContent = 'Game top-up · enter your Player ID';
    $('gmBody').innerHTML = '<div class="empty"><div class="spin" style="margin:0 auto 10px"></div>Loading…</div>';
    openModal($('gm'), from);
    apiCall('/api/topup/offers?cat=' + encodeURIComponent(g.id)).then(function(r){
      if (tcur !== g) return; tdef = r;
      var f = (r.fields || []).map(function(d){
        return '<div class="field"><label for="tf_' + esc(d.key) + '">' + esc(d.label) + '</label>' + (d.type === 'select' && d.options.length ? '<select id="tf_' + esc(d.key) + '" data-tf="' + esc(d.key) + '">' + d.options.map(function(o){ return '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>'; }).join('') + '</select>' : '<input id="tf_' + esc(d.key) + '" data-tf="' + esc(d.key) + '" autocomplete="off" maxlength="80" inputmode="text">') + '</div>';
      }).join('');
      $('gmBody').innerHTML = f + '<div class="actions" style="margin:-4px 0 10px"><span class="hint" id="tpCheckMsg">Double-check your ID — a top-up cannot be reversed.</span>' + (r.canCheck ? '<span class="ab"><button type="button" class="btn btn-ghost btn-sm" id="tpCheck">Check my ID</button></span>' : '') + '</div>' +
        '<div class="amounts">' + (r.offers || []).map(function(o){ return '<button type="button" class="amt" data-to="' + esc(o.offer) + '" data-tp="' + (+o.price) + '" data-tn="' + esc(o.name) + '"><b>' + esc(o.name) + '</b><span class="p">' + money(o.price) + '</span><small>Add to cart</small></button>'; }).join('') + '</div>';
    }).catch(function(er){ if (tcur !== g) return; $('gmBody').innerHTML = '<p class="empty">' + esc(er.message || 'Could not load.') + '</p>'; });
  }
  function topupVals(){ var v = {}, bad = ''; $$('#gmBody [data-tf]').forEach(function(el){ v[el.dataset.tf] = el.value.trim(); if (!el.value.trim()) bad = el.previousElementSibling ? el.previousElementSibling.textContent : el.dataset.tf; }); return {v:v, bad:bad}; }
  $('gmBody').addEventListener('click', function(e){
    if (!tcur) return;
    var chk = e.target.closest('#tpCheck'), a = e.target.closest('[data-to]');
    if (chk){
      var t = topupVals(); if (t.bad){ $('tpCheckMsg').textContent = 'Please fill in “' + t.bad + '”.'; return; }
      $('tpCheckMsg').textContent = 'Checking…';
      apiCall('/api/topup/validate', {cat: tcur.id, fields: t.v}).then(function(r){ $('tpCheckMsg').textContent = r.valid === true ? '✅ Found' + (r.player ? ': ' + r.player : '') + (r.region ? ' (' + r.region + ')' : '') : r.valid === false ? '⚠ ID not found — check it again' : 'We could not check it right now — please double-check your ID before paying.'; }).catch(function(er){ $('tpCheckMsg').textContent = er.message; });
      return;
    }
    if (a){
      var t2 = topupVals(); if (t2.bad){ $('tpCheckMsg').textContent = 'Please fill in “' + t2.bad + '” first.'; toast('Fill in your Player ID first'); return; }
      var id = 't:' + tcur.id + ':' + a.dataset.to, ex = cart.filter(function(i){ return i.id === id; })[0];
      if (ex){ ex.f = t2.v; ex.p = +a.dataset.tp; } else cart.push({id:id, v:'all', t:tcur.name + ' — ' + a.dataset.tn, p:+a.dataset.tp, q:1, m:1, f:t2.v});
      saveCart(); toast(ex ? 'Cart updated' : 'Added to cart');
    }
  });
  function openGift(b, from){
    gb = b; gr = null; tcur = null;
    $('gmTitle').textContent = b.name; $('gmLogo').innerHTML = logoHTML(b.logo, b.name);
    var regs = b.regions.slice().sort(function(x, y){ var a = String(x.region || '').toUpperCase(), c = String(y.region || '').toUpperCase(); if (a === 'US') return -1; if (c === 'US') return 1; return regionLabel(a).localeCompare(regionLabel(c)); });
    gb._regs = regs;
    openModal($('gm'), from);
    if (regs.length === 1) showAmounts(regs[0]); else showRegions();
  }
  function showRegions(){
    gr = null; $('gmSub').textContent = 'Choose your region';
    $('gmBody').innerHTML = '<div class="regions">' + gb._regs.map(function(r, i){ return '<button type="button" class="region" data-r="' + i + '">' + flagHTML(r.region) + '<span>' + esc(regionLabel(r.region)) + '</span></button>'; }).join('') + '</div><p class="note">Pick the country your account or store is in. A card only works in its own region.</p>';
  }
  function showAmounts(r){
    gr = r; var multi = gb._regs.length > 1;
    $('gmSub').innerHTML = (multi ? flagHTML(r.region) + ' ' : '') + esc(regionLabel(r.region)) + ' · choose an amount';
    $('gmBody').innerHTML = (multi ? '<button type="button" class="back" data-back>← Regions</button>' : '') + '<div id="gmAmts"><div class="empty"><div class="spin" style="margin:0 auto 10px"></div>Loading amounts…</div></div><div class="actions"><span class="hint" id="gmHint"></span><span class="ab"><button type="button" class="btn btn-primary" id="gmCart" hidden>View cart</button></span></div>';
    syncGiftCart();
    if (!API){ $('gmAmts').innerHTML = '<p class="empty">Gift cards need the payment server to be connected.</p>'; return; }
    apiCall('/api/gift/offers?cat=' + encodeURIComponent(r.cat)).then(function(j){
      if (gr !== r) return;
      var off = (j.offers || []).slice().sort(function(a, b){ return a.price - b.price; });
      $('gmAmts').innerHTML = off.length ? '<div class="amounts">' + off.map(function(o){
        var id = 'g:' + r.cat + ':' + o.card, ci = cart.filter(function(i){ return i.id === id; })[0], mx = Math.max(1, o.max || 10), q0 = ci ? Math.min(ci.q || 1, mx) : 1;
        return '<div class="amt' + (ci ? ' added' : '') + (o.inStock ? '' : ' off') + '" data-gid="' + esc(id) + '" data-gt="' + esc(j.name + ' — ' + o.name) + '" data-gp="' + o.price + '" data-gm="' + mx + '"><b>' + esc(o.name) + '</b><span class="p">' + money(o.price) + '</span><small>' + (o.inStock ? (ci ? '✓ in your cart ×' + ci.q : 'Instant delivery') : 'Out of stock') + '</small>' +
          (o.inStock ? '<div class="qrow"><span class="qty"><button type="button" data-qd aria-label="Fewer">−</button><b data-qv>' + q0 + '</b><button type="button" data-qu aria-label="More">+</button></span><button type="button" class="addb" data-add>' + (ci ? 'Update' : 'Add') + '</button></div>' : '') + '</div>';
      }).join('') + '</div>' : '<p class="empty">No amounts available right now. Please check back soon.</p>';
    }).catch(function(er){ if (gr !== r) return; $('gmAmts').innerHTML = '<p class="empty">' + esc(er.message || 'Could not load amounts.') + '<br><br><button type="button" class="btn btn-ghost btn-sm" data-retry>Try again</button></p>'; });
  }
  function syncGiftCart(){ var b = $('gmCart'); if (!b) return; var n = lines().length; b.hidden = !n; b.textContent = 'View cart (' + n + ')'; }
  $('gmBody').addEventListener('click', function(e){
    if (tcur) return;
    var r = e.target.closest('[data-r]'), bk = e.target.closest('[data-back]'), rt = e.target.closest('[data-retry]'), card = e.target.closest('.amt');
    if (r) showAmounts(gb._regs[+r.dataset.r]);
    if (bk) showRegions();
    if (rt && gr) showAmounts(gr);
    if (card && !card.classList.contains('off')){
      var qv = card.querySelector('[data-qv]'), mx = +card.dataset.gm || 10, q = +qv.textContent || 1;
      if (e.target.closest('[data-qd]')) qv.textContent = Math.max(1, q - 1);
      if (e.target.closest('[data-qu]')){ if (q >= mx) toast('Maximum ' + mx + ' at a time'); qv.textContent = Math.min(mx, q + 1); }
      if (e.target.closest('[data-add]')){
        addGift(card.dataset.gid, card.dataset.gt, +card.dataset.gp, q, mx); card.classList.add('added'); card.querySelector('small').textContent = '✓ in your cart ×' + q; card.querySelector('[data-add]').textContent = 'Update'; syncGiftCart();
      }
    }
    if (e.target.id === 'gmCart'){ closeModal($('gm')); openCart(); }
  });

  /* ---------------- cart (kept in this browser) ---------------- */
  var cart = store('geostore_cart') || [];
  if (!Array.isArray(cart)) cart = [];
  cart = cart.filter(function(i){ return i && typeof i.id === 'string'; });
  function saveCart(){ store('geostore_cart', cart); var n = lines().length; $$('[data-cartcount]').forEach(function(e){ e.textContent = n; e.hidden = !n; }); }
  function addGift(id, title, price, q, max){
    q = Math.max(1, Math.min(10, Math.floor(q) || 1));
    var ex = cart.filter(function(i){ return i.id === id; })[0];
    if (ex){ ex.q = q; ex.p = price; ex.m = max || 10; } else cart.push({id:id, v:'all', t:String(title).slice(0, 120), p:price, q:q, m:max || 10});
    saveCart(); toast(ex ? 'Cart updated' : 'Added to cart');
  }
  function addToCart(id, v, quiet){
    var p = id === 'ALL' ? null : byId(id);
    if (id !== 'ALL' && !p) return;
    if (id === 'ALL'){ cart = cart.filter(function(i){ var q2 = byId(i.id); return i.id.indexOf('g:') === 0 || i.id.indexOf('t:') === 0 || (q2 && q2.type === 'digital'); }); cart.push({id:'ALL', v:'all'}); }
    else if (cart.some(function(i){ return i.id === 'ALL'; }) && p.type !== 'digital'){ if (!quiet) toast('Already included in your All-Access pass'); return; }
    else if (p.type === 'digital'){ var dx = cart.filter(function(i){ return i.id === id; })[0]; if (dx) dx.q = Math.min(10, (dx.q || 1) + 1); else cart.push({id:id, v:'all', q:1}); }
    else if (v === 'all'){ cart = cart.filter(function(i){ return i.id !== id; }); cart.push({id:id, v:'all'}); }
    else if (!cart.some(function(i){ return i.id === id && (i.v === 'all' || i.v === v); })) cart.push({id:id, v:v});
    saveCart(); if (!quiet) toast('Added to cart');
  }
  // the same pricing rules as the server (the server always has the final say)
  function lines(){
    var out = [], hasAll = cart.some(function(i){ return i.id === 'ALL'; }), by = {}, order = [];
    cart.forEach(function(i){
      if (i.id === 'ALL') return;
      if (i.id.indexOf('t:') === 0){ out.push({id:i.id, title:(i.t || 'Game top-up') + ' · ' + Object.keys(i.f || {}).map(function(k){ return i.f[k]; }).join(' / '), unit:+i.p || 0, qty:1, max:1, noqty:true, price:round2(+i.p || 0)}); return; }
      if (i.id.indexOf('g:') === 0){ var gq = Math.max(1, Math.min(10, i.q || 1)); out.push({id:i.id, title:i.t || 'Gift card', unit:+i.p || 0, qty:gq, max:i.m || 10, price:round2((+i.p || 0) * gq)}); return; }
      var p = byId(i.id); if (!p) return;
      if (!by[i.id]){ by[i.id] = {p:p, all:false, st:[]}; order.push(i.id); }
      var g = by[i.id];
      if (p.type === 'digital' || i.v === 'all') g.all = true; else if (g.st.indexOf(i.v) < 0) g.st.push(i.v);
    });
    var res = [];
    if (hasAll && AA && AA.enabled) res.push({id:'ALL', title:AA.title || 'All-Access Pass', price:+AA.price});
    order.forEach(function(id){
      var g = by[id], p = g.p, n = p.variants.length;
      if (p.type === 'digital'){ var dq = Math.max(1, Math.min(10, (cart.filter(function(i){ return i.id === id; })[0] || {}).q || 1)); res.push({id:id, title:p.title, unit:+p.price, qty:dq, max:10, price:round2(+p.price * dq)}); return; }
      if (hasAll) return;
      if (n < 2 || g.all || g.st.length >= n || g.st.length * sp(p) >= p.price) res.push({id:id, title:p.title + (n > 1 ? ' (all ' + n + ' styles)' : ''), price:+p.price});
      else { g.st.sort(); res.push({id:id, title:p.title + ' — ' + g.st.map(function(k){ return p.variants[k].name; }).join(', '), price:round2(g.st.length * sp(p))}); }
    });
    return res.concat(out);
  }
  function totalOf(L){ return round2(L.reduce(function(a, l){ return a + l.price; }, 0)); }

  /* ---------------- checkout + payment ---------------- */
  var token = store('geostore_token') || '', me = store('geostore_me') || null, poll = null, tick = null, curOrder = null;
  var coins = [], coinSel = null, view = 'cart', fromBinance = false, CFG = {};
  function authH(){ var h = {'content-type':'application/json'}; if (token) h.authorization = 'Bearer ' + token; return h; }
  function apiCall(path, body, method){
    if (!API) return Promise.reject(new Error('The shop is not connected to its payment server yet.'));
    return fetch(API + path, {method: method || (body ? 'POST' : 'GET'), headers: authH(), body: body ? JSON.stringify(body) : undefined})
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if (!r.ok){ var er = new Error(j.error || 'Something went wrong'); er.status = r.status; throw er; } return j; }); },
        function(){ throw new Error('Could not reach the server. Check your connection and try again.'); });
  }
  var METHOD_UI = {
    usdt_trc20:{cls:'usdt', glyph:'₮', badge:'Popular', note:'Tether on the TRON network. Low fee on most exchanges.', eta:'Usually confirmed in 1–3 minutes'},
    usdt_bep20:{cls:'bnb', glyph:'₮', badge:'Fast', note:'Tether on BNB Smart Chain. Low fee and quick.', eta:'Usually confirmed in 1–3 minutes'},
    btc:{cls:'btc', glyph:'₿', badge:'', note:'Bitcoin. Needs 1 network confirmation.', eta:'Usually 10–30 minutes'},
    binancepay:{cls:'bpay', glyph:'B', badge:'Manual', note:'Send inside the Binance app with Binance Pay. We confirm it by hand.', eta:'Confirmed by us after you press “I have paid”'}
  };
  if (API){
    coins = [{id:'usdt_trc20', name:'USDT (TRC20)', network:'TRON (TRC20)', kind:'tron'}];
    fetch(API + '/api/config').then(function(r){ return r.json(); }).then(function(c){ CFG = c || {}; if (typeof chatInit === 'function') chatInit(); if (c && c.coins && c.coins.length){ coins = c.coins; if (!coins.some(function(x){ return x.id === coinSel; })) coinSel = null; if (view === 'method') renderMethods(); } livePrices(c); }).catch(function(){});
  }
  function stopTimers(){ clearInterval(poll); clearInterval(tick); poll = tick = null; }
  onClose.cartM = stopTimers;
  function setCartTitle(t){ $('cartTitle').textContent = t; }
  function openCart(from){
    stopTimers(); view = 'cart'; setCartTitle('Your cart'); renderCart(); openModal($('cartM'), from);
  }
  function renderCart(){
    var L = lines(), total = totalOf(L), b = $('cartBody');
    if (!L.length){ b.innerHTML = '<div class="empty" style="padding:30px 0">Your cart is empty.<br>Pick a gift card, a website or a code to get started.</div>'; saveCart(); return; }
    b.innerHTML = L.map(function(l){ return '<div class="cl"><span>' + esc(l.title) + '</span>' + (l.qty && !l.noqty ? '<span class="qty"><button type="button" data-cqd="' + esc(l.id) + '" aria-label="Fewer">−</button><b>' + l.qty + '</b><button type="button" data-cqu="' + esc(l.id) + '" aria-label="More">+</button></span>' : '<span></span>') + '<b>' + money(l.price) + '</b><button type="button" class="rm" data-rm="' + esc(l.id) + '" aria-label="Remove">×</button></div>'; }).join('') +
      '<div class="total"><span>Total</span><span>' + money(total) + '</span></div>' +
      (me ? '<p class="note" style="margin:0 0 12px">Signed in as <b>' + esc(me.email) + '</b> — this order is saved to your account.</p>' : '<div class="field"><label for="coEmail">Your email (your order is saved to it)</label><input id="coEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com"></div>') +
      '<button type="button" class="btn btn-primary btn-block" id="coNext">' + (API ? 'Continue to payment' : "I've paid — confirm order") + '</button><p class="msg" id="coMsg"></p>' +
      (me ? '' : '<p class="note">Have an account? <a href="#" class="link" id="cartSignin">Sign in</a> to keep your orders together.</p>');
    saveCart();
  }
  function renderMethods(){
    var L = lines(), total = totalOf(L);
    setCartTitle('Choose how to pay');
    if (!coinSel && coins.length) coinSel = coins[0].id;
    $('cartBody').innerHTML = '<div class="steps-h"><i class="on"></i><i class="on"></i><i></i></div>' +
      '<div class="sumrows">' + L.map(function(l){ return '<div><span>' + esc(l.title) + '</span><span>' + money(l.price) + '</span></div>'; }).join('') + '<div><span>Total</span><span>' + money(total) + '</span></div></div>' +
      '<div class="methods">' + coins.map(function(c){
        var u = METHOD_UI[c.id] || {cls:'usdt', glyph:'●', badge:''};
        return '<button type="button" class="method' + (c.id === coinSel ? ' on' : '') + '" data-coin="' + esc(c.id) + '">' + (u.badge ? '<span class="bd">' + esc(u.badge) + '</span>' : '') + '<span class="ic ' + u.cls + '">' + esc(u.glyph) + '</span><b>' + esc(c.name) + '</b><span class="ck">✓</span></button>';
      }).join('') + '</div>' +
      '<div id="mInfo"></div><div id="fromBox"></div>' +
      '<button type="button" class="btn-pay" id="coPay"><span class="bp-l"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>Pay ' + money(total) + '</span><span class="bp-r"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></button>' +
      '<p class="trust-line">🔒 Secure crypto payment · Your code is delivered automatically</p><p class="msg" id="coMsg"></p><button type="button" class="back" style="margin-top:6px" data-tocart>← Back to cart</button>';
    view = 'method'; drawInfo(); drawFrom();
  }
  var pendingEmail = '';
  $('cartBody').addEventListener('pointerdown', function(e){          // tactile feel: ripple + a tiny vibration where the phone supports it
    var b = e.target.closest('.btn-pay'); if (!b || b.disabled) return;
    var r = b.getBoundingClientRect(), s2 = document.createElement('i'), d = Math.max(r.width, r.height) * 1.2;
    s2.className = 'rip'; s2.style.cssText = 'width:' + d + 'px;height:' + d + 'px;left:' + (e.clientX - r.left - d / 2) + 'px;top:' + (e.clientY - r.top - d / 2) + 'px';
    b.appendChild(s2); setTimeout(function(){ s2.remove(); }, 650);
    try { if (navigator.vibrate) navigator.vibrate(12); } catch(x) {}
  });
  function selCoin(){ return coins.filter(function(c){ return c.id === coinSel; })[0] || {}; }
  function binanceNotice(){
    if (CFG.binanceAuto) return '<div class="notice"><span class="ico">⚡</span><div><b>Paying from your Binance account?</b><br>Binance-to-Binance transfers are detected <b>automatically</b>, usually within a minute or two. Send exactly the amount shown. <b>If your order is not confirmed within 1 hour, please contact us</b> with your order number.' + contactRow() + '</div></div>';
    return '<div class="notice"><span class="ico">⏳</span><div><b>Paying from your Binance account?</b><br>A transfer from Binance to our Binance address is an <b>internal transfer</b>, so it can take a while to be confirmed. <b>If your order is not confirmed within 1 hour, please contact us</b> with your order number and we will confirm it right away.' + contactRow() + '</div></div>';
  }
  function drawInfo(){
    var box = $('mInfo'); if (!box) return;
    var c = selCoin(), u = METHOD_UI[c.id]; if (!c.id || !u){ box.innerHTML = ''; return; }
    if (c.id === 'binancepay' && CFG.binanceAuto) u = Object.assign({}, u, {note:'Send inside the Binance app with Binance Pay. Detected automatically.', eta:'Usually confirmed within a minute or two'});
    box.innerHTML = '<div class="minfo"><span class="ic ' + u.cls + '">' + esc(u.glyph) + '</span><div><b>' + esc(c.name) + '</b><span>' + esc(u.note) + '</span><small>' + (c.network ? esc(c.network) + ' · ' : '') + esc(u.eta || '') + '</small></div></div>';
  }
  function drawFrom(){
    var box = $('fromBox'); if (!box) return;
    if (!selCoin().binance){ fromBinance = false; box.innerHTML = ''; return; }
    box.innerHTML = '<div class="field" style="margin:0 0 6px"><label>Where are you paying from?</label><div class="from-seg"><button type="button" data-from="no" class="' + (fromBinance ? '' : 'on') + '">Another wallet or exchange</button><button type="button" data-from="yes" class="' + (fromBinance ? 'on' : '') + '">Binance app</button></div></div>' + (fromBinance ? binanceNotice() : '');
  }
  $('cartBody').addEventListener('click', function(e){
    var rm = e.target.closest('[data-rm]'), m = e.target.closest('[data-coin]');
    if (rm){ cart = cart.filter(function(i){ return i.id !== rm.dataset.rm; }); renderCart(); }
    var qd = e.target.closest('[data-cqd]'), qu = e.target.closest('[data-cqu]');
    if (qd || qu){
      var cid = (qd || qu).dataset.cqd || (qd || qu).dataset.cqu, it = cart.filter(function(i){ return i.id === cid; })[0];
      if (it){ var mx = it.m || 10; it.q = Math.max(1, Math.min(mx, (it.q || 1) + (qu ? 1 : -1))); if (qu && (it.q || 1) >= mx) toast('Maximum ' + mx + ' at a time'); renderCart(); }
    }
    if (m){ coinSel = m.dataset.coin; $$('#cartBody .method').forEach(function(x){ x.classList.toggle('on', x === m); }); drawInfo(); drawFrom(); }
    var fb = e.target.closest('[data-from]'); if (fb){ fromBinance = fb.dataset.from === 'yes'; drawFrom(); }
    if (e.target.id === 'cartSignin'){ e.preventDefault(); closeModal($('cartM')); openAccount(); }
    if (e.target.closest('[data-tocart]')){ view = 'cart'; setCartTitle('Your cart'); renderCart(); }
    if (e.target.id === 'coNext') goCheckout();
    if (e.target.closest('#coPay')) createOrder();
    if (e.target.id === 'payClaim') claimManual();
    if (e.target.closest('[data-copy]')){ var c = e.target.closest('[data-copy]'), src = $(c.dataset.copy); copyText(src.dataset.v || src.textContent, function(){ var o = c.textContent; c.textContent = 'Copied ✓'; setTimeout(function(){ c.textContent = o; }, 1500); }); }
  });
  $('cartBody').addEventListener('keydown', function(e){ if (e.key === 'Enter' && e.target.id === 'coEmail'){ e.preventDefault(); goCheckout(); } });
  function goCheckout(){
    var L = lines(); if (!L.length) return;
    var email = me ? me.email : (($('coEmail') || {}).value || '').trim(), msg = $('coMsg');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)){ msg.classList.add('err'); msg.textContent = 'Please enter a valid email address.'; return; }
    pendingEmail = email; msg.classList.remove('err');
    if (!API){
      var body = 'New order\r\n' + L.map(function(l){ return '- ' + l.title + ': ' + money(l.price); }).join('\r\n') + '\r\nTotal: ' + money(totalOf(L)) + '\r\nCustomer email: ' + email;
      window.location.href = 'mailto:' + (S.email || '') + '?subject=' + encodeURIComponent('Order: ' + L[0].title + (L.length > 1 ? ' +' + (L.length - 1) : '')) + '&body=' + encodeURIComponent(body);
      msg.textContent = 'Your email app opened with the order details — press Send to finish.'; return;
    }
    if (!coins.length){ msg.classList.add('err'); msg.textContent = 'Payments are not set up yet. Please try again later.'; return; }
    if (coins.length === 1){ coinSel = coins[0].id; createOrder(); return; }
    renderMethods();
  }
  function createOrder(){
    var msg = $('coMsg'), btn = $('coPay'); if (btn){ btn.disabled = true; btn.classList.add('busy'); } msg.classList.remove('err'); msg.textContent = 'Creating your order…';
    apiCall('/api/order', {email: pendingEmail, coin: coinSel || 'usdt_trc20', fromBinance: !!(fromBinance && selCoin().binance), items: cart.map(function(i){ return i.f ? {id:i.id, v:i.v, q:1, f:i.f} : {id:i.id, v:i.v, q:i.q || 1}; })})
      .then(function(o){ rememberOrder(o.id); cart = []; saveCart(); showPay(o); })
      .catch(function(er){ if (btn){ btn.disabled = false; btn.classList.remove('busy'); } var m2 = $('coMsg'); if (m2){ m2.classList.add('err'); m2.textContent = er.message || 'Could not create the order. Please try again.'; } });
  }
  function rememberOrder(id){ var ids = store('geostore_orders') || []; if (ids.indexOf(id) < 0){ ids.push(id); store('geostore_orders', ids.slice(-20)); } }
  function leftText(ms){ if (ms <= 0) return 'expired'; var m = Math.floor(ms / 60000), s = Math.floor(ms % 60000 / 1000); return m + ':' + (s < 10 ? '0' : '') + s; }
  var qrLoaded = null;
  function loadQR(){ if (window.qrcode) return Promise.resolve(); if (qrLoaded) return qrLoaded; qrLoaded = new Promise(function(res){ var s = document.createElement('script'); s.src = 'qr.js'; s.onload = res; s.onerror = res; document.head.appendChild(s); }); return qrLoaded; }
  function drawQR(text){
    loadQR().then(function(){ var el = $('payQR'); if (!el || !window.qrcode) return; try { var q2 = window.qrcode(0, 'M'); q2.addData(String(text)); q2.make(); el.innerHTML = q2.createSvgTag({cellSize:4, margin:0, scalable:true}); } catch(e) { el.parentNode.hidden = true; } });
  }
  function showPay(o){
    curOrder = o; stopTimers(); view = 'pay'; $('toast').classList.remove('show'); openModal($('cartM'));
    setCartTitle('Pay with ' + o.coinName);
    var manual = o.kind === 'manual', isBtc = o.kind === 'btc';
    var rows = (o.items || []).map(function(i){ return '<div><span>' + esc(i.title) + (i.qty > 1 ? ' ×' + i.qty : '') + '</span><span>' + money(i.price) + '</span></div>'; }).join('') + '<div><span>Total</span><span>' + money(o.usd) + '</span></div>';
    var warns = manual ?
      '<div><span>①</span><span>Open <b>Binance → Pay → Send</b> and enter the Pay ID below.</span></div><div><span>②</span><span>Send exactly <b>' + esc(o.amount) + ' USDT</b>, then press “I have paid”.</span></div><div><span>③</span><span>' + (CFG.binanceAuto ? 'We detect it automatically — usually within a minute or two. Pressing “I have paid” is only needed if it takes longer.' : 'We check it by hand. You will see your order here as soon as it is confirmed.') + '</span></div>' :
      '<div><span>①</span><span>Send <b>only ' + esc(o.coinName) + '</b> on the <b>' + esc(o.network) + '</b> network. Other networks are lost.</span></div>' +
      '<div><span>②</span><span>Send the <b>exact amount</b> shown (it includes a few extra cents that identify your order). If you pay from an exchange, add its withdrawal fee on top so exactly <b>' + esc(o.amount) + '</b> arrives.</span></div>' +
      '<div><span>③</span><span>' + (isBtc ? 'Bitcoin needs 1 confirmation (about 10–30 minutes).' : 'This window updates by itself in under a minute after you pay.') + '</span></div>';
    $('cartBody').innerHTML = '<div class="steps-h"><i class="on"></i><i class="on"></i><i class="on"></i></div>' +
      '<div class="pay-top"><span class="mono muted">Order ' + esc(o.id.slice(0, 8).toUpperCase()) + '</span><span class="pill pending" id="payPill">Waiting for payment</span></div>' +
      '<div class="timer" id="payTimer"><i style="width:100%"></i></div>' +
      '<div id="payMain"><div class="pcard"><label>Send exactly</label><div class="prow"><div class="pamt" id="payAmt" data-v="' + esc(o.amount) + '">' + esc(o.amount) + '<small>' + esc((o.coinName.match(/^(\w+)/) || [,''])[1]) + '</small></div><button type="button" class="btn btn-ghost btn-sm" data-copy="payAmt">Copy</button></div></div>' +
      '<div class="paygrid"><div><div class="pcard"><label>' + (manual ? 'Binance Pay ID' : 'To this address') + ' · ' + esc(o.network) + '</label><div class="prow"><div class="paddr" id="payAddr">' + esc(o.wallet) + '</div><button type="button" class="btn btn-ghost btn-sm" data-copy="payAddr">Copy</button></div></div></div>' +
      (manual ? '' : '<div class="qr" title="Scan to copy the address"><span id="payQR"></span></div>') + '</div>' +
      '<div class="sumrows">' + rows + '</div><div class="warns">' + warns + '</div>' +
      (manual ? '<div class="field"><label for="payRef">Binance Pay order ID or note (optional)</label><input id="payRef" maxlength="80" placeholder="e.g. from the payment receipt"></div><button type="button" class="btn btn-primary btn-block" id="payClaim">I have paid</button>' : '') +
      '<div class="pstatus" id="payStatus" style="margin-top:12px"><span class="spin"></span><span id="payStatusTxt">Waiting for your payment…</span></div></div>' +
      '<div id="payDone" hidden></div>' + (o.fromBinance ? binanceNotice() : '') +
      '<p class="note" style="text-align:center">Problem with your payment? <a class="link" href="mailto:' + esc(S.email || '') + '?subject=' + encodeURIComponent('Order ' + o.id.slice(0, 8).toUpperCase()) + '">Contact us</a> with order number <span class="mono">' + esc(o.id.slice(0, 8).toUpperCase()) + '</span>.</p>' + '<div class="contact-row" style="justify-content:center">' + contactBtns() + '</div>';
    if (!manual) drawQR(o.wallet);
    renderPay(o);
    if (o.status === 'pending'){
      poll = setInterval(function(){ refresh(o.id); }, isBtc ? 20000 : 8000);
      tick = setInterval(function(){ if (curOrder) renderPay(curOrder); }, 1000);
    }
  }
  function renderPay(o){
    curOrder = o;
    var pill = $('payPill'), st = $('payStatus'), stt = $('payStatusTxt'), main = $('payMain'), done = $('payDone'), timer = $('payTimer');
    if (!pill) return;
    st.classList.remove('err');
    if (o.status === 'paid'){
      pill.className = 'pill paid'; pill.textContent = 'Paid'; timer.hidden = true;
      if (o.fulfil === 'wait'){ main.hidden = false; st.hidden = false; stt.textContent = 'Payment received ✓ — preparing your code, this takes a few seconds…'; return; }
      main.hidden = true; done.hidden = false; setCartTitle('Order complete');
      if (o.fulfil === 'stuck'){ done.innerHTML = '<div class="done"><div class="big" style="background:var(--warn)">!</div><h3 style="padding:0">Payment received</h3><p class="note">Your code needs a quick manual check. We will deliver it very soon — it will appear in your account too.<br>Order number: <span class="mono">' + esc(o.id.slice(0, 8).toUpperCase()) + '</span></p></div>'; stopTimers(); return; }
      done.innerHTML = '<div class="done"><div class="big">✓</div><h3 style="padding:0">Payment received — thank you!</h3><p class="note">Your order is ready. Open your private page for your codes and your invoice.</p><a class="btn btn-primary btn-block" style="margin-top:14px" target="_blank" rel="noopener" href="' + esc(o.deliveryUrl) + '">Open my codes &amp; invoice</a><p class="note">Keep the link — it is also saved under <b>Account → Orders</b>.</p></div>';
      stopTimers(); return;
    }
    if (o.status === 'expired'){ pill.className = 'pill expired'; pill.textContent = 'Expired'; timer.hidden = true; st.classList.add('err'); st.firstChild.hidden = true; stt.textContent = 'This order expired. If you already paid, email us your order number: ' + o.id.slice(0, 8).toUpperCase(); stopTimers(); return; }
    var total = o.expiresAt - o.createdAt, left = o.expiresAt - Date.now();
    timer.firstChild.style.width = Math.max(0, Math.min(100, left / total * 100)) + '%';
    if (o.kind === 'manual'){
      stt.textContent = o.claimed ? 'Thanks! We are checking your payment now…' : CFG.binanceAuto ? 'Waiting for your Binance payment… ' + leftText(left) + ' left' : 'Pay in Binance, then press “I have paid”. Time left ' + leftText(left);
      var cb = $('payClaim'); if (cb){ cb.disabled = !!o.claimed; cb.textContent = o.claimed ? 'Payment reported ✓' : 'I have paid'; }
    } else if (left <= 0){ st.classList.add('err'); stt.textContent = 'Time is up. If you already sent the payment it may still be detected — keep this window open for a few minutes.'; }
    else stt.textContent = 'Waiting for your payment… ' + leftText(left) + ' left';
  }
  function refresh(id){ apiCall('/api/order/' + id).then(function(o){ if (o && o.status) renderPay(o); }).catch(function(){}); }
  function claimManual(){
    if (!curOrder) return; var ref = ($('payRef') || {}).value || '';
    apiCall('/api/order/' + curOrder.id + '/claim', {ref: ref}).then(function(o){ renderPay(o); toast('Thanks — we are checking your payment'); }).catch(function(er){ toast(er.message); });
  }
  function resumeOrder(id){ return apiCall('/api/order/' + id).then(function(o){ closeModal($('acctM')); showPay(o); }); }

  /* ---------------- account ---------------- */
  var acctTab = 'orders';
  function setAuth(t, profile){ token = t || ''; me = profile || null; store('geostore_token', token || null); store('geostore_me', me); updateNav(); }
  function updateNav(){ $$('[data-acctlabel]').forEach(function(e){ e.textContent = me ? (me.name ? me.name.split(' ')[0] : 'Account') : 'Sign in'; }); $$('.tabbar [data-acctlabel]').forEach(function(e){ e.textContent = me ? (me.name ? me.name.split(' ')[0].slice(0, 8) : 'Account') : 'Account'; }); }
  function dt(ms){ return ms ? new Date(ms).toLocaleString([], {dateStyle:'medium', timeStyle:'short'}) : ''; }
  function pillFor(st){ return '<span class="pill ' + st + '">' + ({pending:'Waiting for payment', paid:'Paid', expired:'Expired'}[st] || st) + '</span>'; }
  function orderCard(o){
    return '<div class="oc"><div class="oh"><b>' + esc(o.title) + '</b>' + pillFor(o.status) + '</div><div class="mono muted" style="font-size:.78rem">' + dt(o.createdAt) + ' · ' + esc(o.id.slice(0, 8).toUpperCase()) + ' · ' + money(o.usd) + ' · ' + esc(o.amount) + ' ' + esc(o.coinName.split(' ')[0]) + '</div>' +
      '<div class="oa">' + (o.status === 'paid' ? '<a class="btn btn-primary btn-sm" target="_blank" rel="noopener" href="' + esc(o.deliveryUrl) + '">Open codes &amp; invoice</a>' : '') + (o.status === 'pending' ? '<button type="button" class="btn btn-primary btn-sm" data-pay="' + esc(o.id) + '">Continue payment</button>' : '') + '</div></div>';
  }
  function explorer(o){ return !o.txid || o.txid === 'manual' ? 'confirmed by us' : /^(bp|bn):/.test(o.txid) ? 'Binance transfer' : '<a class="link" target="_blank" rel="noopener" href="' + (o.coin === 'btc' ? 'https://mempool.space/tx/' : o.coin === 'usdt_bep20' ? 'https://bscscan.com/tx/' : 'https://tronscan.org/#/transaction/') + encodeURIComponent(o.txid) + '">' + esc(o.txid.slice(0, 10)) + '…</a>'; }
  function openAccount(from){ $('acctTitle').textContent = me ? 'My account' : 'Account'; openModal($('acctM'), from); me ? renderIn() : renderOut('in'); }
  function renderOut(tabName){
    if (!API){ $('acctBody').innerHTML = '<p class="empty">Customer accounts switch on as soon as the payment server is connected.</p>'; return; }
    var ids = (store('geostore_orders') || []).slice().reverse();
    $('acctBody').innerHTML =
      '<div class="tabs"><button type="button" class="tab ' + (tabName === 'in' ? 'on' : '') + '" data-at="in">Sign in</button><button type="button" class="tab ' + (tabName === 'up' ? 'on' : '') + '" data-at="up">Create account</button></div>' +
      '<form id="authForm" novalidate>' + (tabName === 'up' ? '<div class="field"><label for="afName">Your name</label><input id="afName" autocomplete="name"></div>' : '') +
      '<div class="field"><label for="afEmail">Email</label><input id="afEmail" type="email" autocomplete="email" inputmode="email"></div><div class="field"><label for="afPw">Password' + (tabName === 'up' ? ' (at least 8 characters)' : '') + '</label><input id="afPw" type="password" autocomplete="' + (tabName === 'up' ? 'new-password' : 'current-password') + '"></div>' +
      '<button class="btn btn-primary btn-block" type="submit">' + (tabName === 'up' ? 'Create account' : 'Sign in') + '</button><p class="msg" id="afMsg"></p></form>' +
      '<p class="note">An account keeps every order, code and invoice in one place, on any device.</p>' +
      '<h4 class="sh">Orders placed on this device</h4><div id="devOrders">' + (ids.length ? '<p class="note">Loading…</p>' : '<p class="note">No orders yet.</p>') + '</div>';
    $('acctBody').dataset.tab = tabName;
    if (ids.length) Promise.all(ids.slice(0, 10).map(function(id){ return apiCall('/api/order/' + id).catch(function(){ return null; }); })).then(function(os){ os = os.filter(Boolean); var d = $('devOrders'); if (d) d.innerHTML = os.length ? os.map(orderCard).join('') : '<p class="note">No orders yet.</p>'; });
  }
  function renderIn(){
    $('acctBody').innerHTML = '<p class="note">Loading your account…</p>';
    apiCall('/api/account/me').then(function(r){
      me = r.profile; store('geostore_me', me); updateNav();
      var paid = r.orders.filter(function(o){ return o.status === 'paid'; });
      var tl = [['orders', 'Orders (' + r.orders.length + ')'], ['pay', 'Payments'], ['profile', 'Profile']], body = '';
      if (acctTab === 'orders') body = r.orders.length ? r.orders.map(orderCard).join('') : '<p class="empty">No orders yet. Your purchases will appear here.</p>';
      if (acctTab === 'pay') body = paid.length ? '<div class="tw"><table class="pt"><thead><tr><th>Date</th><th>Items</th><th>Paid</th><th>Transaction</th></tr></thead><tbody>' + paid.map(function(o){ return '<tr><td>' + dt(o.paidAt || o.createdAt) + '</td><td>' + esc(o.title) + '</td><td>' + money(o.usd) + '<div class="mono muted" style="font-size:.74rem">' + esc(o.amount) + ' ' + esc(o.coinName.split(' ')[0]) + '</div></td><td>' + explorer(o) + '</td></tr>'; }).join('') + '</tbody></table></div><p class="note">Total spent: <b>' + money(r.spent) + '</b></p>' : '<p class="empty">No payments yet.</p>';
      if (acctTab === 'profile') body =
        '<div class="stats2"><div><small>Member since</small><b>' + new Date(r.profile.createdAt).toLocaleDateString() + '</b></div><div><small>Orders</small><b>' + r.orders.length + '</b></div><div><small>Total spent</small><b>' + money(r.spent) + '</b></div></div>' +
        '<form id="profForm"><div class="two"><div class="field"><label>Name</label><input id="pfName" value="' + esc(r.profile.name) + '"></div><div class="field"><label>Email</label><input value="' + esc(r.profile.email) + '" disabled></div><div class="field"><label>Phone</label><input id="pfPhone" value="' + esc(r.profile.phone) + '"></div><div class="field"><label>Country</label><input id="pfCountry" value="' + esc(r.profile.country) + '"></div></div><button class="btn btn-primary" type="submit">Save details</button> <span class="msg" id="pfMsg"></span></form>' +
        '<h4 class="sh">Change password</h4><form id="pwForm"><div class="two"><div class="field"><label>Current password</label><input id="pwOld" type="password" autocomplete="current-password"></div><div class="field"><label>New password (8+ characters)</label><input id="pwNew" type="password" autocomplete="new-password"></div></div><button class="btn btn-ghost" type="submit">Change password</button> <span class="msg" id="pwMsg"></span></form>' +
        '<p style="margin-top:22px"><button type="button" class="btn btn-ghost" id="signOut">Sign out</button></p>';
      $('acctBody').innerHTML = '<p class="note" style="margin:0 0 12px">Signed in as <b>' + esc(r.profile.email) + '</b></p><div class="tabs">' + tl.map(function(t){ return '<button type="button" class="tab ' + (acctTab === t[0] ? 'on' : '') + '" data-at="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>' + body;
    }).catch(function(er){ if (er.status === 401){ setAuth('', null); renderOut('in'); } else $('acctBody').innerHTML = '<p class="empty">' + esc(er.message) + '</p>'; });
  }
  $('acctBody').addEventListener('click', function(e){
    var t = e.target.closest('[data-at]'), pay = e.target.closest('[data-pay]');
    if (t){ if (me){ acctTab = t.dataset.at; renderIn(); } else renderOut(t.dataset.at); }
    if (pay) resumeOrder(pay.dataset.pay).catch(function(er){ toast(er.message); });
    if (e.target.id === 'signOut'){ setAuth('', null); $('acctTitle').textContent = 'Account'; renderOut('in'); toast('Signed out'); }
  });
  $('acctBody').addEventListener('submit', function(e){
    e.preventDefault(); var id = e.target.id;
    if (id === 'authForm'){
      var up = $('acctBody').dataset.tab === 'up', msg = $('afMsg'); msg.classList.remove('err'); msg.textContent = 'Please wait…';
      apiCall(up ? '/api/account/register' : '/api/account/login', {email:$('afEmail').value.trim(), password:$('afPw').value, name: up ? $('afName').value.trim() : undefined})
        .then(function(r){ setAuth(r.token, r.profile); acctTab = 'orders'; $('acctTitle').textContent = 'My account'; renderIn(); toast(up ? 'Account created' : 'Welcome back'); })
        .catch(function(er){ msg.classList.add('err'); msg.textContent = er.message; });
    }
    if (id === 'profForm') apiCall('/api/account/update', {name:$('pfName').value, phone:$('pfPhone').value, country:$('pfCountry').value}).then(function(r){ me = r.profile; store('geostore_me', me); updateNav(); $('pfMsg').classList.remove('err'); $('pfMsg').textContent = 'Saved ✓'; }).catch(function(er){ $('pfMsg').classList.add('err'); $('pfMsg').textContent = er.message; });
    if (id === 'pwForm') apiCall('/api/account/password', {oldPassword:$('pwOld').value, newPassword:$('pwNew').value}).then(function(r){ setAuth(r.token, r.profile); $('pwMsg').classList.remove('err'); $('pwMsg').textContent = 'Password changed ✓'; $('pwOld').value = $('pwNew').value = ''; }).catch(function(er){ $('pwMsg').classList.add('err'); $('pwMsg').textContent = er.message; });
  });
  $$('[data-openacct]').forEach(function(b){ b.addEventListener('click', function(){ openAccount(b); }); });
  $$('[data-opencart]').forEach(function(b){ b.addEventListener('click', function(){ openCart(b); }); });

  /* ---------------- prices come live from your server ---------------- */
  function livePrices(c){
    if (!c || !c.prices) return;
    var changed = false;
    every.forEach(function(p){
      var x = c.prices[p.id]; if (!x) return;
      if (+x.price > 0 && +x.price !== +p.price){ p.price = +x.price; changed = true; }
      if (+x.stylePrice !== +(p.stylePrice || 0)){ p.stylePrice = +x.stylePrice || 0; changed = true; }
    });
    if (c.allAccess && AA && +c.allAccess.price > 0 && +c.allAccess.price !== +AA.price){ AA.price = +c.allAccess.price; $('passPrice').textContent = money(AA.price); changed = true; }
    if (changed){ if (tab === 'code') renderCodes(); if (tab === 'sites') renderWebs(); if (tab === 'gift') renderGift(); saveCart(); }
  }

  /* ---------------- FAQ ---------------- */
  (function(){
    var items = $$('.fq');
    items.forEach(function(it){ it.querySelector('button').addEventListener('click', function(){
      var open = !it.classList.contains('open');
      items.forEach(function(x){ x.classList.remove('open'); x.querySelector('button').setAttribute('aria-expanded', 'false'); });
      if (open){ it.classList.add('open'); this.setAttribute('aria-expanded', 'true'); }
    }); });
  })();

  /* ---------------- contact + live chat ---------------- */
  function digits(x){ return String(x || '').replace(/\D/g, ''); }
  function waLink(text){ var n = digits(S.whatsapp); return n ? 'https://wa.me/' + n + (text ? '?text=' + encodeURIComponent(text) : '') : ''; }
  function tgLink(){ var u = String(S.telegram || '').replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, ''); return u ? 'https://t.me/' + u : ''; }
  function orderRef(){ return curOrder && curOrder.id ? curOrder.id.slice(0, 8).toUpperCase() : ''; }
  function contactBtns(){
    var ref = orderRef(), h = '';
    if (waLink()) h += '<a class="wa" target="_blank" rel="noopener" href="' + esc(waLink('Hi! I need help' + (ref ? ' with order #' + ref : '') + '.')) + '">WhatsApp</a>';
    if (CFG.chat) h += '<button type="button" data-chat>💬 Live chat</button>';
    if (tgLink()) h += '<a target="_blank" rel="noopener" href="' + esc(tgLink()) + '">Telegram</a>';
    if (S.email) h += '<a href="mailto:' + esc(S.email) + '">Email</a>';
    return h;
  }
  function contactRow(){ var b = contactBtns(); return b ? '<div class="contact-row">' + b + '</div>' : ''; }
  var CH = {sid: store('geostore_chat_sid'), log: store('geostore_chat_log') || [], after: 0, open: false, timer: null, lastSent: 0, unread: 0};
  if (!CH.sid || !/^[a-f0-9]{16,32}$/.test(CH.sid)){ var ra = new Uint8Array(12); (window.crypto || window.msCrypto).getRandomValues(ra); CH.sid = Array.prototype.map.call(ra, function(b){ return ('0' + b.toString(16)).slice(-2); }).join(''); store('geostore_chat_sid', CH.sid); }
  if (!Array.isArray(CH.log)) CH.log = [];
  CH.log.forEach(function(m){ if (m.t > CH.after && m.k === 'them') CH.after = m.t; });
  function chatSave(){ store('geostore_chat_log', CH.log.slice(-40)); }
  function chatDraw(){
    var box = $('chatLog'), html = '';
    if (!CFG.chat) html = '<div class="msg-b sys">Live chat is offline right now. Please try again a little later.</div>';
    else {
      if (!CH.log.length) html += '<div class="msg-b sys">👋 Hi! Ask us anything about your order or a product. We reply here.</div>';
      html += CH.log.map(function(m){ return '<div class="msg-b ' + (m.k === 'me' ? 'me' : m.k === 'them' ? 'them' : 'sys') + '">' + esc(m.text) + '</div>'; }).join('');
    }
    box.innerHTML = html; box.scrollTop = box.scrollHeight;
    $('chatForm').hidden = !CFG.chat;
    $('chatSub').textContent = CFG.chat ? 'We usually reply within minutes' : 'Offline right now';
  }
  function chatLinks(){}
  function chatFab(){ $('chatFab').hidden = !CFG.chat; }
  function chatBadge(){ var b = $('chatBadge'); b.hidden = !CH.unread; b.textContent = CH.unread; }
  function chatPoll(){
    clearTimeout(CH.timer); CH.timer = null;
    var recent = Date.now() - CH.lastSent < 30 * 60000, every = CH.open ? 5000 : (recent ? 20000 : 0);
    if (!CFG.chat || !API || !every) return;
    CH.timer = setTimeout(function(){
      if (document.hidden){ chatPoll(); return; }
      fetch(API + '/api/chat/poll?sid=' + CH.sid + '&after=' + CH.after).then(function(r){ return r.json(); }).then(function(j){
        var n = 0; (j.msgs || []).forEach(function(m){ if (m.t > CH.after){ CH.after = m.t; CH.log.push({k:'them', t:m.t, text:String(m.text || '')}); n++; } });
        if (n){ chatSave(); if (CH.open) chatDraw(); else { CH.unread += n; chatBadge(); } }
      }).catch(function(){}).then(chatPoll);
    }, every);
  }
  function chatOpen(){
    CH.open = true; CH.unread = 0; chatBadge(); chatLinks(); chatDraw(); $('chatBox').hidden = false; $('chatFab').setAttribute('aria-expanded', 'true'); chatPoll();
  }
  function chatClose(){ CH.open = false; $('chatBox').hidden = true; $('chatFab').setAttribute('aria-expanded', 'false'); chatPoll(); }
  function chatInit(){ chatFab(); if ($('chatBox').hidden === false){ chatLinks(); chatDraw(); } chatPoll(); }
  $('chatFab').addEventListener('click', function(){ CH.open ? chatClose() : chatOpen(); });
  $('chatClose').addEventListener('click', chatClose);
  document.addEventListener('click', function(e){ if (e.target.closest('[data-chat]')) chatOpen(); });
  $('chatForm').addEventListener('submit', function(e){
    e.preventDefault(); var inp = $('chatTxt'), text = inp.value.trim(); if (!text) return;
    inp.value = ''; CH.log.push({k:'me', t:Date.now(), text:text}); CH.lastSent = Date.now(); chatSave(); chatDraw();
    apiCall('/api/chat/send', {sid: CH.sid, text: text, name: me && me.name ? me.name : '', order: orderRef()}).catch(function(er){ CH.log.push({k:'sys', t:Date.now(), text:'⚠ ' + (er.message || 'Could not send') + ' — please try WhatsApp or email.'}); chatSave(); chatDraw(); });
    chatPoll();
  });

  /* ---------------- start ---------------- */
  /* social icons: only the links you filled in are shown */
  (function(){
    var P = {facebook:'M13.5 21v-7.5h2.5l.4-3h-2.9V8.6c0-.9.3-1.4 1.5-1.4h1.5V4.5c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.3-3.7 3.8v2.3H8v3h2.6V21h2.9Z',
      instagram:'M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4Zm0 2a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H7Zm5 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm5.200-3.200a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z',
      x:'M17.8 3h3.100l-6.800 7.700L22 21h-6.200l-4.900-6.300L5.300 21H2.200l7.200-8.300L1.900 3h6.400l4.400 5.800L17.800 3Zm-1.100 16.200h1.700L7.300 4.700H5.500l11.200 14.500Z',
      youtube:'M21.600 7.200a2.500 2.500 0 0 0-1.800-1.800C18.200 5 12 5 12 5s-6.200 0-7.800.4a2.500 2.500 0 0 0-1.800 1.800C2 8.800 2 12 2 12s0 3.200.4 4.800a2.500 2.500 0 0 0 1.800 1.800C5.800 19 12 19 12 19s6.200 0 7.800-.4a2.500 2.500 0 0 0 1.800-1.800C22 15.200 22 12 22 12s0-3.200-.4-4.800ZM10 15V9l5.200 3L10 15Z',
      tiktok:'M16.500 3c.3 2.400 1.700 3.900 4 4v3.100c-1.400.1-2.700-.3-4-1.100v6.200c0 3.900-3.200 6.300-6.400 5.700-3.500-.6-5.400-4.300-3.900-7.600 1-2.200 3.300-3.400 5.600-3.100v3.200c-.4-.1-.8-.1-1.200 0-1.300.4-1.900 1.800-1.400 3 .6 1.300 2.300 1.700 3.400.8.6-.5.900-1.200.9-2V3h3Z',
      telegram:'M21.500 4.300 2.900 11.500c-1.300.5-1.300 1.200-.2 1.500l4.700 1.500 1.800 5.600c.2.600.1.800.7.800.5 0 .7-.2 1-.5l2.200-2.200 4.600 3.400c.8.500 1.500.2 1.700-.8l3-14.400c.3-1.200-.5-1.800-1.400-1.400ZM8.500 13.700l9.900-6.200c.5-.3.9-.1.5.2l-8 7.300-.3 3.600-2.100-4.900Z',
      whatsapp:'M12 2a10 10 0 0 0-8.600 15L2 22l5.200-1.400A10 10 0 1 0 12 2Zm5.800 14.200c-.2.700-1.400 1.300-2 1.400-.5.100-1.200.1-1.900-.1-.4-.1-1-.3-1.700-.6-3-1.300-4.900-4.300-5-4.500-.1-.2-1.200-1.600-1.200-3s.8-2.100 1-2.400c.3-.3.600-.3.800-.3h.600c.2 0 .4 0 .6.500l.9 2.100c.1.200.1.400 0 .5l-.3.500-.4.400c-.1.200-.3.300-.1.600.2.300.8 1.300 1.700 2.100 1.200 1 2.100 1.300 2.400 1.500.3.100.5.100.7-.1l1-1.200c.2-.3.400-.2.600-.1l2 .9c.3.100.5.200.6.300.1.200.1.800-.1 1.500Z',
      snapchat:'M12 3c2.600 0 4.500 1.900 4.500 4.600v1.600c.3.100.8.300 1.100.4.400.1.600.4.500.7-.1.400-.8.700-1.400.9.400 1.100 1.200 2 2.300 2.400.3.100.4.400.2.600-.4.400-1 .6-1.700.7-.1.300-.1.700-.3.800-.3.100-.9-.1-1.500 0-.8.200-1.200 1.400-3.700 1.400s-2.900-1.200-3.700-1.400c-.6-.1-1.200.1-1.500 0-.2-.1-.2-.5-.3-.8-.7-.1-1.300-.3-1.700-.7-.2-.2-.1-.5.200-.6 1.100-.4 1.900-1.300 2.300-2.400-.6-.2-1.300-.5-1.400-.9-.1-.3.100-.6.500-.7.300-.1.800-.3 1.100-.4V7.600C7.500 4.900 9.400 3 12 3Z',
      linkedin:'M4.500 9h3v10.500h-3V9ZM6 4.200a1.800 1.800 0 1 1 0 3.600 1.800 1.800 0 0 1 0-3.600ZM9.800 9h2.900v1.400c.4-.8 1.500-1.700 3.100-1.700 3.200 0 3.800 2.100 3.800 4.800v6h-3v-5.300c0-1.300 0-2.900-1.800-2.900s-2 1.400-2 2.800v5.400h-3V9Z',
      discord:'M19.500 5.500A16 16 0 0 0 15.600 4.300l-.5 1a15 15 0 0 0-4.200 0l-.5-1a16 16 0 0 0-3.900 1.200C4 9.200 3.300 12.800 3.600 16.300a16 16 0 0 0 4.800 2.400l1-1.600a10 10 0 0 1-1.600-.8l.4-.3a11.500 11.500 0 0 0 9.600 0l.4.300c-.5.300-1 .600-1.600.8l1 1.600a16 16 0 0 0 4.800-2.400c.4-4.100-.7-7.600-2.900-10.800ZM9.300 14.200c-.9 0-1.600-.8-1.600-1.800s.7-1.800 1.600-1.800 1.600.8 1.600 1.800-.7 1.800-1.600 1.800Zm5.400 0c-.9 0-1.600-.8-1.600-1.800s.7-1.800 1.600-1.800 1.600.8 1.600 1.800-.7 1.800-1.600 1.800Z'};
    var L = S.social || {}, h = '';
    Object.keys(P).forEach(function(k){ var u = safeUrl(L[k]); if (u) h += '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer" aria-label="' + k + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="' + P[k] + '"/></svg></a>'; });
    $('social').innerHTML = h; $('social').hidden = !h;
  })();
  renderBest();
  updateNav(); saveCart(); chatInit();
  if (tabs.length) showTab(tabs[0].id);
  else { $('shop').querySelector('.wrap').innerHTML = '<p class="empty" style="padding:60px 0">The shop is being stocked. Please check back soon.</p>'; }
})();
