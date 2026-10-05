/* Living background: soft flowing 3D-style ribbons. Built to never slow the shop down:
   - draws at most ~30 times a second, pauses when the tab is hidden, a popup is open, or you are scrolling fast
   - measures its own cost and lowers quality (then stops and shows a still picture) on slow phones
   - respects "reduce motion" and "data saver" */
(function(){
  'use strict';
  var cv = document.getElementById('bg3d'); if (!cv || !cv.getContext) return;
  var ctx = cv.getContext('2d', {alpha: true}); if (!ctx) return;
  var reduce = false, saver = false;
  try { reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch(e) {}
  try { saver = !!(navigator.connection && navigator.connection.saveData); } catch(e) {}
  var W = 0, H = 0, dpr = 1, level = 0, running = true, last = 0, scrolling = 0, sy = 0, mx = .5, my = .5;
  var costSum = 0, costN = 0, slow = 0, dead = false, phones = Math.min(innerWidth, innerHeight) < 700;
  var LEVELS = [{lines: phones ? 6 : 14, steps: phones ? 26 : 48, dpr: phones ? 1 : 1.25, dots: phones ? 10 : 36, fps: phones ? 30 : 40}, {lines: phones ? 4 : 8, steps: phones ? 18 : 30, dpr: 1, dots: 0, fps: 24}];
  var BANDS = [{c:[120,220,60], a:.5, amp:.20, fq:1.15, sp:.10, base:.28, spr:.55, ph:0, sh:.0011}, {c:[40,170,110], a:.34, amp:.26, fq:.85, sp:-.08, base:.62, spr:.75, ph:2.1, sh:.0016}, {c:[70,150,220], a:.28, amp:.18, fq:1.6, sp:.06, base:.46, spr:.45, ph:4.2, sh:.0009}];
  var dots = [];
  function resize(){
    var L = LEVELS[level]; dpr = Math.min(window.devicePixelRatio || 1, L.dpr); W = innerWidth; H = innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dots = []; for (var i = 0; i < L.dots; i++) dots.push({x: Math.random(), y: Math.random(), r: Math.random() * 1.4 + .4, s: Math.random() * 6, v: Math.random() * .02 + .005});
  }
  function frame(ts){
    if (dead) return;
    requestAnimationFrame(frame);
    if (!running || document.hidden || document.body.classList.contains('locked')) return;
    var L = LEVELS[level];
    if (ts - last < 1000 / L.fps) return;
    last = ts;
    if (scrolling > 0){ scrolling--; if (phones) return; }
    render(ts);
  }
  function render(ts){
    var L = LEVELS[level], t0 = performance.now(), dark = document.documentElement.getAttribute('data-theme') === 'dark', t = ts / 1000;
    ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, W, H);
    if (dark) ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 1;
    var alphaK = dark ? 1 : .55;
    for (var bi = 0; bi < BANDS.length; bi++){
      var b = BANDS[bi], n = bi === 2 ? Math.round(L.lines * .6) : L.lines, shift = sy * b.sh, wander = Math.sin(sy * .0007 + b.ph) * .22 + Math.cos(sy * .0003 + b.ph * 2) * .1;
      for (var i = 0; i < n; i++){
        var k = i / (n - 1) - .5, edge = 1 - Math.abs(k) * 1.7;
        ctx.beginPath();
        for (var s = 0; s <= L.steps; s++){
          var u = s / L.steps, px = u * W * 1.25 - W * .12;
          var cy = H * (b.base + wander + b.amp * Math.sin(u * 6.283 * b.fq + t * b.sp + b.ph + shift * 6));
          var fan = k * H * .22 * b.spr * (.25 + .75 * Math.abs(Math.sin(u * 3.6 * b.fq + b.ph + t * .05 + shift * 3)));
          var py = cy + fan + (my - .5) * 24 * (1 - u);
          if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.strokeStyle = 'rgba(' + b.c[0] + ',' + b.c[1] + ',' + b.c[2] + ',' + (b.a * alphaK * (.25 + .75 * Math.max(edge, 0))).toFixed(3) + ')';
        ctx.stroke();
      }
    }
    for (var j = 0; j < dots.length; j++){
      var q = dots[j], a = (.25 + .5 * Math.abs(Math.sin(t * .8 + q.s))) * alphaK;
      q.x += q.v * .002; if (q.x > 1.02) q.x = -.02;
      ctx.fillStyle = 'rgba(' + (dark ? '160,240,90' : '61,154,14') + ',' + a.toFixed(2) + ')';
      ctx.beginPath(); ctx.arc(q.x * W, ((q.y + sy * .00006 * (j % 5 + 1)) % 1) * H, q.r, 0, 6.283); ctx.fill();
    }
    // self-check: if drawing is expensive or the device cannot keep up, lower quality, then stop
    costSum += performance.now() - t0; costN++;
    if (costN >= 40){
      var avg = costSum / costN; costSum = 0; costN = 0;
      if (avg > (phones ? 5 : 7)){ if (++slow >= 2){ slow = 0; if (level < LEVELS.length - 1){ level++; resize(); } else stillPicture(); } } else slow = 0;
    }
  }
  function stillPicture(){ dead = true; render(1000); }
  function draw1(){ render(1000); }
  window.addEventListener('resize', function(){ resize(); if (dead || reduce || saver) draw1(); });
  window.addEventListener('scroll', function(){ sy = window.pageYOffset; scrolling = 3; }, {passive: true});
  window.addEventListener('pointermove', function(e){ mx = e.clientX / W; my = e.clientY / H; }, {passive: true});
  new MutationObserver(function(){ if (dead || reduce || saver) draw1(); }).observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
  resize();
  if (reduce || saver){ dead = true; draw1(); } else requestAnimationFrame(frame);
})();
