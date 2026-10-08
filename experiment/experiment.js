const canvas = document.querySelector('canvas');
const ctx = canvas.getContext('2d');
const video = document.querySelector('video');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const pauseButton = document.querySelector('#pause');
const timeline = document.querySelector('#timeline');
const status = document.querySelector('#phase');
const interaction = document.querySelector('#interactive');
const stageArt = document.querySelector('.stage-art');
const layer = document.createElement('canvas'), layerCtx = layer.getContext('2d');
const treatment = document.createElement('canvas'), treatmentCtx = treatment.getContext('2d', { willReadFrequently: true });
const effects = { mode: 'clean', pixelSize: 6, lens: true };
let offsetX = 0, offsetY = 0, dirty = true;
let animation, items = [], time = 0, previous = 0, paused = motion.matches;
let reference = false, scale = 1, dpr = 1, lastFrame = -1;
let referenceReady;
let pointer = null;
const sourceFPS = 60;
const duration = 250 / sourceFPS;
const playbackFPS = 60;

function parsePath(source) {
  const commands = [], coordinates = [];
  for (const segment of source.matchAll(/([MCZ])([^MCZ]*)/g)) {
    commands.push(segment[1]);
    if (segment[2]) coordinates.push(...segment[2].split(',').map(Number));
  }
  return { commands, coordinates, signature: commands.join(''), path: new Path2D(source) };
}
function interpolatedPath(item, index, fraction) {
  if (item.cachedIndex !== index) {
    const next = Math.min(index + 1, item.paths.length - 1);
    item.from = item.cachedNext === index ? item.to : parsePath(item.paths[index]);
    item.to = next === index ? item.from : parsePath(item.paths[next]);
    item.cachedIndex = index;
    item.cachedNext = next;
  }
  const a = item.from, b = item.to;
  if (!fraction || a === b) return a.path;
  // Clipping can change a path's topology. Keep those transitions intact.
  if (a.signature !== b.signature || a.coordinates.length !== b.coordinates.length) {
    return fraction < 0.5 ? a.path : b.path;
  }
  const path = new Path2D();
  let offset = 0;
  const coordinate = () => {
    const value = a.coordinates[offset] + (b.coordinates[offset] - a.coordinates[offset]) * fraction;
    offset++;
    return value;
  };
  for (const command of a.commands) {
    if (command === 'M') path.moveTo(coordinate(), coordinate());
    else if (command === 'C') path.bezierCurveTo(coordinate(), coordinate(), coordinate(), coordinate(), coordinate(), coordinate());
    else path.closePath();
  }
  return path;
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  layer.width = canvas.width; layer.height = canvas.height;
  scale = Math.min(canvas.width / 1080, canvas.height / 940);
  offsetX = canvas.width / 2 - 960 * scale;
  offsetY = canvas.height / 2 - 540 * scale;
  draw();
}
function makeTreatment(mode) {
  const pixelSize = mode === 'dither' ? Math.max(2, effects.pixelSize / 2) : effects.pixelSize;
  const w = Math.max(1, Math.round(canvas.width / (pixelSize * dpr)));
  const h = Math.max(1, Math.round(canvas.height / (pixelSize * dpr)));
  if (treatment.width !== w || treatment.height !== h) { treatment.width = w; treatment.height = h; }
  treatmentCtx.clearRect(0, 0, w, h);
  treatmentCtx.drawImage(layer, 0, 0, w, h);
  if (mode === 'dither') {
    const image = treatmentCtx.getImageData(0, 0, w, h), pixels = image.data;
    const bayer = [0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];
    const palette = [[55,54,57], [122,121,115], [159,158,151], [220,219,213]];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y*w+x)*4;
      if (!pixels[i+3]) continue;
      const r = pixels[i], g = pixels[i+1], b = pixels[i+2];
      const threshold = (bayer[(y%4)*4+x%4]/16-.5)*65;
      const luminance = r*.2126+g*.7152+b*.0722+threshold;
      const tone = palette[Math.max(0,Math.min(3,Math.round((luminance-55)/165*3)))];
      [pixels[i],pixels[i+1],pixels[i+2]] = tone;
    }
    treatmentCtx.putImageData(image,0,0);
  }
}
function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!animation) return;
  layerCtx.setTransform(1,0,0,1,0,0);
  layerCtx.clearRect(0,0,layer.width,layer.height);
  const sourceFrame = Math.min(248, time * sourceFPS);
  const frame = Math.floor(sourceFrame + 0.000001);
  const fraction = Math.max(0, sourceFrame - frame);
  for (const item of items) {
    if (frame < item.start) continue;
    const index = Math.min(frame - item.start, item.paths.length - 1);
    const path = interpolatedPath(item, index, fraction);
    layerCtx.setTransform(scale, 0, 0, scale, offsetX + item.dx * scale, offsetY + item.dy * scale);
    const center = item.centers[index];
    layerCtx.translate(center[0], center[1]);
    layerCtx.rotate(item.angle);
    layerCtx.translate(-center[0], -center[1]);
    layerCtx.fillStyle = item.color;
    layerCtx.fill(path);
  }
  ctx.setTransform(1,0,0,1,0,0);
  const local = effects.lens;
  if (effects.mode === 'clean' || local) ctx.drawImage(layer,0,0);
  if (effects.mode !== 'clean' || (local && pointer)) {
    makeTreatment(effects.mode === 'clean' ? 'dither' : effects.mode);
    if (!local || pointer) {
      ctx.save();
      if (local) {
        ctx.beginPath();ctx.arc(offsetX+pointer.x*scale,offsetY+pointer.y*scale,78*dpr,0,Math.PI*2);ctx.clip();
        ctx.clearRect(0,0,canvas.width,canvas.height);
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(treatment,0,0,canvas.width,canvas.height);
      ctx.restore();
    }
  }
  dirty = false;
  lastFrame = Math.floor(time * playbackFPS);
}
function updateUI() {
  pauseButton.textContent = paused ? 'Play' : 'Pause';
  pauseButton.setAttribute('aria-label', paused ? 'Play animation' : 'Pause animation');
  pauseButton.hidden = time >= duration - 0.000001;
  timeline.value = time;
  document.querySelector('#time').textContent = `${time.toFixed(1)} / ${duration.toFixed(1)} s`;
  if (animation && status) status.textContent = reference ? 'THE ORIGINAL / 60 FPS' : time < duration ? 'FINDING ITS FORM' : interaction.checked ? 'FORM ↔ PLAY' : 'FOUR FORMS / ONE IDENTITY';
}
function syncVideo() {
  if (!video.dataset.ready) return;
  video.currentTime = Math.min(time, video.duration || duration);
  if (reference && !paused) video.play().catch(() => { paused = true; updateUI(); });
  else video.pause();
}
function tick(now) {
  const dt = Math.min((now - previous) / 1000 || 0, 0.05);
  previous = now;
  if (animation && !document.hidden) {
    if (!paused && time < duration && (!reference || video.dataset.ready)) {
      time = reference ? video.currentTime : Math.min(duration, time + dt);
      if (time >= duration || (reference && video.ended)) {
        time = duration;
        paused = true;
      }
    }
    let moving = false;
    const frame = Math.min(248, Math.floor(time * sourceFPS + 0.001));
    for (const item of reference ? [] : items) {
      if (item.fixed || frame < item.start) continue;
      if (interaction.checked && pointer) {
        const c = item.centers[Math.min(frame - item.start, item.centers.length - 1)];
        const dx = c[0] + item.dx - pointer.x, dy = c[1] + item.dy - pointer.y;
        const distance = Math.hypot(dx, dy);
        if (distance > 0 && distance < 180) {
          const force = (1 - distance / 180) * 6000;
          item.vx += dx / distance * force * dt;
          item.vy += dy / distance * force * dt;
          item.spin += dx / distance * (1 - distance / 180) * 20 * dt;
        }
      }
      item.vx += (-item.dx * 18 - item.vx * 6) * dt;
      item.vy += (-item.dy * 18 - item.vy * 6) * dt;
      item.spin += (-item.angle * 18 - item.spin * 6) * dt;
      item.dx += item.vx * dt; item.dy += item.vy * dt;
      item.angle = Math.max(-0.4, Math.min(0.4, item.angle + item.spin * dt));
      moving ||= Math.abs(item.dx) + Math.abs(item.dy) + Math.abs(item.angle) * 100 > 0.01;
      if (Math.abs(item.dx) + Math.abs(item.dy) + Math.abs(item.vx) + Math.abs(item.vy) + Math.abs(item.angle) + Math.abs(item.spin) < 0.01) {
        item.dx = item.dy = item.vx = item.vy = item.angle = item.spin = 0;
      }
    }
    if (!reference && (Math.floor(time * playbackFPS) !== lastFrame || moving || dirty)) draw();
    updateUI();
  }
  requestAnimationFrame(tick);
}
pauseButton.onclick = () => {
  if (time >= duration) return;
  paused = !paused; syncVideo(); updateUI();
};
timeline.oninput = () => {
  time = Number(timeline.value); paused = true; syncVideo(); draw(); updateUI();
};
const viewControl = document.querySelector('#view');
if (viewControl) viewControl.onchange = async e => {
  reference = e.target.value === 'reference';
  video.hidden = !reference; canvas.hidden = reference;
  interaction.disabled = reference;
  if (reference) {
    // The simple local server has no byte-range support. A local blob makes
    // seeking reliable without changing the user's preview server.
    referenceReady ||= fetch(video.getAttribute('src')).then(r => {
      if (!r.ok) throw new Error('Reference video could not load');
      return r.blob();
    }).then(blob => new Promise(resolve => {
      video.onloadedmetadata = () => { video.dataset.ready = 'true'; resolve(); };
      video.src = URL.createObjectURL(blob);
    }));
    try { await referenceReady; } catch (error) { if (status) status.textContent = error.message; return; }
  }
  syncVideo(); if (!reference) resize(); updateUI();
};
interaction.onchange = () => {
  if (!interaction.checked) items.forEach(p => { p.dx = p.dy = p.vx = p.vy = p.angle = p.spin = 0; });
  draw(); updateUI();
};
canvas.onpointermove = e => {
  const rect = canvas.getBoundingClientRect();
  pointer = { x: ((e.clientX - rect.left)*dpr-offsetX)/scale, y: ((e.clientY - rect.top)*dpr-offsetY)/scale };
  document.querySelector('#coordinates').textContent = `X ${Math.round(pointer.x).toString().padStart(3,'0')} / Y ${Math.round(pointer.y).toString().padStart(3,'0')}`;
  if (effects.lens) dirty = true;
};
canvas.onpointerleave = () => { pointer = null; dirty = true; document.querySelector('#coordinates').textContent = 'X 000 / Y 000'; };

