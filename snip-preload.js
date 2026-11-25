// The screen-region picker: gets the screenshot, sends back the box the user drew (in window pixels), 'all' or null.
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('snip', {
  onImage: (fn) => ipcRenderer.on('snip:image', (_e, src) => fn(src)),
  done: (rect) => ipcRenderer.send('snip:done', rect),
})
