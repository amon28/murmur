// Draws the selection box over the screenshot. The box is reported in window pixels; main.js scales it to the image.
const shot = document.getElementById('shot'), box = document.getElementById('box'), dim = document.getElementById('dim'), size = document.getElementById('size')
let start = null, rect = null
window.snip.onImage((src) => { shot.src = src; box.style.backgroundImage = `url(${src})`; box.style.backgroundSize = `${innerWidth}px ${innerHeight}px` })
addEventListener('mousedown', (e) => { if (e.button !== 0) return window.snip.done(null); start = { x: e.clientX, y: e.clientY }; rect = null })
addEventListener('mousemove', (e) => {
  if (!start) return
  const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY), w = Math.abs(e.clientX - start.x), h = Math.abs(e.clientY - start.y)
  rect = { x, y, width: w, height: h }
  Object.assign(box.style, { display: 'block', left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px', backgroundPosition: `-${x}px -${y}px` })
  dim.style.display = 'none'
  Object.assign(size.style, { display: 'block', left: x + 'px', top: Math.max(0, y - 22) + 'px' }); size.textContent = `${Math.round(w)} × ${Math.round(h)}`
})
addEventListener('mouseup', () => { if (!start) return; start = null; window.snip.done(rect && rect.width > 4 && rect.height > 4 ? rect : 'all') })
addEventListener('keydown', (e) => { if (e.key === 'Escape') window.snip.done(null); if (e.key === 'Enter') window.snip.done(rect || 'all') })
addEventListener('contextmenu', (e) => { e.preventDefault(); window.snip.done(null) })