document.querySelectorAll('[data-mode]').forEach(button => {
  button.onclick = () => {
    effects.mode = button.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    draw();
  };
});
document.querySelector('#pixel-size').onchange = e => { effects.pixelSize = Number(e.target.value); draw(); };
document.querySelector('#lens').onchange = e => { effects.lens = e.target.checked; draw(); };
document.querySelector('#grid').onchange = e => { stageArt.classList.toggle('grid',e.target.checked); };
document.querySelectorAll('.hotspot').forEach(hotspot => {
  const button = hotspot.querySelector('.mark-toggle');
  const expand = value => button.setAttribute('aria-expanded',String(value));
  hotspot.onpointerenter = () => expand(true);
  hotspot.onpointerleave = () => expand(hotspot.classList.contains('open') || hotspot.contains(document.activeElement));
  hotspot.onfocusin = () => expand(true);
  hotspot.onfocusout = e => { if (!hotspot.contains(e.relatedTarget)) expand(hotspot.classList.contains('open')); };
  button.onclick = () => { hotspot.classList.toggle('open'); expand(hotspot.classList.contains('open')); };
  hotspot.onkeydown = e => { if (e.key === 'Escape') { hotspot.classList.remove('open'); button.blur(); expand(false); } };
});
document.addEventListener('pointerdown',e => {
  document.querySelectorAll('.hotspot.open').forEach(h => {
    if (!h.contains(e.target)) { h.classList.remove('open'); h.querySelector('.mark-toggle').setAttribute('aria-expanded','false'); }
  });
});
motion.onchange = e => { paused = e.matches; syncVideo(); updateUI(); };
document.addEventListener('visibilitychange', () => {
  previous = performance.now();
  if (document.hidden) video.pause(); else syncVideo();
});
new ResizeObserver(resize).observe(canvas);
async function load() {
  try {
    const response = await fetch(canvas.dataset.motion || 'motion.json.gz');
    if (!response.ok) throw new Error(`Motion data: ${response.status}`);
    // Some hosts decode .gz files at the HTTP layer; accept either form.
    const bytes = new Uint8Array(await response.arrayBuffer());
    const encoded = new Response(bytes);
    animation = bytes[0] === 0x1f && bytes[1] === 0x8b
      ? await new Response(encoded.body.pipeThrough(new DecompressionStream('gzip'))).json()
      : await encoded.json();
    items = animation.items.map(p => {
      const color = p.color === '#c66350' ? '#7a7973' : p.color === '#6790b7' ? '#9f9e97' : p.color;
      const rgb = color.match(/[a-f\d]{2}/gi).map(c => parseInt(c,16));
      return { ...p, color, strokeColor: rgb.reduce((sum,v) => sum+v,0) > 420 ? '#646464' : color, dx: 0, dy: 0, vx: 0, vy: 0, angle: 0, spin: 0, cachedIndex: -1 };
    });
    if (motion.matches) time = duration;
    document.querySelectorAll('button, input, select').forEach(el => { el.disabled = false; });
    resize(); updateUI();
  } catch (error) {
    if (status) status.textContent = 'Canvas unavailable — original video below';
    canvas.hidden = true; video.hidden = false; video.controls = true;
    console.error(error);
  }
}
resize(); updateUI(); requestAnimationFrame(tick); load();
const yearLabel = document.querySelector('#year');
if (yearLabel) yearLabel.textContent = new Date().getFullYear();
