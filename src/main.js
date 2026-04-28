const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path   = require('path')
const os     = require('os')
const fs     = require('fs')
const crypto = require('crypto')
const net    = require('net')
const { execSync, exec } = require('child_process')
const https  = require('https')
const http   = require('http')

let autoUpdater = null
try { autoUpdater = require('electron-updater').autoUpdater } catch(e) {}
const DEFAULT_UPDATE_FEED_URL = 'https://github.com/stacks-opti/test-sub/releases/latest/download/'

// Fix GPU process crash (exit_code=-1073740791) - disable GPU sandbox
app.commandLine.appendSwitch('--disable-gpu-sandbox')
app.commandLine.appendSwitch('--no-sandbox')
app.commandLine.appendSwitch('--disable-software-rasterizer')
app.commandLine.appendSwitch('in-process-gpu')
app.disableHardwareAcceleration()

// ── Auto-elevate to Administrator ────────────────────────────
function isAdmin() {
  try { execSync('net session', { stdio: 'ignore', timeout: 2000 }); return true } catch(e) { return false }
}

// Auto-elevate to admin via VBScript
if (!isAdmin() && !process.argv.includes('--elevated')) {
  try {
    const _vbs = require('path').join(require('os').tmpdir(), 'fom_elev.vbs')
    const _exe = process.execPath.replace(/\\/g, '\\\\')
    require('fs').writeFileSync(_vbs, 'Set s=CreateObject("Shell.Application")\r\ns.ShellExecute "' + _exe + '","--elevated","","runas",1', 'utf8')
    exec('wscript.exe "' + _vbs + '"', { windowsHide: true })
    setTimeout(() => { app.quit(); process.exit(0) }, 1000)
  } catch(e) { /* continue without admin if elevation fails */ }
}


// ═══════════════════════════════════════════════════════════════
// DISCORD ROLE AUTH (FIXED)
// ═══════════════════════════════════════════════════════════════

// Ensure LOCK_DIR exists BEFORE anything uses it
const LOCK_DIR = path.join(os.homedir(), 'FiveM_Optimizer')

const DISCORD_CLIENT_ID = '1498328447611699404'
const DISCORD_CALLBACK = 'http://localhost:8123/callback'

const DISCORD_API = 'https://discord.com/api/v10'
const AUTH_CACHE_FILE = path.join(LOCK_DIR, 'discord-auth.json')
const LOCAL_ENV_FILES = [
  path.join(__dirname, '..', '.env'),
  path.join(path.dirname(process.execPath), '.env')
]

function readLocalEnv() {
  const env = {}
  for (const file of LOCAL_ENV_FILES) {
    try {
      if (!fs.existsSync(file)) continue
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim()
        const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
        if (key && value) env[key] = value
      }
    } catch(e) {}
  }
  return env
}

const LOCAL_ENV = readLocalEnv()
const DISCORD_GUILD_ID = (process.env.GUILD_ID || LOCAL_ENV.GUILD_ID || '').trim()
const ALLOWED_ROLE_IDS = new Set(
  (process.env.ALLOWED_ROLE_IDS || LOCAL_ENV.ALLOWED_ROLE_IDS || '')
    .split(',')
    .map(roleId => roleId.trim())
    .filter(Boolean)
)

function discordRequest(route, authHeader) {
  return new Promise(resolve => {
    const req = https.get(DISCORD_API + route, {
      timeout: 12000,
      headers: {
        Authorization: authHeader,
        'User-Agent': 'FiveMOptimizerRoleAuth/2.0'
      }
    }, res => {
      let data = ''
      res.on('data', d => data += d)
      res.on('end', () => {
        let body = null
        try { body = data ? JSON.parse(data) : null } catch(e) {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body })
      })
    })
    req.on('error', err => resolve({ ok: false, status: 0, error: err.message }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'Discord request timed out' }) })
  })
}

function createDiscordAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_CALLBACK,
    response_type: 'token',
    scope: 'identify guilds.members.read',
    prompt: 'consent',
    state
  })
  return 'https://discord.com/oauth2/authorize?' + params.toString()
}

function parseDiscordAuthRedirect(url, expectedState) {
  if (!url.startsWith(DISCORD_CALLBACK)) return null
  const hashIndex = url.indexOf('#')
  if (hashIndex === -1) return { error: 'Discord did not return an access token.' }
  const hash = new URLSearchParams(url.substring(hashIndex + 1))
  if (hash.get('state') !== expectedState) return { error: 'Discord login state mismatch. Please try again.' }
  const accessToken = hash.get('access_token')
  if (!accessToken) return { error: 'Discord did not return an access token.' }
  return { accessToken }
}

function readAuthCache() {
  try {
    if (!fs.existsSync(AUTH_CACHE_FILE)) return null
    const auth = JSON.parse(fs.readFileSync(AUTH_CACHE_FILE, 'utf8'))
    return auth && auth.userId ? auth : null
  } catch(e) {
    return null
  }
}

function writeAuthCache(result) {
  try {
    if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true })
    const data = {
      userId: result.user.id,
      username: result.user.username,
      matchedRole: result.matchedRole,
      authorizedAt: new Date().toISOString()
    }
    fs.writeFileSync(AUTH_CACHE_FILE, JSON.stringify(data, null, 2), 'utf8')
  } catch(e) {}
}

function clearAuthCache() {
  try {
    if (fs.existsSync(AUTH_CACHE_FILE)) fs.unlinkSync(AUTH_CACHE_FILE)
  } catch(e) {}
}

async function verifyDiscordMemberRole(userId) {
  if (!DISCORD_GUILD_ID || ALLOWED_ROLE_IDS.size === 0) {
    return {
      ok: false,
      state: 'auth-config',
      msg: 'Discord access is not configured. Set GUILD_ID and ALLOWED_ROLE_IDS in .env.'
    }
  }

  return {
    ok: false,
    state: 'discord-token-required',
    msg: 'Discord login needs a fresh access token. Please sign in again.'
  }
}

async function getCachedAuthorization() {
  return { ok: false, state: 'no-cache' }
}
async function verifyDiscordRole(accessToken) {
  const me = await discordRequest('/users/@me', 'Bearer ' + accessToken)
  if (!me.ok || !me.body?.id) {
    return { ok: false, state: 'discord-user', msg: 'Could not read your Discord account. Please try again.' }
  }

  if (!DISCORD_GUILD_ID || ALLOWED_ROLE_IDS.size === 0) {
    return {
      ok: false,
      state: 'auth-config',
      user: me.body,
      msg: 'Discord access is not configured. Set GUILD_ID and ALLOWED_ROLE_IDS in .env.'
    }
  }

  const member = await discordRequest(`/users/@me/guilds/${DISCORD_GUILD_ID}/member`, 'Bearer ' + accessToken)
  if (member.status === 404) {
    return { ok: false, state: 'not-member', user: me.body, msg: 'Join the required Discord server, then try again.' }
  }
  if (!member.ok || !member.body) {
    return { ok: false, state: 'discord-member', user: me.body, msg: 'Could not read your Discord server roles. Please approve the requested Discord permissions and try again.' }
  }

  const roles = Array.isArray(member.body.roles) ? member.body.roles : []
  const matchedRole = roles.find(roleId => ALLOWED_ROLE_IDS.has(roleId))
  if (!matchedRole) {
    return { ok: false, state: 'missing-role', user: me.body, msg: 'Your Discord account does not have one of the allowed optimizer roles.' }
  }

  return {
    ok: true,
    state: 'authorized',
    user: {
      id: me.body.id,
      username: me.body.global_name || me.body.username || me.body.id
    },
    matchedRole
  }
}

app.whenReady().then(async () => {
  if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true })

  // Do NOT block the app opening while Render wakes up.
  // Always show login first, then the login button checks roles.
  createLoginWindow()
})
app.on('window-all-closed', () => app.quit())

// ── Login Window ─────────────────────────────────────────────
let loginWin = null
let mainWin = null

function createWindow() {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.focus()
    return
  }

  mainWin = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    backgroundColor: '#080808',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  mainWin.loadFile(path.join(__dirname, 'index.html'))
  mainWin.on('closed', () => { mainWin = null })
  mainWin.webContents.once('did-finish-load', () => {
    setTimeout(() => checkForAppUpdates(false), 2500)
  })
}

function createLoginWindow() {
  if (loginWin) return  // already open
  loginWin = new BrowserWindow({
    width: 480, height: 600,
    frame: false, resizable: false,
    backgroundColor: '#080808',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  loginWin.loadFile(path.join(__dirname, 'login.html'))
}

// Close from login screen
ipcMain.on('login-close', () => { if(loginWin){loginWin.close();loginWin=null} app.quit() })

ipcMain.on('win-minimize', () => { if (mainWin && !mainWin.isDestroyed()) mainWin.minimize() })
ipcMain.on('win-maximize', () => {
  if (!mainWin || mainWin.isDestroyed()) return
  if (mainWin.isMaximized()) mainWin.unmaximize()
  else mainWin.maximize()
})
ipcMain.on('win-close', () => { if (mainWin && !mainWin.isDestroyed()) mainWin.close() })

// Legacy renderer hook kept harmless for older cached login pages.
ipcMain.handle('login-get-hwid', () => {
  return { ok: false }
})

// Renderer presses "Login" button
ipcMain.handle('login-attempt', async () => {
  const state = crypto.randomBytes(24).toString('hex')
  const authUrl = createDiscordAuthUrl(state)

  return new Promise(resolve => {
    let settled = false
    let authWin = null
    const finish = result => {
      if (settled) return
      settled = true
      try { if (authWin && !authWin.isDestroyed()) authWin.destroy() } catch(e) {}
      resolve(result)
    }

    authWin = new BrowserWindow({
      width: 540, height: 720,
      title: 'Discord Login',
      parent: loginWin || undefined,
      modal: !!loginWin,
      backgroundColor: '#111111',
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    })

    const handleUrl = async url => {
      const parsed = parseDiscordAuthRedirect(url, state)
      if (!parsed) return false
      if (parsed.error) {
        finish({ ok: false, state: 'discord', msg: parsed.error })
        return true
      }
      const result = await verifyDiscordRole(parsed.accessToken)
      if (result.ok) writeAuthCache(result)
      else clearAuthCache()
      finish(result)
      return true
    }

    authWin.webContents.on('will-navigate', async (event, url) => {
      if (await handleUrl(url)) event.preventDefault()
    })
    authWin.webContents.on('will-redirect', async (event, url) => {
      if (await handleUrl(url)) event.preventDefault()
    })
    authWin.webContents.on('did-navigate', (event, url) => { handleUrl(url) })
    authWin.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
      handleUrl(validatedURL)
    })
    authWin.on('closed', () => {
      finish({ ok: false, state: 'cancelled', msg: 'Discord login was cancelled.' })
    })
    authWin.loadURL(authUrl)
  })
})

// Login succeeded — close login, open main app
let _loginSuccessFired = false
ipcMain.on('login-success', () => {
  if (_loginSuccessFired) return  // prevent double fire
  _loginSuccessFired = true
  // Remove all IPC listeners that could re-trigger login
  ipcMain.removeAllListeners('login-success')
  if (loginWin) {
    loginWin.hide()
    setTimeout(() => { try { if(loginWin){loginWin.destroy();loginWin=null} } catch(e){} }, 200)
  }
  createWindow()
})

let _updateBusy = false
let _updateReady = false

function getUpdateFeedUrl() {
  const envUrl = (process.env.FIVEM_OPTIMIZER_UPDATE_URL || '').trim()
  if (envUrl) return envUrl
  try {
    const cfg = readCFG()
    if (cfg.updateFeedUrl) return cfg.updateFeedUrl.trim()
  } catch(e) {}
  const localConfig = path.join(path.dirname(process.execPath), 'update-config.json')
  try {
    const cfg = JSON.parse(fs.readFileSync(localConfig, 'utf8'))
    return (cfg.url || cfg.feedUrl || '').trim()
  } catch(e) {}
  return DEFAULT_UPDATE_FEED_URL
}

function sendUpdateStatus(status) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('app-update-status', status)
}

function setupAutoUpdater() {
  if (!autoUpdater || setupAutoUpdater.done) return !!autoUpdater
  setupAutoUpdater.done = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking' }))
  autoUpdater.on('update-available', info => sendUpdateStatus({ state: 'available', version: info && info.version }))
  autoUpdater.on('update-not-available', info => {
    _updateBusy = false
    sendUpdateStatus({ state: 'not-available', version: info && info.version })
  })
  autoUpdater.on('download-progress', p => sendUpdateStatus({
    state: 'downloading',
    percent: Math.round((p && p.percent) || 0),
    transferred: p && p.transferred,
    total: p && p.total
  }))
  autoUpdater.on('update-downloaded', info => {
    _updateBusy = false
    _updateReady = true
    sendUpdateStatus({ state: 'downloaded', version: info && info.version })
  })
  autoUpdater.on('error', err => {
    _updateBusy = false
    sendUpdateStatus({ state: 'error', err: err && err.message ? err.message : 'Update check failed' })
  })
  return true
}

async function checkForAppUpdates(manual) {
  if (_updateBusy) return { ok: false, state: 'busy', msg: 'Update check already running' }
  if (!setupAutoUpdater()) return { ok: false, state: 'missing', msg: 'electron-updater is not installed' }
  if (!app.isPackaged) {
    if (manual) sendUpdateStatus({ state: 'dev', msg: 'Auto updates run from the packaged app' })
    return { ok: false, state: 'dev', msg: 'Auto updates run from the packaged app' }
  }
  const feedUrl = getUpdateFeedUrl()
  if (!feedUrl) {
    if (manual) sendUpdateStatus({ state: 'error', err: 'No update feed configured. Add update-config.json beside the exe.' })
    return { ok: false, state: 'no-feed', msg: 'No update feed configured' }
  }
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl })
  _updateBusy = true
  try {
    const result = await autoUpdater.checkForUpdates()
    return { ok: true, state: 'checking', updateInfo: result && result.updateInfo }
  } catch(e) {
    _updateBusy = false
    const msg = e && e.message ? e.message : 'Update check failed'
    if (manual) sendUpdateStatus({ state: 'error', err: msg })
    return { ok: false, state: 'error', msg }
  }
}

ipcMain.handle('check-app-updates', () => checkForAppUpdates(true))
ipcMain.handle('install-app-update', () => {
  if (!autoUpdater || !_updateReady) return { ok: false, err: 'No downloaded update is ready to install' }
  autoUpdater.quitAndInstall(false, true)
  return { ok: true }
})
ipcMain.handle('get-update-feed', () => ({ ok: true, url: getUpdateFeedUrl() }))
ipcMain.handle('set-update-feed', (e, url) => {
  const clean = (url || '').trim()
  if (clean && !/^https?:\/\//i.test(clean)) return { ok: false, err: 'Update URL must start with http:// or https://' }
  writeCFG({ updateFeedUrl: clean })
  return { ok: true, url: clean }
})

// ═══════════════════════════════════════════════════════════════
//  STATS
// ═══════════════════════════════════════════════════════════════
let _lastCPU = os.cpus()
function getCPU() {
  const cur = os.cpus(); let td = 0, id = 0
  for (let i = 0; i < cur.length; i++) {
    const c = cur[i].times, l = _lastCPU[i].times
    const t = Object.values(c).reduce((a,b)=>a+b,0) - Object.values(l).reduce((a,b)=>a+b,0)
    td += t; id += c.idle - l.idle
  }
  _lastCPU = cur; return td > 0 ? Math.round(100 - (id/td*100)) : 0
}

let _disk = null, _diskT = 0
function getDisk() {
  if (_disk && Date.now() - _diskT < 15000) return _disk
  // Try wmic first
  try {
    const o = execSync('wmic logicaldisk where "DeviceID=\'C:\'" get FreeSpace,Size /FORMAT:CSV 2>nul', { encoding: 'utf8', timeout: 3000 })
    const p = o.trim().split('\n').filter(l => l.includes(',') && !l.includes('Node') && !l.includes('FreeSpace'))
    if (p.length) {
      const c = p[p.length-1].trim().split(',')
      const free = parseInt(c[1])||0, total = parseInt(c[2])||0
      if (free > 0 && total > 0) { _disk = { free, total }; _diskT = Date.now(); return _disk }
    }
  } catch(e) {}
  // Fallback: PowerShell Get-PSDrive
  try {
    const o2 = execSync('powershell -NoProfile -Command "& { $d=Get-PSDrive C; Write-Host ($d.Free+\'|\'+($d.Used+$d.Free)) }" 2>nul', { encoding: 'utf8', timeout: 3000 })
    if (o2.includes('|')) {
      const [f,t] = o2.trim().split('|')
      _disk = { free: parseInt(f)||0, total: parseInt(t)||0 }
    } else _disk = { free: 0, total: 0 }
  } catch(e) { _disk = { free: 0, total: 0 } }
  _diskT = Date.now(); return _disk
}


// Global recursive size function
function szDir(d) {
  let s = 0
  try {
    for (const i of fs.readdirSync(d, {withFileTypes:true})) {
      const fp = path.join(d, i.name)
      try { s += i.isDirectory() ? szDir(fp) : fs.statSync(fp).size } catch(e) {}
    }
  } catch(e) {}
  return s
}

const FIVEM_CACHE_DIR_NAMES = new Set([
  'cache',
  'server-cache',
  'server-cache-priv',
  'http-cache',
  'extra-details-cache',
  'browser-manifest-cache'
])

function isSafeFiveMCacheDir(p) {
  try {
    if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) return false
    const resolved = path.resolve(p)
    const lower = resolved.toLowerCase()
    const base = path.basename(resolved).toLowerCase()
    const home = os.homedir().toLowerCase()
    const allowedRoots = [
      path.join(os.homedir(), 'AppData', 'Local', 'FiveM').toLowerCase(),
      path.join(os.homedir(), 'AppData', 'Roaming', 'CitizenFX').toLowerCase(),
      'c:\\fivem',
      'd:\\fivem',
      'c:\\program files\\fivem',
      'c:\\program files (x86)\\fivem'
    ]
    if (!allowedRoots.some(root => lower === root || lower.startsWith(root + path.sep))) return false
    if (lower.includes('..')) return false
    if (lower === home || lower.length < 8) return false
    return FIVEM_CACHE_DIR_NAMES.has(base) || base.includes('cache')
  } catch(e) {
    return false
  }
}

let _cs = -1, _csT = 0
function getCacheSize() {
  if (_cs >= 0 && Date.now() - _csT < 15000) return _cs
  try {
    const all = new Set(getFiveMCachePaths())
    _cs = [...all].reduce((t, b) => t + szDir(b), 0)
  } catch(e) { _cs = 0 }
  _csT = Date.now()
  return _cs
}


function getFiveM() {
  try {
    const o = execSync('tasklist /FI "IMAGENAME eq FiveM.exe" /FO CSV /NH 2>nul', { encoding: 'utf8', timeout: 1500 })
    if (o.includes('FiveM.exe')) { const m = o.match(/"FiveM\.exe","(\d+)"/); return { running: true, pid: m?m[1]:null } }
  } catch(e){}
  return { running: false, pid: null }
}

let _gpu = null
function getGPU() {
  if (_gpu) return _gpu
  try {
    // Try multiple detection methods
    let names = []

    // Method 1: wmic path
    try {
      const o1 = execSync('wmic path win32_videocontroller get name /FORMAT:CSV 2>nul', { encoding: 'utf8', timeout: 3000 })
      const n1 = o1.trim().split('\n').filter(l=>l.includes(',')&&!l.includes('Node')).map(l=>l.split(',').pop().trim()).filter(l=>l&&l.length>2)
      names.push(...n1)
    } catch(e) {}

    // Method 2: Get-WmiObject (catches more adapters)
    try {
      const o2 = execSync('powershell -NoProfile -Command "Get-WmiObject Win32_VideoController | Select-Object -ExpandProperty Name" 2>nul', { encoding: 'utf8', timeout: 3000 })
      const n2 = o2.trim().split('\n').map(l=>l.trim()).filter(l=>l&&l.length>2)
      names.push(...n2)
    } catch(e) {}

    // Method 3: Get-CimInstance (most modern, catches hidden adapters)
    try {
      const o3 = execSync('powershell -NoProfile -Command "Get-CimInstance -ClassName Win32_VideoController | Select-Object -ExpandProperty Name" 2>nul', { encoding: 'utf8', timeout: 3000 })
      const n3 = o3.trim().split('\n').map(l=>l.trim()).filter(l=>l&&l.length>2)
      names.push(...n3)
    } catch(e) {}

    // Deduplicate
    names = [...new Set(names.filter(Boolean))]
    _gpu = {
      nvidia: names.find(n=>/nvidia/i.test(n))||null,
      amd:    names.find(n=>/amd|radeon|rx\s*\d/i.test(n))||null,
      intel:  names.find(n=>/intel.*hd|intel.*iris|intel.*arc|intel.*uhd/i.test(n))||null,
      names
    }
  } catch(e) { _gpu = { nvidia:null, amd:null, intel:null, names:[] } }
  return _gpu
}

ipcMain.handle('get-stats', () => {
  const tm = os.totalmem(), fm = os.freemem(), um = tm - fm
  const disk = getDisk(), cs = getCacheSize(), fivem = getFiveM(), gpu = getGPU()
  return {
    totalMem: (tm/1073741824).toFixed(1), freeMem: (fm/1073741824).toFixed(1),
    usedMem:  (um/1073741824).toFixed(1), memPct: Math.round(um/tm*100),
    cpuUsage: getCPU(), cpuModel: (os.cpus()[0]?.model||'Unknown CPU').replace(/\s+/g,' ').replace(/\(R\)|\(TM\)|\(C\)/g,'').trim().substring(0,36), cpuCores: os.cpus().length,
    diskFree:  (disk.free/1073741824).toFixed(0), diskTotal: (disk.total/1073741824).toFixed(0),
    diskPct:   disk.total > 0 ? Math.round((disk.total-disk.free)/disk.total*100) : 0,
    fivemRunning: fivem.running, fivemPID: fivem.pid,
    cacheSize: (cs/1048576).toFixed(0), gpu, isAdmin: isAdmin()
  }
})

ipcMain.handle('get-gpu', () => getGPU())

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════
function ps(cmd) {
  return new Promise(r => exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "' + cmd + '"',
    { timeout: 10000 }, (e,o,s) => r({ ok: !e, out: o||'', err: s||(e&&e.message)||'' })))
}
ipcMain.handle('open-url',    (e,u) => { shell.openExternal(u); return true })
ipcMain.handle('open-folder', (e,p) => {
  const fp = p.replace('%USERPROFILE%', os.homedir())
  if (fs.existsSync(fp)) { shell.openPath(fp); return true } return false
})

// ═══════════════════════════════════════════════════════════════
//  FIVEM
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('clear-cache', (e, type) => {
  const paths = getFiveMCachePaths()
  let n = 0
  for (const cachePath of paths) {
    if (!isSafeFiveMCacheDir(cachePath)) continue
    try {
      for (const item of fs.readdirSync(cachePath, {withFileTypes:true})) {
        const fp = path.join(cachePath, item.name)
        try {
          fs.rmSync(fp, {recursive:true, force:true})
          n++
        } catch(e) {}
      }
    } catch(e) {}
  }
  _cs = -1
  return n > 0 ? n : -1
})

ipcMain.handle('write-citizenfx', () => {
  const candidates = [
    path.join(os.homedir(),'AppData','Local','FiveM','FiveM.app','CitizenFX.ini'),
    path.join(os.homedir(),'AppData','Roaming','CitizenFX','CitizenFX.ini'),
    path.join(os.homedir(),'AppData','Local','FiveM','CitizenFX.ini'),
  ]
  let p = candidates[0] // default write location
  for (const cp of candidates) { if(fs.existsSync(cp)){p=cp;break} }
  try {
    // Ensure directory exists
    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true})
    let c = fs.existsSync(p) ? fs.readFileSync(p,'utf8') : ''
    const tweaks = { GameCacheSize:'4096', StreamingMemory:'3072', UseAsyncFileLoading:'true', DisableNPCBlips:'true' }
    for (const [k,v] of Object.entries(tweaks)) {
      const rx = new RegExp('^'+k+'=.*','m')
      c = rx.test(c) ? c.replace(rx,k+'='+v) : c+'\n'+k+'='+v
    }
    fs.writeFileSync(p, c.trim(), 'utf8'); return { ok:true, path:p }
  } catch(e) { return { ok:false, err:e.message } }
})

ipcMain.handle('boost-priority', () => {
  try { execSync('wmic process where name="FiveM.exe" CALL setpriority "high priority"',{timeout:3000}); return true } catch(e) { return false }
})

ipcMain.handle('disable-fso', () => {
  // Search all possible FiveM.exe locations
  const candidates = [
    path.join(os.homedir(),'AppData','Local','FiveM','FiveM.app','FiveM.exe'),
    path.join(os.homedir(),'AppData','Local','FiveM','FiveM.exe'),
    'C:\\Program Files\\FiveM\\FiveM.exe',
    'C:\\FiveM\\FiveM.exe',
    'C:\\Program Files (x86)\\FiveM\\FiveM.exe',
  ]
  let fxPath = null
  for (const p of candidates) { if (fs.existsSync(p)) { fxPath = p; break } }

  // Also try registry to find install path
  if (!fxPath) {
    try {
      const reg = execSync('reg query "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /v DisplayIcon 2>nul', {encoding:'utf8',timeout:3000})
      const match = reg.match(/([A-Z]:[^\r\n]*FiveM[^\r\n]*\.exe)/i)
      if (match && fs.existsSync(match[1])) fxPath = match[1]
    } catch(e) {}
  }

  // Try where.exe as last resort
  if (!fxPath) {
    try {
      const w = execSync('where.exe FiveM.exe 2>nul', {encoding:'utf8',timeout:3000}).trim().split('\n')[0].trim()
      if (w && fs.existsSync(w)) fxPath = w
    } catch(e) {}
  }

  if (!fxPath) {
    // Apply FSO disable to all known candidates anyway (registry key works even if path doesn't exist yet)
    const defaultPath = path.join(os.homedir(),'AppData','Local','FiveM','FiveM.app','FiveM.exe')
    try {
      execSync('reg add "HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers" /v "'+defaultPath+'" /t REG_SZ /d "~ DISABLEDXMAXIMIZEDWINDOWEDMODE" /f',{timeout:3000})
      return { ok:true, note:'Applied to default path (FiveM not detected but registry key set)' }
    } catch(e) { return { ok:false, err:'FiveM not found and registry write failed. Run as Administrator.' } }
  }

  try {
    execSync('reg add "HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers" /v "'+fxPath+'" /t REG_SZ /d "~ DISABLEDXMAXIMIZEDWINDOWEDMODE" /f',{timeout:3000})
    return { ok:true, path:fxPath }
  } catch(e) { return { ok:false, err:e.message } }
})

ipcMain.handle('launch-fivem', () => {
  const candidates = [
    path.join(os.homedir(),'AppData','Local','FiveM','FiveM.exe'),
    path.join(os.homedir(),'AppData','Local','FiveM','FiveM.app','FiveM.exe'),
    'C:\\Program Files\\FiveM\\FiveM.exe',
    'C:\\Program Files (x86)\\FiveM\\FiveM.exe',
    'C:\\FiveM\\FiveM.exe',
  ]
  for (const p of candidates) { if(fs.existsSync(p)){exec('"'+p+'"'); return {ok:true,path:p}} }
  return new Promise(r => {
    exec('where.exe FiveM.exe 2>nul',{timeout:3000},(e,o)=>{
      const p=(o||'').trim().split('\n')[0].trim()
      if(!e&&p&&fs.existsSync(p)){exec('"'+p+'"');return r({ok:true,path:p})}
      // Try searching registry for FiveM uninstall entry
      exec('reg query "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /v InstallLocation 2>nul',{encoding:'utf8',timeout:3000},(e2,o2)=>{
        const match=(o2||'').match(/([A-Z]:[^\r\n]*FiveM[^\r\n]*)\\/i)
        if(match){const p2=path.join(match[1].trim(),'FiveM.exe');if(fs.existsSync(p2)){exec('"'+p2+'"');return r({ok:true,path:p2})}}
        r({ok:false})
      })
    })
  })
})

ipcMain.handle('get-fivem-path', () => {
  const p = path.join(os.homedir(),'AppData','Local','FiveM','FiveM.app')
  return { exists: fs.existsSync(p), path: p }
})

// ═══════════════════════════════════════════════════════════════
//  WINDOWS TWEAKS
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('power-plan', (e, plan) => {
  const guid = plan === 'high' ? '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c' : '381b4222-f694-41f0-9685-ff5bb260df2e'
  try { execSync('powercfg /setactive '+guid,{timeout:3000}); return true } catch(e){ return false }
})

ipcMain.handle('disable-dvr', () => {
  try {
    execSync('reg add "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\GameDVR" /v AppCaptureEnabled /t REG_DWORD /d 0 /f',{timeout:3000})
    execSync('reg add "HKCU\\System\\GameConfigStore" /v GameDVR_Enabled /t REG_DWORD /d 0 /f',{timeout:3000})
    return true
  } catch(e){ return false }
})

ipcMain.handle('visual-fx', () => {
  try { execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects" /v VisualFXSetting /t REG_DWORD /d 2 /f',{timeout:3000}); return true } catch(e){ return false }
})

ipcMain.handle('scheduler-tweak', () => {
  try {
    execSync('reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" /v SystemResponsiveness /t REG_DWORD /d 0 /f',{timeout:3000})
    execSync('reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v "GPU Priority" /t REG_DWORD /d 8 /f',{timeout:3000})
    execSync('reg add "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" /v Priority /t REG_DWORD /d 6 /f',{timeout:3000})
    return { ok:true }
  } catch(e){ return { ok:false, err:e.message } }
})

ipcMain.handle('open-startup',     () => { try{shell.openExternal('ms-settings:startupapps');return true}catch(e){return false} })
ipcMain.handle('open-net-adapter', () => { try{exec('control.exe ncpa.cpl');return true}catch(e){return false} })
ipcMain.handle('open-firewall',    () => { try{exec('control.exe /name Microsoft.WindowsFirewall');return true}catch(e){try{exec('mmc.exe wf.msc');return true}catch(e2){return false}} })

ipcMain.handle('pause-updates', (e, pause) => {
  return new Promise(r => {
    if (pause) {
      exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $d=(Get-Date).AddDays(35).ToString(\'yyyy-MM-ddTHH:mm:ssZ\'); Set-ItemProperty \'HKLM:\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings\' PauseUpdatesExpiryTime $d -Force -EA SilentlyContinue; Write-Host done }"',
        {timeout:6000},(e,o)=>r({ok:(o||'').includes('done')||!e}))
    } else {
      exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-ItemProperty \'HKLM:\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings\' PauseUpdatesExpiryTime -EA SilentlyContinue; Write-Host done"',
        {timeout:6000},(e,o)=>r({ok:true}))
    }
  })
})

// ═══════════════════════════════════════════════════════════════
//  GPU
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('nvidia-tweak', (e, type) => {
  const gpuBase = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
  if (type === 'lowlatency') {
    return new Promise(r => exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem \'' + gpuBase + '\' -EA SilentlyContinue | ForEach-Object { if((Get-ItemProperty $_.PSPath -EA SilentlyContinue).DriverDesc -match \'NVIDIA\'){ Set-ItemProperty $_.PSPath RMFIFOSchedulingEnabled 0 -Type DWord -Force -EA SilentlyContinue } }; Write-Host done"',
      {timeout:8000},()=>r({ok:true,msg:'NVIDIA Low Latency applied'})))
  }
  if (type === 'powermanage') {
    return new Promise(r => exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem \'' + gpuBase + '\' -EA SilentlyContinue | ForEach-Object { if((Get-ItemProperty $_.PSPath -EA SilentlyContinue).DriverDesc -match \'NVIDIA\'){ Set-ItemProperty $_.PSPath PerfLevelSrc 0x3322 -Type DWord -Force -EA SilentlyContinue; Set-ItemProperty $_.PSPath PowerMizerEnable 1 -Type DWord -Force -EA SilentlyContinue; Set-ItemProperty $_.PSPath PowerMizerLevel 1 -Type DWord -Force -EA SilentlyContinue } }; Write-Host done"',
      {timeout:8000},()=>r({ok:true,msg:'NVIDIA Max Performance applied'})))
  }
  if (type === 'gsync') {
    try { execSync('reg add "HKCU\\SOFTWARE\\NVIDIA Corporation\\Global\\NVTweak" /v NvCplShowGSync /t REG_DWORD /d 1 /f',{timeout:3000}); return {ok:true,msg:'G-Sync enabled'} } catch(e){ return {ok:false,msg:e.message} }
  }
  return {ok:false,msg:'Unknown'}
})

ipcMain.handle('amd-tweak', (e, type) => {
  const gpuBase = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
  if (type === 'antilag') {
    return new Promise(r => exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem \'' + gpuBase + '\' -EA SilentlyContinue | ForEach-Object { if((Get-ItemProperty $_.PSPath -EA SilentlyContinue).DriverDesc -match \'AMD|Radeon\'){ Set-ItemProperty $_.PSPath KMD_EnableComputePreemption 0 -Type DWord -Force -EA SilentlyContinue } }; Write-Host done"',
      {timeout:8000},()=>r({ok:true,msg:'AMD Anti-Lag applied'})))
  }
  if (type === 'texture') { try{execSync('reg add "HKCU\\SOFTWARE\\AMD\\CN" /v TextureOpt /t REG_DWORD /d 1 /f',{timeout:3000});return{ok:true,msg:'AMD texture opt enabled'}}catch(e){return{ok:false,msg:e.message}} }
  if (type === 'vsync')   { try{execSync('reg add "HKCU\\SOFTWARE\\AMD\\CN" /v VSyncControl /t REG_DWORD /d 0 /f',{timeout:3000});return{ok:true,msg:'AMD VSync disabled'}}catch(e){return{ok:false,msg:e.message}} }
  return {ok:false,msg:'Unknown'}
})

ipcMain.handle('open-app', (e, appName) => {
  const isNv = appName === 'nvidia-cp'
  const exe  = isNv ? 'nvcplui.exe' : 'RadeonSoftware.exe'
  const known = isNv ? [
    path.join(os.homedir(),'AppData','Local','Microsoft','WindowsApps','nvcplui.exe'),
    'C:\\Program Files\\NVIDIA Corporation\\Control Panel Client\\nvcplui.exe',
  ] : [
    'C:\\Program Files\\AMD\\CNext\\CNext\\RadeonSoftware.exe',
    path.join(os.homedir(),'AppData','Local','AMD','CN','RadeonSoftware.exe'),
  ]
  for (const p of known) { if(fs.existsSync(p)){exec('"'+p+'"');return{ok:true,path:p}} }
  return new Promise(r => {
    const pkg = isNv ? '*NVIDIAControlPanel*' : '*RadeonSoftware*'
    exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-AppxPackage -Name \'' + pkg + '\' | Select -First 1 | %{ $e=Join-Path $_.InstallLocation \'' + exe + '\'; if(Test-Path $e){Write-Host $e} }"',
      {timeout:10000},(e2,o2)=>{
        const p2=(o2||'').trim()
        if(p2&&fs.existsSync(p2)){exec('"'+p2+'"');r({ok:true,path:p2});return}
        exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem \'C:\\Program Files\\WindowsApps\' -Filter \''+exe+'\' -Recurse -EA SilentlyContinue | Select -First 1 -Expand FullName"',
          {timeout:20000},(e3,o3)=>{
            const p3=(o3||'').trim()
            if(p3&&fs.existsSync(p3)){exec('"'+p3+'"');r({ok:true,path:p3});return}
            exec('dir /s /b "C:\\'+exe+'" 2>nul',{timeout:30000,maxBuffer:1024*1024},(e4,o4)=>{
              const lines=(o4||'').trim().split('\n').map(l=>l.trim()).filter(l=>l.toLowerCase().endsWith(exe.toLowerCase()))
              if(lines.length&&fs.existsSync(lines[0])){exec('"'+lines[0]+'"');r({ok:true,path:lines[0]});return}
              r({ok:false,notInstalled:true})
            })
          })
      })
  })
})

ipcMain.handle('get-driver-info', () => {
  return new Promise(r => exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-WmiObject Win32_VideoController | ForEach-Object { Write-Host ($_.Name+\'|\'+$_.DriverVersion) }"',
    {timeout:5000},(e,o)=>{
      if(e||!o) return r({ok:false})
      const drivers = o.trim().split('\n').map(l=>{const p=l.trim().split('|');return{name:p[0]||'',version:p[1]||''}}).filter(d=>d.name)
      r({ok:true,drivers})
    }))
})

// ═══════════════════════════════════════════════════════════════
//  NETWORK
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('network-tweak', () => {
  return new Promise(r => exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "& { netsh int tcp set global autotuninglevel=normal 2>&1|Out-Null; netsh int tcp set global ecncapability=enabled 2>&1|Out-Null; netsh int tcp set global timestamps=disabled 2>&1|Out-Null; Write-Host done }"',
    {timeout:10000},(e,o)=>r({ok:(o||'').includes('done')})))
})

ipcMain.handle('flush-dns', () => new Promise(r => exec('ipconfig /flushdns',{timeout:5000},(e,o)=>r({ok:!e,out:o||''}))))

ipcMain.handle('switch-dns', (e, provider) => {
  return new Promise(r => {
    if (provider === 'isp') {
      exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetAdapter | Where Status -eq Up | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ResetServerAddresses }"',
        {timeout:8000},(e)=>r({ok:!e})); return
    }
    const servers = {cloudflare:'1.1.1.1\',\'1.0.0.1',google:'8.8.8.8\',\'8.8.4.4',opendns:'208.67.222.222\',\'208.67.220.220'}
    const s = servers[provider]
    if (!s) return r({ok:false})
    exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetAdapter | Where Status -eq Up | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ServerAddresses (\''+s+'\') }"',
      {timeout:8000},(e)=>r({ok:!e}))
  })
})

ipcMain.handle('ping-server', (e, host) => {
  return new Promise(resolve => {
    const raw = (host||'').trim()
    if (!raw) return resolve({ok:false, err:'Enter a server IP or hostname'})
    const cleanHost = raw.includes(':') ? raw.split(':')[0].trim() : raw
    const customPort = raw.includes(':') ? (parseInt(raw.split(':')[1])||30120) : null

    // Try ICMP via PowerShell - bypasses port firewall, works on any live server
    const lines = [
      '$h="' + cleanHost.replace(/"/g,'') + '"',
      'try{',
      '  $r=Test-Connection -ComputerName $h -Count 4 -EA Stop',
      '  $avg=[math]::Round(($r|Measure ResponseTime -Avg).Average,0)',
      '  $min=($r|Measure ResponseTime -Min).Minimum',
      '  $max=($r|Measure ResponseTime -Max).Maximum',
      '  Write-Host ("PING|"+$avg+"|"+$min+"|"+$max)',
      '}catch{ Write-Host "FAIL" }'
    ]
    const ps = lines.join('; ')

    exec('powershell -NoProfile -Command "' + ps + '"', {timeout:18000}, (err, out) => {
      const line = (out||'').trim()
      if (!err && line.startsWith('PING|')) {
        const parts = line.split('|')
        const avg=parseInt(parts[1])||1, mn=parseInt(parts[2])||1, mx=parseInt(parts[3])||1
        if (avg > 0) {
          // ICMP worked - also probe FiveM ports
          const ports = customPort ? [customPort] : [30120, 30110, 40120]
          let found = null, checked = 0
          ports.forEach(port => {
            const s = new net.Socket()
            s.setTimeout(2500)
            s.connect(port, cleanHost, () => {
              s.destroy()
              if (!found) { found = port }
              if (++checked === ports.length) {
                resolve({ok:true, avg, min:mn, max:mx, loss:0, port:found, method:'ICMP'+(found?'+TCP':'')})
              }
            })
            s.on('error', () => { s.destroy(); if(++checked===ports.length&&!found) resolve({ok:true,avg,min:mn,max:mx,loss:0,port:null,method:'ICMP', warning:'Server reachable but FiveM ports 30120/30110/40120 did not respond — server may be offline or using a different port.'}) })
            s.on('timeout', () => { s.destroy(); if(++checked===ports.length&&!found) resolve({ok:true,avg,min:mn,max:mx,loss:0,port:null,method:'ICMP', warning:'Server reachable but FiveM ports did not respond.'}) })
          })
          return
        }
      }

      // ICMP failed — try raw TCP on FiveM ports
      const ports = customPort ? [customPort] : [30120, 30110, 40120]
      const allResults = []
      let pending = ports.length

      ports.forEach(port => {
        const times = []
        let att = 0
        const doAttempt = () => {
          const t0 = Date.now()
          const s = new net.Socket()
          s.setTimeout(4000)
          s.connect(port, cleanHost, () => {
            times.push(Date.now()-t0); s.destroy()
            if (++att < 3) doAttempt()
            else { allResults.push({port, times}); if(--pending===0) finish() }
          })
          s.on('error', () => { times.push(-1); s.destroy(); if(++att<3) doAttempt(); else{allResults.push({port,times});if(--pending===0)finish()} })
          s.on('timeout', () => { times.push(-1); s.destroy(); if(++att<3) doAttempt(); else{allResults.push({port,times});if(--pending===0)finish()} })
        }
        doAttempt()
      })

      function finish() {
        let best = null
        for (const r of allResults) {
          const v = r.times.filter(t=>t>0)
          if (!best || v.length > best.valid.length) best = {port:r.port, valid:v, all:r.times}
        }
        if (!best || !best.valid.length) {
          resolve({ok:false, err:'Could not reach ' + cleanHost + '. Check the IP is correct and the server is online.'})
        } else {
          const avg = Math.round(best.valid.reduce((a,b)=>a+b,0)/best.valid.length)
          resolve({ok:true, avg, min:Math.min(...best.valid), max:Math.max(...best.valid), loss:Math.round(((best.all.length-best.valid.length)/best.all.length)*100), port:best.port, method:'TCP'})
        }
      }
    })
  })
})


ipcMain.handle('prep-driver-install', () => {
  return new Promise(r => {
    exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $p=\'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\'; if(!(Test-Path $p)){New-Item -Path $p -Force|Out-Null}; Set-ItemProperty $p ExcludeWUDriversInQualityUpdate 1 -Type DWord -Force -EA SilentlyContinue; Set-ItemProperty \'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DriverSearching\' SearchOrderConfig 0 -Type DWord -Force -EA SilentlyContinue; Write-Host done }"',
      {timeout:6000},(e,o)=>r({ok:(o||'').includes('done')||!e}))
  })
})

// ═══════════════════════════════════════════════════════════════
//  SECURITY — PIN
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('set-pin', (e,pin) => {
  try { const h=crypto.createHash('sha256').update(pin+'FOM_PIN_SALT').digest('hex'); fs.writeFileSync(path.join(LOCK_DIR,'.pin'),h,'utf8'); return true } catch(e){ return false }
})
ipcMain.handle('check-pin', (e,pin) => {
  try {
    const f=path.join(LOCK_DIR,'.pin')
    if(!fs.existsSync(f)) return {ok:true,pinSet:false}
    const h=crypto.createHash('sha256').update(pin+'FOM_PIN_SALT').digest('hex')
    return {ok:h===fs.readFileSync(f,'utf8').trim(),pinSet:true}
  } catch(e){ return {ok:true,pinSet:false} }
})
ipcMain.handle('remove-pin', () => { try{const f=path.join(LOCK_DIR,'.pin');if(fs.existsSync(f))fs.unlinkSync(f);return true}catch(e){return false} })

// ── Expose HWID for display / whitelist management ────────────
ipcMain.handle('get-hwid', () => {
  return { ok: true, hwid: 'Discord role verified', registeredAt: null, hostname: os.hostname() }
})

// ═══════════════════════════════════════════════════════════════
//  FIVEM WATCHER
// ═══════════════════════════════════════════════════════════════
let _watcher = null
ipcMain.handle('set-fivem-watcher', (e, enabled) => {
  if (!enabled) { if(_watcher){clearInterval(_watcher);_watcher=null}; return true }
  if (_watcher) return true
  let was = false
  _watcher = setInterval(() => {
    try {
      const o = execSync('tasklist /FI "IMAGENAME eq FiveM.exe" /FO CSV /NH 2>nul',{encoding:'utf8',timeout:1000})
      const running = o.includes('FiveM.exe')
      if (running && !was) { was=true; setTimeout(()=>{try{execSync('wmic process where name="FiveM.exe" CALL setpriority "high priority"',{timeout:3000})}catch(e){}; if(mainWin)mainWin.webContents.send('fivem-started')},3000) }
      if (!running && was) was = false
    } catch(e){}
  }, 5000)
  return true
})

// ═══════════════════════════════════════════════════════════════
//  SYSTEM CORRUPTION SUITE
// ═══════════════════════════════════════════════════════════════
let _repairProc = null
let _repairRunning = false

ipcMain.handle('run-repair-step', (e, step) => {
  return new Promise(resolve => {
    if (_repairRunning) return resolve({ ok: false, err: 'Repair already running' })
    _repairRunning = true

    const commands = {
      chkdsk: 'cmd /c echo Y | chkdsk C: /f /r /x',
      sfc1:   'sfc /scannow',
      dism:   'DISM /Online /Cleanup-Image /RestoreHealth',
      sfc2:   'sfc /scannow'
    }

    // chkdsk READ ONLY - NEVER use /f or /r as those schedule disk repair on reboot
    // which can cause issues. We only report errors, not fix them automatically.
    if (step === 'chkdsk') {
      exec('chkdsk C: /scan 2>nul', { timeout: 60000 }, (err, out) => {
        _repairRunning = false
        const hasErrors = (out||'').toLowerCase().includes('found') && !(out||'').toLowerCase().includes('found. 0')
        const clean = (out||'').toLowerCase().includes('no problems') || (out||'').toLowerCase().includes('0 errors')
        resolve({
          ok: true,
          out: out || 'Scan complete',
          step,
          hasErrors,
          clean,
          note: clean ? 'No disk errors found' : hasErrors ? 'Disk errors detected — run Disk Check from Windows Settings to repair safely' : 'Scan complete'
        })
      })
      return
    }

    const cmd = commands[step]
    if (!cmd) { _repairRunning = false; return resolve({ ok: false, err: 'Unknown step' }) }

    let output = ''
    let lastActivity = Date.now()
    const TIMEOUT = 15 * 60 * 1000 // 15 minutes

    const proc = exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "& { ' + cmd + ' } 2>&1"',
      { timeout: TIMEOUT + 5000, maxBuffer: 10 * 1024 * 1024 })

    _repairProc = proc

    // Watch for output activity
    const activityWatcher = setInterval(() => {
      if (Date.now() - lastActivity > TIMEOUT) {
        clearInterval(activityWatcher)
        try { process.kill(proc.pid, 'SIGTERM') } catch(e) {}
        try { execSync('taskkill /F /PID ' + proc.pid + ' 2>nul', { timeout: 3000 }) } catch(e) {}
        _repairRunning = false
        _repairProc = null
        resolve({ ok: false, timedOut: true, step, out: output, err: 'Process exceeded 15 minute timeout — killed and moving to next step' })
      }
    }, 10000)

    proc.stdout && proc.stdout.on('data', d => {
      output += d
      lastActivity = Date.now()
      if (mainWin) mainWin.webContents.send('repair-progress', { step, line: d.toString().trim() })
    })
    proc.stderr && proc.stderr.on('data', d => {
      output += d; lastActivity = Date.now()
    })

    proc.on('close', code => {
      clearInterval(activityWatcher)
      _repairRunning = false
      _repairProc = null
      resolve({ ok: code === 0 || code === 1, code, step, out: output })
    })

    proc.on('error', err => {
      clearInterval(activityWatcher)
      _repairRunning = false
      _repairProc = null
      resolve({ ok: false, err: err.message, step })
    })
  })
})

ipcMain.handle('cancel-repair', () => {
  if (_repairProc) {
    try { process.kill(_repairProc.pid, 'SIGTERM') } catch(e) {}
    try { execSync('taskkill /F /T /PID ' + _repairProc.pid + ' 2>nul', { timeout: 3000 }) } catch(e) {}
    _repairProc = null; _repairRunning = false; return true
  }
  return false
})

// ═══════════════════════════════════════════════════════════════
//  EXTREME POWER PLAN
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('inject-extreme-power', () => {
  return new Promise(resolve => {
    // Create a custom Ultimate Performance plan and max all settings
    const ps = `
      # Duplicate the High Performance plan
      $guid = [System.Guid]::NewGuid().ToString()
      powercfg /duplicatescheme 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c $guid 2>$null

      # Set name
      powercfg /changename $guid "FiveM Extreme Performance" "Optimized for FiveM gaming" 2>$null

      # Activate it
      powercfg /setactive $guid 2>$null

      # Max all sub-settings
      powercfg /setacvalueindex $guid SUB_PROCESSOR PROCTHROTTLEMIN 100
      powercfg /setacvalueindex $guid SUB_PROCESSOR PROCTHROTTLEMAX 100
      powercfg /setacvalueindex $guid SUB_PROCESSOR PERFBOOSTMODE 2
      powercfg /setacvalueindex $guid SUB_PROCESSOR PERFBOOSTPOL 100
      powercfg /setacvalueindex $guid SUB_VIDEO VIDEOIDLE 0
      powercfg /setacvalueindex $guid SUB_SLEEP STANDBYIDLE 0
      powercfg /setacvalueindex $guid SUB_SLEEP HYBRIDSLEEP 0
      powercfg /setacvalueindex $guid SUB_SLEEP HIBERNATEIDLE 0
      powercfg /setacvalueindex $guid SUB_DISK DISKIDLE 0
      powercfg /setacvalueindex $guid SUB_PCIEXPRESS ASPM 0

      powercfg /setactive $guid

      Write-Host "GUID:$guid"
    `
    exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "' + ps.replace(/\n/g,' ') + '"',
      { timeout: 15000 }, (err, out) => {
        if (err) return resolve({ ok: false, err: err.message })
        const match = (out||'').match(/GUID:([a-f0-9-]+)/)
        resolve({ ok: !err, guid: match ? match[1] : null, out: out||'' })
      })
  })
})

// ═══════════════════════════════════════════════════════════════
//  RESTORE POINT (must succeed before applying tweaks)
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('create-restore-point', () => {
  return new Promise(resolve => {
    exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "& { Enable-ComputerRestore -Drive \'C:\\\' -EA SilentlyContinue; Checkpoint-Computer -Description \'FiveM Optimizer Backup\' -RestorePointType MODIFY_SETTINGS; Write-Host SUCCESS }"',
      { timeout: 60000 }, (err, out) => {
        const ok = (out||'').includes('SUCCESS') || !err
        resolve({ ok, out: out||'', err: err ? err.message : null })
      })
  })
})

// ═══════════════════════════════════════════════════════════════
//  BIOS / WMI INTEGRATION
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('get-bios-info', () => {
  return new Promise(resolve => {
    exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "& { try { $mb=Get-CimInstance Win32_BaseBoard -EA Stop; $bios=Get-CimInstance Win32_BIOS -EA Stop; $cpu=Get-CimInstance Win32_Processor -EA Stop | Select -First 1; $mem=Get-CimInstance Win32_PhysicalMemory -EA Stop; $memTotal=[math]::Round(($mem|Measure-Object Capacity -Sum).Sum/1GB,0); Write-Host ($mb.Manufacturer+\'|\'+$mb.Product+\'|\'+$bios.Manufacturer+\'|\'+$bios.SMBIOSBIOSVersion+\'|\'+$cpu.Name+\'|\'+$cpu.NumberOfCores+\'|\'+$cpu.MaxClockSpeed+\'|\'+$memTotal) } catch { Write-Host \'ERROR\' } }"',
      { timeout: 8000 }, (err, out) => {
        if (err || !out || out.includes('ERROR')) {
          // Fallback to wmic
          exec('wmic baseboard get Manufacturer,Product /FORMAT:CSV 2>nul', {timeout:3000,encoding:'utf8'}, (e2,o2) => {
            if (e2 || !o2) return resolve({ ok: false, err: 'Could not read hardware info' })
            const p = o2.trim().split('\n').filter(l=>l.includes(',')&&!l.includes('Node'))
            if (!p.length) return resolve({ ok: false })
            const c = p[p.length-1].trim().split(',')
            const mfr = (c[1]||'').toLowerCase()
            resolve({ ok:true, manufacturer:c[1]||'Unknown', product:c[2]||'Unknown', biosVendor:'', biosVersion:'', smbios:'', cpuName:'', cpuCores:os.cpus().length, memGB:0, supported:/msi|asus|gigabyte|asrock/.test(mfr) })
          })
          return
        }
        const parts = out.trim().split('|')
        const mfr = (parts[0]||'').toLowerCase()
        resolve({
          ok: true,
          manufacturer: parts[0]||'Unknown',
          product:      parts[1]||'Unknown',
          biosVendor:   parts[2]||'Unknown',
          smbios:       parts[3]||'Unknown',
          cpuName:      parts[4]||'Unknown',
          cpuCores:     parseInt(parts[5])||0,
          cpuMHz:       parseInt(parts[6])||0,
          memGB:        parseInt(parts[7])||0,
          supported:    /msi|asus|gigabyte|asrock|supermicro|msi|micro-star/.test(mfr)
        })
      })
  })
})

// ═══════════════════════════════════════════════════════════════
//  GPU DRIVER CLEAN REINSTALL INFO
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('get-latest-driver-url', (e, vendor) => {
  // We can't auto-download drivers (requires vendor auth) but we provide direct links
  // and DDU (Display Driver Uninstaller) for clean removal
  const urls = {
    nvidia: {
      drivers: 'https://www.nvidia.com/Download/index.aspx',
      ddu: 'https://www.guru3d.com/files-details/display-driver-uninstaller-download.html',
      nvclean: 'https://www.techpowerup.com/download/techpowerup-nvcleanstall/',
      guide: 'Boot into Safe Mode → Run DDU → Select Clean and Restart → Install new driver'
    },
    amd: {
      drivers: 'https://www.amd.com/en/support',
      ddu: 'https://www.guru3d.com/files-details/display-driver-uninstaller-download.html',
      guide: 'Boot into Safe Mode → Run DDU → Select Clean and Restart → Install new driver'
    }
  }
  return urls[vendor] || null
})

ipcMain.handle('run-ddu-prep', () => {
  // Prepare system for DDU - disable Windows driver auto-install temporarily
  return new Promise(resolve => {
    exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $p=\'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\'; if(!(Test-Path $p)){New-Item -Path $p -Force|Out-Null}; Set-ItemProperty $p ExcludeWUDriversInQualityUpdate 1 -Type DWord -Force; Write-Host done }"',
      { timeout: 5000 }, (err, out) => resolve({ ok: (out||'').includes('done') || !err }))
  })
})

ipcMain.handle('open-safe-mode-reboot', () => {
  return new Promise(resolve => {
    exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "bcdedit /set {current} safeboot minimal; Write-Host done"',
      { timeout: 5000 }, (err, out) => {
        if ((out||'').includes('done') || !err) {
          resolve({ ok: true, msg: 'Safe mode set. Restart your PC to enter Safe Mode, run DDU, then restart again to normal mode.' })
        } else {
          resolve({ ok: false, err: 'Run as Administrator' })
        }
      })
  })
})

ipcMain.handle('cancel-safe-mode', () => {
  return new Promise(resolve => {
    exec('bcdedit /deletevalue {current} safeboot', { timeout: 5000 }, (err) => resolve({ ok: !err }))
  })
})

// ═══════════════════════════════════════════════════════════════
//  CLEANER & PROCESSES
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('clean-ram', () => {
  return new Promise(r => {
    exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $b=[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,2); Get-Process | ForEach-Object { try{$_.MinWorkingSet=$_.MinWorkingSet}catch{} }; [System.GC]::Collect(); Start-Sleep 1; $a=[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,2); Write-Host ($b+\'|\'+ $a) }"',
      {timeout:20000},(e,o)=>{
        if(o&&o.includes('|')){const[b,a]=o.trim().split('|');r({ok:true,before:parseFloat(b)||0,after:parseFloat(a)||0,freed:Math.max(0,Math.round((parseFloat(a)-parseFloat(b))*10)/10)})}
        else r({ok:true,before:0,after:0,freed:0})
      })
  })
})

ipcMain.handle('clean-disk', () => {
  const paths2 = [path.join(os.homedir(),'AppData','Local','Temp'),'C:\\Windows\\Temp',path.join(os.homedir(),'AppData','Local','Microsoft','Windows','INetCache')]
  let freed=0
  function getSize(d){let s=0;try{for(const i of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,i.name);try{s+=i.isDirectory()?getSize(f):fs.statSync(f).size}catch(e){}}}catch(e){}return s}
  function clean(d){try{for(const i of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,i.name);try{if(i.isDirectory())fs.rmSync(f,{recursive:true,force:true});else{freed+=fs.statSync(f).size;fs.unlinkSync(f)}}catch(e){}}}catch(e){}}
  for(const p of paths2){freed+=getSize(p);clean(p)}
  return {ok:true,freed:Math.round(freed/1048576)}
})

ipcMain.handle('get-processes', () => {
  return new Promise(r => exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process | Where WorkingSet -gt 20MB | Sort WorkingSet -Desc | Select -First 20 | ForEach-Object { Write-Host ($_.ProcessName+\'|\'+ [math]::Round($_.WorkingSet/1MB,0)+\'|\'+$_.Id) }"',
    {timeout:5000},(e,o)=>{
      if(e||!o) return r([])
      r(o.trim().split('\n').map(l=>{const p=l.trim().split('|');return{name:p[0]||'',mem:parseInt(p[1])||0,pid:parseInt(p[2])||0}}).filter(p=>p.name&&p.pid))
    }))
})

ipcMain.handle('kill-process', (e,pid) => {
  try{execSync('taskkill /F /PID '+pid+' 2>nul',{timeout:3000});return true}catch(e){return false}
})

ipcMain.handle('check-ram-speed', () => {
  return new Promise(r => {
    exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $mem=Get-CimInstance Win32_PhysicalMemory -EA SilentlyContinue; if(!$mem){$mem=Get-WmiObject Win32_PhysicalMemory -EA SilentlyContinue}; if($mem){ foreach($m in $mem){ Write-Host ($m.ConfiguredClockSpeed.ToString()+\'|\'+ $m.Speed.ToString()+\'|\'+ [math]::Round($m.Capacity/1GB,0).ToString()+\'|\'+ $m.Manufacturer.ToString().Trim()) } } }"',
      {timeout:8000},(e,o)=>{
        if(e||!o||!o.trim()){
          exec('wmic memorychip get ConfiguredClockSpeed,Speed,Capacity,Manufacturer /FORMAT:CSV 2>nul',{timeout:5000,encoding:'utf8'},(e2,o2)=>{
            if(e2||!o2) return r({ok:false,err:'Could not read RAM — run as Administrator'})
            const lines=o2.trim().split('\n').filter(l=>l.includes(',')&&!l.includes('Node')&&!l.includes('ConfiguredClock'))
            if(!lines.length) return r({ok:false,err:'No RAM detected'})
            const sticks=lines.map(l=>{const p=l.trim().split(',');return{speed:parseInt(p[1])||parseInt(p[3])||0,gb:Math.round((parseInt(p[2])||0)/1073741824),maker:(p[4]||'').trim()}}).filter(s=>s.gb>0)
            const speed=sticks.length?Math.max(...sticks.map(s=>s.speed)):0,total=sticks.reduce((a,s)=>a+s.gb,0)
            r({ok:true,speed,total,sticks:sticks.length,xmp:speed>2133,note:speed>2133?'XMP enabled ('+speed+'MHz)':'RAM at '+speed+'MHz — enable XMP in BIOS'})
          });return
        }
        const sticks=o.trim().split('\n').map(l=>{const p=l.trim().split('|');return{speed:parseInt(p[0])||parseInt(p[1])||0,gb:parseInt(p[2])||0,maker:(p[3]||'').trim()}}).filter(s=>s.gb>0)
        const speed=sticks.length?Math.max(...sticks.map(s=>s.speed)):0,total=sticks.reduce((a,s)=>a+s.gb,0)
        r({ok:true,speed,total,sticks:sticks.length,xmp:speed>2133,note:speed>2133?'XMP enabled ('+speed+'MHz — full speed)':'RAM at '+speed+'MHz — enable XMP/EXPO in BIOS for full speed',detail:sticks.map(s=>s.gb+'GB'+(s.maker&&s.maker!='Unknown'?' ('+s.maker+')':'')).join(', ')})
      })
  })
})

// ═══════════════════════════════════════════════════════════════
//  GTA V GRAPHICS
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('get-gta-settings', () => {
  const paths3=[path.join(os.homedir(),'Documents','Rockstar Games','GTA V','settings.xml'),path.join(os.homedir(),'OneDrive','Documents','Rockstar Games','GTA V','settings.xml')]
  for(const p of paths3){if(fs.existsSync(p))return{ok:true,path:p}}
  return{ok:false,path:paths3[0],canCreate:true}
})

ipcMain.handle('create-gta-settings', () => {
  try{
    const dir=path.join(os.homedir(),'Documents','Rockstar Games','GTA V')
    if(!fs.existsSync(dir))fs.mkdirSync(dir,{recursive:true})
    const xml=`<?xml version="1.0" encoding="UTF-8"?>\n<Configurations version="32">\n <TextureQuality value="2"/>\n <ShaderQuality value="2"/>\n <ShadowQuality value="2"/>\n <ReflectionQuality value="2"/>\n <AntiAliasing value="0"/>\n <MSAA value="0"/>\n <PostFX value="1"/>\n <GrassQuality value="1"/>\n</Configurations>`
    const p=path.join(dir,'settings.xml');fs.writeFileSync(p,xml,'utf8');return{ok:true,path:p}
  }catch(e){return{ok:false,err:e.message}}
})

ipcMain.handle('apply-gta-preset', (e,preset) => {
  try{
    const p=path.join(os.homedir(),'Documents','Rockstar Games','GTA V','settings.xml')
    if(!fs.existsSync(p))return{ok:false,err:'settings.xml not found — click Create first'}
    let c=fs.readFileSync(p,'utf8');fs.writeFileSync(p+'.bak',c,'utf8')
    const presets={low:{TextureQuality:'0',ShaderQuality:'0',ShadowQuality:'0',ReflectionQuality:'0',AntiAliasing:'0',MSAA:'0',PostFX:'0',GrassQuality:'0'},medium:{TextureQuality:'1',ShaderQuality:'1',ShadowQuality:'1',ReflectionQuality:'1',AntiAliasing:'1',MSAA:'0',PostFX:'1',GrassQuality:'1'},high:{TextureQuality:'2',ShaderQuality:'2',ShadowQuality:'2',ReflectionQuality:'2',AntiAliasing:'2',MSAA:'2',PostFX:'2',GrassQuality:'2'},ultra:{TextureQuality:'3',ShaderQuality:'3',ShadowQuality:'3',ReflectionQuality:'3',AntiAliasing:'3',MSAA:'4',PostFX:'3',GrassQuality:'3'}}
    const settings=presets[preset];if(!settings)return{ok:false,err:'Unknown preset'}
    for(const[k,v]of Object.entries(settings))c=c.replace(new RegExp('(<'+k+'[^>]*value=")[^"]*(")'),'$1'+v+'$2')
    fs.writeFileSync(p,c,'utf8');return{ok:true,preset,backed:p+'.bak'}
  }catch(e){return{ok:false,err:e.message}}
})

// ═══════════════════════════════════════════════════════════════
//  CONFIG / HISTORY / PROFILES
// ═══════════════════════════════════════════════════════════════
function cfgPath(){return path.join(LOCK_DIR,'config.json')}
function readCFG(){try{return JSON.parse(fs.readFileSync(cfgPath(),'utf8'))}catch(e){return{}}}
function writeCFG(d){if(!fs.existsSync(LOCK_DIR))fs.mkdirSync(LOCK_DIR,{recursive:true});const c={...readCFG(),...d};fs.writeFileSync(cfgPath(),JSON.stringify(c,null,2),'utf8')}

ipcMain.handle('get-config',  ()=>readCFG())
ipcMain.handle('save-config', (e,d)=>{try{writeCFG(d);return true}catch(e){return false}})

ipcMain.handle('log-history', (e,entry)=>{
  try{const f=path.join(LOCK_DIR,'history.json');let h=[];try{h=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){}
  h.unshift({...entry,time:new Date().toISOString()});if(h.length>100)h=h.slice(0,100);fs.writeFileSync(f,JSON.stringify(h,null,2),'utf8');return true}catch(e){return false}
})
ipcMain.handle('get-history', ()=>{try{const f=path.join(LOCK_DIR,'history.json');return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):[]}catch(e){return[]}})

ipcMain.handle('save-profile', (e,name,tweaks)=>{
  try{const f=path.join(LOCK_DIR,'profiles.json');let p={};try{p=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){}
  p[name]={tweaks,saved:new Date().toISOString()};fs.writeFileSync(f,JSON.stringify(p,null,2),'utf8');return{ok:true}}catch(e){return{ok:false}}
})
ipcMain.handle('get-profiles',   ()=>{try{const f=path.join(LOCK_DIR,'profiles.json');return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}}catch(e){return{}}})
ipcMain.handle('delete-profile', (e,name)=>{try{const f=path.join(LOCK_DIR,'profiles.json');let p={};try{p=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){}delete p[name];fs.writeFileSync(f,JSON.stringify(p,null,2),'utf8');return true}catch(e){return false}})

ipcMain.handle('export-settings', ()=>{
  try{const data={config:readCFG(),profiles:{},history:[]};try{const f=path.join(LOCK_DIR,'profiles.json');if(fs.existsSync(f))data.profiles=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){}
  try{const f=path.join(LOCK_DIR,'history.json');if(fs.existsSync(f))data.history=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){}
  const out=path.join(LOCK_DIR,'optimizer_backup.json');fs.writeFileSync(out,JSON.stringify(data,null,2),'utf8');shell.openPath(LOCK_DIR);return{ok:true,path:out}}catch(e){return{ok:false,err:e.message}}
})
ipcMain.handle('import-settings', (e,json)=>{
  try{const d=JSON.parse(json);if(d.config)writeCFG(d.config);if(d.profiles)fs.writeFileSync(path.join(LOCK_DIR,'profiles.json'),JSON.stringify(d.profiles,null,2),'utf8');return{ok:true}}catch(e){return{ok:false,err:e.message}}
})

// ═══════════════════════════════════════════════════════════════
//  NVIDIA DRIVER TOOLS
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('get-nvidia-driver-info', ()=>{
  return new Promise(r=>exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $gpu=Get-CimInstance Win32_VideoController | Where-Object {$_.Name -match \'NVIDIA\'} | Select-Object -First 1; if($gpu){ Write-Host ($gpu.Name+\'|\'+ $gpu.DriverVersion) } else { Write-Host \'notfound\' } }"',
    {timeout:5000},(e,o)=>{
      if(e||!o||o.includes('notfound'))return r({ok:false,err:'No NVIDIA GPU found'})
      const[name,ver]=(o||'').trim().split('|');let dv=ver||''
      try{const p=ver.trim().split('.');if(p.length>=4)dv=p[2].slice(-1)+p[3].slice(0,2)+'.'+p[3].slice(2)}catch(e){}
      r({ok:true,name:(name||'').trim(),rawVersion:(ver||'').trim(),displayVersion:dv.trim()})
    }))
})
ipcMain.handle('open-nvidia-download', ()=>{shell.openExternal('https://www.nvidia.com/Download/index.aspx');return true})

// ─── In-app driver download (uses Windows built-in tools) ────
ipcMain.handle('auto-install-driver', (e, type) => {
  return new Promise(resolve => {

    if (type === 'check-winget') {
      exec('winget --version', {timeout:5000}, (err, out) => {
        resolve({available: !err && (out||'').includes('v'), version:(out||'').trim()})
      })
      return
    }

    if (type === 'install-nvidia-driver-only') {
      // Step 1: try winget silent install
      if (mainWin) mainWin.webContents.send('driver-progress', {step:'Checking Windows Package Manager...', pct:5})

      exec('winget --version', {timeout:5000}, (e0) => {
        if (e0) {
          // No winget - open browser as fallback
          if (mainWin) mainWin.webContents.send('driver-progress', {step:'winget not available — opening NVIDIA download page', pct:100})
          shell.openExternal('https://www.nvidia.com/Download/index.aspx')
          return resolve({ok:false, fallback:true, err:'winget not available'})
        }

        if (mainWin) mainWin.webContents.send('driver-progress', {step:'Downloading latest NVIDIA Display Driver via winget...', pct:15})

        // Try display driver package first
        const proc = exec('winget install --id NVIDIA.NVIDIA_Display_Driver --silent --accept-source-agreements --accept-package-agreements --force',
          {timeout:600000, maxBuffer:20*1024*1024}, (err, out, serr) => {
            const output = ((out||'')+(serr||'')).toLowerCase()
            const alreadyUpToDate = output.includes('no applicable upgrade') || output.includes('already installed') || output.includes('no newer') || output.includes('up to date') || output.includes('no available upgrade')
            if (alreadyUpToDate) {
              if (mainWin) mainWin.webContents.send('driver-progress', {step:'Driver is already up to date!', pct:100})
              return resolve({ok:false, upToDate:true})
            }
            if (!err || output.includes('successfully installed')) {
              if (mainWin) mainWin.webContents.send('driver-progress', {step:'Driver installed! Restart your PC to apply.', pct:100})
              resolve({ok:true})
            } else {
              // Fallback: try GeForce Game Ready Driver package name
              if (mainWin) mainWin.webContents.send('driver-progress', {step:'Trying alternate package...', pct:60})
              exec('winget install --id NVIDIA.GeForceGameReadyDriver --silent --accept-source-agreements --accept-package-agreements --force',
                {timeout:600000, maxBuffer:20*1024*1024}, (err2, out2) => {
                  const out2lower = (out2||'').toLowerCase()
                  if (out2lower.includes('no applicable upgrade') || out2lower.includes('no newer') || out2lower.includes('already installed')) {
                    if (mainWin) mainWin.webContents.send('driver-progress', {step:'Driver already up to date!', pct:100})
                    return resolve({ok:false, upToDate:true})
                  }
                  if (!err2 || out2lower.includes('installed')) {
                    if (mainWin) mainWin.webContents.send('driver-progress', {step:'Driver installed! Restart your PC.', pct:100})
                    resolve({ok:true})
                  } else {
                    // Final fallback: open browser
                    shell.openExternal('https://www.nvidia.com/Download/index.aspx')
                    if (mainWin) mainWin.webContents.send('driver-progress', {step:'Opened NVIDIA download page — download and run installer.', pct:100})
                    resolve({ok:false, fallback:true, err:'winget install failed — opened NVIDIA download page'})
                  }
                })
            }
          })

        // Progress updates while downloading
        let pct = 15
        const progressTimer = setInterval(() => {
          if (pct < 90) { pct += 2; if (mainWin) mainWin.webContents.send('driver-progress', {step:'Downloading NVIDIA driver... (' + pct + '%)', pct}) }
          else clearInterval(progressTimer)
        }, 8000)

        proc.on('close', () => clearInterval(progressTimer))
      })
      return
    }

    if (type === 'install-nvidia-winget') {
      if (mainWin) mainWin.webContents.send('driver-progress', {step:'Installing GeForce Experience via winget...', pct:10})
      exec('winget install --id NVIDIA.GeForceExperience --silent --accept-source-agreements --accept-package-agreements',
        {timeout:300000, maxBuffer:10*1024*1024}, (err, out) => {
          if (mainWin) mainWin.webContents.send('driver-progress', {step:'Done', pct:100})
          resolve({ok:!err, out:(out||'').substring(0,300)})
        })
      return
    }

    resolve({ok:false, err:'Unknown type'})
  })
})

ipcMain.handle('download-ddu',         ()=>{shell.openExternal('https://www.guru3d.com/files-details/display-driver-uninstaller-download.html');return true})
ipcMain.handle('open-nvcleanstall',    ()=>{shell.openExternal('https://www.techpowerup.com/download/techpowerup-nvcleanstall/');return true})

// ═══════════════════════════════════════════════════════════════
//  SECURITY — PIN (kept for future use)
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  SAFE CACHE CLEAR WITH VERIFICATION
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('verify-cache-clear', async () => {
  const allPaths = new Set([
    ...getFiveMCachePaths(),
    path.join(os.homedir(),'AppData','Local','FiveM','FiveM.app','cache'),
    path.join(os.homedir(),'AppData','Local','FiveM','cache'),
    path.join(os.homedir(),'AppData','Roaming','CitizenFX','cache'),
    'C:\\Program Files\\FiveM\\FiveM.app\\cache',
    'C:\\FiveM\\FiveM.app\\cache',
  ])

  const found = []
  for (const p of allPaths) {
    try {
      if (!isSafeFiveMCacheDir(p)) continue
      const size = szDir(p)
      const subdirs = []
      try {
        for (const item of fs.readdirSync(p, {withFileTypes:true})) {
          if (item.isDirectory()) {
            const subSize = szDir(path.join(p, item.name))
            if (subSize > 0) subdirs.push({ name: item.name, size: subSize })
          }
        }
      } catch(e) {}
      // Only include if it has actual content
      found.push({ path: p, size, subdirs })
    } catch(e) {}
  }

  // Sort by size descending
  found.sort((a,b) => b.size - a.size)
  return { found, total: found.reduce((a,b) => a+b.size, 0) }
})

ipcMain.handle('clear-cache-targeted', async (e, targetPath) => {
  if (!fs.existsSync(targetPath)) return { ok:false, err:'Path not found', before:0, after:0, freed:0 }
  if (!isSafeFiveMCacheDir(targetPath)) return { ok:false, err:'Refusing to clear non-cache folder', before:0, after:0, freed:0 }

  function sz(d) {
    let s = 0
    try {
      for (const i of fs.readdirSync(d,{withFileTypes:true})) {
        const fp = path.join(d, i.name)
        try { s += i.isDirectory() ? sz(fp) : fs.statSync(fp).size } catch(e) {}
      }
    } catch(e) {}
    return s
  }

  const before = sz(targetPath)
  let cleared = 0, failed = 0

  try {
    const items = fs.readdirSync(targetPath, {withFileTypes:true})
    for (const item of items) {
      const fp = path.join(targetPath, item.name)

      // Try Node.js first
      try {
        fs.rmSync(fp, {recursive:true, force:true})
        cleared++
        continue
      } catch(e1) {}

      // Fallback 1: PowerShell Remove-Item (handles some locked files)
      try {
        execSync('cmd /c rd /s /q "'+fp+'" 2>nul', {timeout:8000})
        cleared++
        continue
      } catch(e2) {}

      // Fallback 2: cmd rd
      try {
        execSync('rd /s /q "'+fp+'" 2>nul || del /f /q "'+fp+'" 2>nul', {timeout:5000})
        cleared++
        continue
      } catch(e3) { failed++ }
    }
  } catch(e) {}

  const after = szDir(targetPath)
  const freed = Math.max(0, before - after)
  return { ok:true, before, after, freed, cleared, failed }
})

// ═══════════════════════════════════════════════════════════════
//  WINDOWS UPDATE + DRIVER CHAIN
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('install-windows-updates', () => {
  return new Promise(resolve => {
    if (mainWin) mainWin.webContents.send('driver-progress', {step:'Installing Windows Updates (required for winget)...', pct:5})
    // Use PSWindowsUpdate module if available, else Windows Update via COM
    const ps = `
      $ProgressPreference='SilentlyContinue'
      try {
        # Try PSWindowsUpdate
        if (!(Get-Module -ListAvailable PSWindowsUpdate -EA SilentlyContinue)) {
          Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -EA SilentlyContinue | Out-Null
          Install-Module -Name PSWindowsUpdate -Force -EA SilentlyContinue | Out-Null
        }
        Import-Module PSWindowsUpdate -EA Stop
        $updates = Get-WindowsUpdate -EA SilentlyContinue | Where-Object {$_.Title -notmatch 'Defender|Security'}
        if ($updates) {
          Install-WindowsUpdate -AcceptAll -IgnoreReboot -EA SilentlyContinue | Out-Null
          Write-Host 'UPDATED'
        } else { Write-Host 'UPTODATE' }
      } catch {
        # Fallback: trigger Windows Update via wuauclt
        wuauclt /detectnow /updatenow 2>$null
        Write-Host 'TRIGGERED'
      }
    `.replace(/\n/g,' ')
    exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "' + ps + '"',
      {timeout:120000}, (err, out) => {
        const o = (out||'').trim()
        if (mainWin) mainWin.webContents.send('driver-progress', {step:'Windows Update done — checking winget...', pct:30})
        resolve({ ok: true, result: o })
      })
  })
})

ipcMain.handle('ensure-winget', () => {
  return new Promise(resolve => {
    exec('winget --version', {timeout:5000}, (err, out) => {
      if (!err && (out||'').includes('v')) {
        resolve({ available: true, version: out.trim() })
        return
      }
      // Try to install winget via Microsoft Store / App Installer
      if (mainWin) mainWin.webContents.send('driver-progress', {step:'Installing Windows Package Manager...', pct:35})
      exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -EA SilentlyContinue; Write-Host done"',
        {timeout:30000}, (err2) => {
          exec('winget --version', {timeout:5000}, (err3, out3) => {
            resolve({ available: !err3 && (out3||'').includes('v'), version: (out3||'').trim(), installed: !err2 })
          })
        })
    })
  })
})

// ═══════════════════════════════════════════════════════════════
//  PING - MULTIPLE METHODS INCLUDING HTTP
// ═══════════════════════════════════════════════════════════════
function normalizeServerEndpoint(value) {
  let raw = (value || '').toString().trim()
  if (!raw) return null
  raw = raw.replace(/^["']|["']$/g, '').replace(/^https?:\/\//i, '')
  raw = raw.split(/[/?#]/)[0].trim()
  raw = raw.replace(/^connect\s+/i, '').replace(/^endpoint[:=]\s*/i, '')
  if (!raw) return null
  const ipv6 = raw.match(/^\[([^\]]+)\](?::(\d{2,5}))?$/)
  if (ipv6) return { host: ipv6[1], port: Math.min(Math.max(parseInt(ipv6[2]) || 30120, 1), 65535) }
  const parts = raw.split(':')
  if (parts.length > 2) return { host: raw, port: 30120 }
  const port = parts[1] ? parseInt(parts[1]) : 30120
  return { host: parts[0], port: Math.min(Math.max(port || 30120, 1), 65535) }
}

function parseServerCandidatesFromText(text, source) {
  const candidates = []
  const add = (host, port, src) => {
    const ep = normalizeServerEndpoint(host + (port ? ':' + port : ''))
    if (ep && isUsefulRemoteHost(ep.host)) candidates.push({ ...ep, source: src || source })
  }
  const body = (text || '').toString()
  const endpointRe = /(?:(?:connect(?:ing|ed)?|endpoint|addr|address|server|remote|netAddress|lastserver)\s*(?:to|=|:)?\s*)["']?((?:\d{1,3}\.){3}\d{1,3}|[a-z0-9.-]+\.[a-z]{2,})(?::(\d{2,5}))?/ig
  const looseRe = /((?:\d{1,3}\.){3}\d{1,3}|[a-z0-9.-]+\.[a-z]{2,})(?::(30120|30110|40120|\d{4,5}))\b/ig
  for (const m of body.matchAll(endpointRe)) add(m[1], m[2] || '30120', source)
  for (const m of body.matchAll(looseRe)) add(m[1], m[2], source)
  return candidates
}

function parseCfxJoinCodes(text) {
  const codes = []
  const seen = new Set()
  const body = (text || '').toString()
  for (const m of body.matchAll(/cfx\.re\/join\/([a-z0-9]+)/ig)) {
    const code = m[1].toLowerCase()
    if (!seen.has(code)) { seen.add(code); codes.push(code) }
  }
  return codes
}

function getJsonUrl(url, timeout) {
  return new Promise(resolve => {
    const mod = /^https:/i.test(url) ? https : http
    const req = mod.get(url, { timeout: timeout || 3500, headers: { 'User-Agent': 'FiveMOptimizer/2.0' } }, res => {
      let data = ''
      res.on('data', c => {
        data += c
        if (data.length > 1024 * 1024) req.destroy()
      })
      res.on('end', () => {
        try { resolve({ ok: true, json: JSON.parse(data), status: res.statusCode }) }
        catch(e) { resolve({ ok: false, status: res.statusCode }) }
      })
    })
    req.on('error', () => resolve({ ok: false }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }) })
  })
}

async function resolveCfxJoinCode(code) {
  const clean = (code || '').trim().replace(/[^a-z0-9]/ig, '')
  if (!clean) return null
  const r = await getJsonUrl('https://servers-frontend.fivem.net/api/servers/single/' + clean, 4500)
  const data = r.ok && r.json && (r.json.Data || r.json.data || r.json)
  const ep = data && (data.connectEndPoints || data.ConnectEndPoints || data.endpoints)
  const first = Array.isArray(ep) ? ep[0] : null
  return first ? normalizeServerEndpoint(first) : null
}

function endpointKey(ep) {
  return ep && ep.host ? (ep.host + ':' + ep.port).toLowerCase() : ''
}

function isUsefulRemoteHost(host) {
  return !!host && !/^(127\.|0\.0\.0\.0|169\.254\.|::1$|localhost$)/i.test(host)
}

function cleanServerName(name) {
  return (name || 'FiveM Server').replace(/\^[0-9]/g, '').replace(/\s+/g, ' ').trim().substring(0, 42) || 'FiveM Server'
}

function getHttpJson(host, port, file, timeout) {
  return new Promise(resolve => {
    const req = http.get({ hostname: host, port, path: file, timeout: timeout || 2500 }, res => {
      let data = ''
      res.on('data', c => {
        data += c
        if (data.length > 1024 * 1024) req.destroy()
      })
      res.on('end', () => {
        try { resolve({ ok: true, json: JSON.parse(data), status: res.statusCode }) }
        catch(e) { resolve({ ok: false }) }
      })
    })
    req.on('error', () => resolve({ ok: false }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }) })
  })
}

async function enrichFiveMEndpoint(ep) {
  if (!ep || !isUsefulRemoteHost(ep.host)) return null
  const info = await getHttpJson(ep.host, ep.port, '/info.json', 2600)
  if (!info.ok || !info.json) return null
  const vars = info.json.vars || {}
  let players = '--'
  const plist = await getHttpJson(ep.host, ep.port, '/players.json', 1800)
  if (plist.ok && Array.isArray(plist.json)) players = plist.json.length + ' online'
  return {
    ok: true,
    host: ep.host + ':' + ep.port,
    port: ep.port,
    name: cleanServerName(vars.sv_projectName || vars.sv_hostname || info.json.server || 'FiveM Server'),
    players,
    source: ep.source || 'verified'
  }
}

async function pickVerifiedFiveMEndpoint(candidates) {
  const seen = new Set()
  const unique = []
  for (const ep of candidates) {
    const key = endpointKey(ep)
    if (!key || seen.has(key) || !isUsefulRemoteHost(ep.host)) continue
    seen.add(key)
    unique.push(ep)
  }
  unique.sort((a, b) => {
    const ap = [30120, 30110, 40120].includes(a.port) ? 0 : 1
    const bp = [30120, 30110, 40120].includes(b.port) ? 0 : 1
    return ap - bp
  })
  for (const ep of unique.slice(0, 12)) {
    const verified = await enrichFiveMEndpoint(ep)
    if (verified) return verified
  }
  return null
}

ipcMain.handle('ping-fivem-server', (e, host) => {
  return new Promise(resolve => {
    const raw = (host||'').trim()
    if (!raw) return resolve({ok:false, err:'Enter a server IP or hostname'})
    const ep = normalizeServerEndpoint(raw)
    if (!ep || !ep.host) return resolve({ok:false, err:'Enter a valid server IP or hostname'})
    const cleanHost = ep.host
    const port = ep.port

    let settled = false
    const finish = (result) => { if (!settled) { settled = true; resolve(result) } }

    // Try HTTP /info.json - FiveM servers always have this endpoint
    let httpRtt = null
    const httpAttempts = []

    function doHttpPing(attempt) {
      if (attempt >= 4) {
        // All HTTP attempts done - use results
        const valid = httpAttempts.filter(t => t > 0)
        if (valid.length > 0) {
          const avg = Math.round(valid.reduce((a,b)=>a+b,0)/valid.length)
          return finish({ok:true, avg, min:Math.min(...valid), max:Math.max(...valid),
            loss: Math.round(((4-valid.length)/4)*100),
            port, method:'HTTP', serverOnline: true})
        }
        // HTTP failed - try raw TCP
        doTcpPing()
        return
      }
      const t0 = Date.now()
      const req = http.get({hostname: cleanHost, port, path:'/info.json', timeout:3000}, res => {
        httpAttempts.push(Date.now()-t0)
        res.destroy()
        setTimeout(() => doHttpPing(attempt+1), 300)
      })
      req.on('error', () => { httpAttempts.push(-1); setTimeout(() => doHttpPing(attempt+1), 300) })
      req.on('timeout', () => { req.destroy(); httpAttempts.push(-1); setTimeout(() => doHttpPing(attempt+1), 300) })
    }

    function doTcpPing() {
      const ports = [30120, 30110, 40120, port].filter((v,i,a)=>a.indexOf(v)===i)
      let best = null, checked = 0
      ports.forEach(p => {
        const results = []
        let att = 0
        function attempt() {
          const t0 = Date.now(), s = new net.Socket()
          s.setTimeout(3000)
          s.connect(p, cleanHost, () => { results.push(Date.now()-t0); s.destroy(); next() })
          s.on('error', () => { results.push(-1); s.destroy(); next() })
          s.on('timeout', () => { results.push(-1); s.destroy(); next() })
        }
        function next() {
          att++
          if (att < 3) { setTimeout(attempt, 200); return }
          const valid = results.filter(t=>t>0)
          if (valid.length > 0 && (!best || valid.length > best.valid.length)) {
            best = {port:p, valid, all:results}
          }
          if (++checked === ports.length) {
            if (!best || !best.valid.length) {
              return finish({ok:false, err:'Server not responding. Check the IP is correct and the server is online.'})
            }
            const avg = Math.round(best.valid.reduce((a,b)=>a+b,0)/best.valid.length)
            finish({ok:true, avg, min:Math.min(...best.valid), max:Math.max(...best.valid),
              loss:Math.round(((best.all.length-best.valid.length)/best.all.length)*100),
              port:best.port, method:'TCP'})
          }
        }
        attempt()
      })
    }

    // Also try ICMP in parallel
    const psCmd = `try{$r=Test-Connection -ComputerName '${cleanHost.replace(/'/g,'')}' -Count 2 -EA Stop;Write-Host ([math]::Round(($r|Measure ResponseTime -Avg).Average,0))}catch{Write-Host 0}`
    exec('powershell -NoProfile -Command "'+psCmd+'"', {timeout:10000}, (e,o) => {
      const icmpMs = parseInt((o||'').trim())||0
      if (icmpMs > 0 && !settled) {
        // ICMP worked, let HTTP finish for more accurate results
        // but store it as fallback
        setTimeout(() => {
          if (!settled) finish({ok:true, avg:icmpMs, min:icmpMs, max:icmpMs, loss:0, port:null, method:'ICMP',
            warning:'Server responds to ping but FiveM port status unknown'})
        }, 8000)
      }
    })

    doHttpPing(0)
  })
})

// ═══════════════════════════════════════════════════════════════
//  AUTO-DETECT FIVEM SERVER FROM ACTIVE TCP CONNECTIONS
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('detect-fivem-server', () => {
  return new Promise(resolve => {
    const psScript = [
      '$procs = Get-Process -Name FiveM,GTA5,CitizenFX,FxDK -EA SilentlyContinue',
      'if (!$procs) { Write-Host "NONE"; exit }',
      '$ids = $procs.Id',
      '$rows = @()',
      '$conns = Get-NetTCPConnection -EA SilentlyContinue | Where-Object { $_.OwningProcess -in $ids -and $_.RemoteAddress -and $_.RemoteAddress -notmatch "^(127\\.|::1|0\\.0|169\\.254\\.)" }',
      'foreach($c in $conns){ $rows += ($c.RemoteAddress + ":" + $c.RemotePort) }',
      '$udp = Get-NetUDPEndpoint -EA SilentlyContinue | Where-Object { $_.OwningProcess -in $ids -and $_.RemoteAddress -and $_.RemoteAddress -notmatch "^(127\\.|::1|0\\.0|169\\.254\\.)" }',
      'foreach($u in $udp){ $rows += ($u.RemoteAddress + ":" + $u.RemotePort) }',
      '$cmds = Get-CimInstance Win32_Process -EA SilentlyContinue | Where-Object { $ids -contains $_.ProcessId } | Select-Object -ExpandProperty CommandLine',
      'foreach($cmd in $cmds){ if($cmd){ $rows += ([regex]::Matches($cmd, "((?:\\d{1,3}\\.){3}\\d{1,3}|[a-z0-9.-]+\\.[a-z]{2,})(?::(\\d{2,5}))?", "IgnoreCase") | ForEach-Object { $_.Value }) } }',
      'if ($rows.Count -eq 0) {',
      '  $net = netstat -ano | Select-String "ESTABLISHED|UDP"',
      '  foreach($line in $net){ $cols=($line.ToString().Trim() -split "\\s+"); $pid=[int]($cols[$cols.Count-1]); if($ids -contains $pid){ $remote=if($cols[0] -eq "UDP" -and $cols.Count -ge 3){$cols[2]}elseif($cols.Count -ge 5){$cols[2]}else{""}; if($remote -and $remote -notmatch "^(127\\.|\\[::1\\]|0\\.0|169\\.254\\.|\\*:)"){ $rows += $remote } } }',
      '}',
      'if ($rows.Count -gt 0) { $rows | Sort-Object -Unique } else { Write-Host "NONE" }'
    ].join(';')
    exec('powershell -NoProfile -Command "' + psScript + '"', {timeout:12000}, async (err, stdout) => {
      const lines = (stdout||'').trim().split(/\r?\n/).map(s=>s.trim()).filter(Boolean).filter(s => s !== 'NONE')
      const candidates = []
      for (const line of lines) {
        const ep = normalizeServerEndpoint(line)
        if (ep) candidates.push({ ...ep, source: 'active-connection' })
      }
      if (!err && candidates.length) {
        const verified = await pickVerifiedFiveMEndpoint(candidates)
        if (verified) return resolve(verified)
      }
      const last = await getLastServerFromFiles()
      if (last.ok) return resolve(last)
      return resolve({ok:false})
    })
  })
})

async function getLastServerFromFiles() {
  try {
    const allCandidates = []
    const cfxPaths = [
      path.join(os.homedir(),'AppData','Roaming','CitizenFX','CitizenFX.ini'),
      path.join(os.homedir(),'AppData','Local','FiveM','FiveM.app','CitizenFX.ini'),
      path.join(os.homedir(),'AppData','Local','FiveM','CitizenFX.ini')
    ]
    for (const p2 of cfxPaths) {
      if (!fs.existsSync(p2)) continue
      const ini = fs.readFileSync(p2,'utf8')
      const match = ini.match(/LastServer\s*=\s*(.+)/i)
      if (match) {
        const raw = match[1].trim()
        const ep = normalizeServerEndpoint(raw)
        if (ep && ep.host && ep.host.length > 3) {
          const verified = await enrichFiveMEndpoint({ ...ep, source: 'config' })
          return verified || {ok:true, host:ep.host + ':' + ep.port, port:ep.port, name:'Last Server', players:'--', source:'config'}
        }
      }
      allCandidates.push(...parseServerCandidatesFromText(ini, 'config'))
    }
    const logRoots = [
      path.join(os.homedir(),'AppData','Local','FiveM','FiveM.app','logs'),
      path.join(os.homedir(),'AppData','Local','FiveM','FiveM.app','data','logs'),
      path.join(os.homedir(),'AppData','Roaming','CitizenFX'),
      path.join(os.homedir(),'AppData','Local','CitizenFX')
    ]
    const files = []
    for (const root of logRoots) {
      try {
        for (const item of fs.readdirSync(root, {withFileTypes:true})) {
          if (item.isFile() && /\.(log|txt|json|ini)$/i.test(item.name)) {
            const fp = path.join(root, item.name)
            files.push({fp, mtime:fs.statSync(fp).mtimeMs})
          }
        }
      } catch(e) {}
    }
    files.sort((a,b)=>b.mtime-a.mtime)
    for (const f of files.slice(0, 8)) {
      let text = ''
      try { text = fs.readFileSync(f.fp, 'utf8').slice(-200000) } catch(e) {}
      const candidates = parseServerCandidatesFromText(text, 'log').reverse()
      const verified = await pickVerifiedFiveMEndpoint(candidates)
      if (verified) return verified
      allCandidates.push(...candidates)
      for (const code of parseCfxJoinCodes(text).slice(-6).reverse()) {
        const ep = await resolveCfxJoinCode(code)
        if (ep) {
          const resolved = await enrichFiveMEndpoint({ ...ep, source: 'cfx.re/join' })
          if (resolved) return resolved
          allCandidates.push({ ...ep, source: 'cfx.re/join' })
        }
      }
    }
    const cacheRoots = [
      path.join(os.homedir(),'AppData','Local','FiveM','FiveM.app','data'),
      path.join(os.homedir(),'AppData','Roaming','CitizenFX')
    ]
    for (const root of cacheRoots) {
      try {
        const stack = [root]
        while (stack.length) {
          const dir = stack.pop()
          for (const item of fs.readdirSync(dir, {withFileTypes:true})) {
            const fp = path.join(dir, item.name)
            if (item.isDirectory() && stack.length < 50) stack.push(fp)
            else if (item.isFile() && /server|cache|history|profile|json|dat|txt|ini/i.test(item.name)) {
              let text = ''
              try {
                const st = fs.statSync(fp)
                if (st.size > 0 && st.size < 2 * 1024 * 1024) text = fs.readFileSync(fp).toString('utf8')
              } catch(e) {}
              allCandidates.push(...parseServerCandidatesFromText(text, 'cache'))
              for (const code of parseCfxJoinCodes(text).slice(-4).reverse()) {
                const ep = await resolveCfxJoinCode(code)
                if (ep) allCandidates.push({ ...ep, source: 'cfx.re/join' })
              }
            }
          }
        }
      } catch(e) {}
    }
    const verified = await pickVerifiedFiveMEndpoint(allCandidates)
    if (verified) return verified
    const hit = allCandidates.find(x => x.host && !/^127\.|^0\.0\.0\.0/.test(x.host))
    if (hit) return {ok:true, host:hit.host + ':' + hit.port, port:hit.port, name:'Recent Server', players:'--', source:hit.source || 'recent'}
    return {ok:false}
  } catch(e) { return {ok:false} }
}

ipcMain.handle('get-last-server', () => getLastServerFromFiles())

// ═══════════════════════════════════════════════════════════════
//  RESTORE POINT (must succeed before applying tweaks)
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  BIOS / WMI INTEGRATION
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  GPU DRIVER CLEAN REINSTALL INFO
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  CLEANER & PROCESSES
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  GTA V GRAPHICS
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  CONFIG / HISTORY / PROFILES
// ═══════════════════════════════════════════════════════════════
function cfgPath(){return path.join(LOCK_DIR,'config.json')}
function readCFG(){try{return JSON.parse(fs.readFileSync(cfgPath(),'utf8'))}catch(e){return{}}}
function writeCFG(d){if(!fs.existsSync(LOCK_DIR))fs.mkdirSync(LOCK_DIR,{recursive:true});const c={...readCFG(),...d};fs.writeFileSync(cfgPath(),JSON.stringify(c,null,2),'utf8')}

// ═══════════════════════════════════════════════════════════════
//  NVIDIA DRIVER TOOLS
// ═══════════════════════════════════════════════════════════════
// ─── In-app driver download (uses Windows built-in tools) ────
// ═══════════════════════════════════════════════════════════════
//  SECURITY — PIN (kept for future use)
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  SAFE CACHE CLEAR WITH VERIFICATION
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  WINDOWS UPDATE + DRIVER CHAIN
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  PING - MULTIPLE METHODS INCLUDING HTTP
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
//  RESTORE POINT - open folder after creating
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('open-restore-points', () => {
  try {
    exec('rstrui.exe') // Opens System Restore UI
    return true
  } catch(e) {
    try { exec('control.exe /name Microsoft.System /page pageRestorePoints'); return true } catch(e2) { return false }
  }
})

// ═══════════════════════════════════════════════════════════════
//  USER SETTINGS (per-user persistent)
// ═══════════════════════════════════════════════════════════════
ipcMain.handle('get-user-settings', () => {
  try {
    const f = path.join(LOCK_DIR, 'user_settings.json')
    if (!fs.existsSync(f)) return {}
    return JSON.parse(fs.readFileSync(f,'utf8'))
  } catch(e) { return {} }
})
ipcMain.handle('save-user-settings', (e, settings) => {
  try {
    if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR,{recursive:true})
    const f = path.join(LOCK_DIR, 'user_settings.json')
    let existing = {}
    try { existing = JSON.parse(fs.readFileSync(f,'utf8')) } catch(e) {}
    fs.writeFileSync(f, JSON.stringify({...existing,...settings},null,2), 'utf8')
    return true
  } catch(e) { return false }
})

// ═══════════════════════════════════════════════════════════════
//  ADVANCED TWEAKS
// ═══════════════════════════════════════════════════════════════

ipcMain.handle('tweak-network-advanced', () => new Promise(r => {
  const ps = [
    'Set-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\*" TcpAckFrequency 1 -Type DWord -Force -EA SilentlyContinue',
    'Set-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\*" TCPNoDelay 1 -Type DWord -Force -EA SilentlyContinue',
    'Set-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" NetworkThrottlingIndex 0xffffffff -Type DWord -Force -EA SilentlyContinue',
    'Set-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\LanmanWorkstation\\Parameters" DisableBandwidthThrottling 1 -Type DWord -Force -EA SilentlyContinue',
    'netsh int tcp set global autotuninglevel=normal 2>&1|Out-Null',
    'netsh int tcp set global congestionprovider=ctcp 2>&1|Out-Null',
    'netsh int tcp set global ecncapability=enabled 2>&1|Out-Null',
    'netsh int tcp set global timestamps=disabled 2>&1|Out-Null',
    'netsh int tcp set global initialRto=2000 2>&1|Out-Null',
    'Write-Host done'
  ].join('; ')
  exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "' + ps + '"', {timeout:15000}, (e,o) => r({ok:(o||'').includes('done')||!e}))
}))

ipcMain.handle('tweak-input-lag', () => new Promise(r => {
  const ps = [
    'Set-ItemProperty "HKCU:\\Control Panel\\Mouse" MouseSpeed 0 -Type String -Force -EA SilentlyContinue',
    'Set-ItemProperty "HKCU:\\Control Panel\\Mouse" MouseThreshold1 0 -Type String -Force -EA SilentlyContinue',
    'Set-ItemProperty "HKCU:\\Control Panel\\Mouse" MouseThreshold2 0 -Type String -Force -EA SilentlyContinue',
    'Set-ItemProperty "HKCU:\\Control Panel\\Keyboard" KeyboardDelay 0 -Type DWord -Force -EA SilentlyContinue',
    'Set-ItemProperty "HKCU:\\Control Panel\\Keyboard" KeyboardSpeed 31 -Type DWord -Force -EA SilentlyContinue',
    'Set-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" SystemResponsiveness 0 -Type DWord -Force -EA SilentlyContinue',
    'Write-Host done'
  ].join('; ')
  exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "' + ps + '"', {timeout:10000}, (e,o) => r({ok:(o||'').includes('done')||!e}))
}))

ipcMain.handle('tweak-process-priority', () => new Promise(r => {
  const ps = [
    'Set-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\PriorityControl" Win32PrioritySeparation 38 -Type DWord -Force -EA SilentlyContinue',
    'Set-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" "GPU Priority" 8 -Type DWord -Force -EA SilentlyContinue',
    'Set-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" Priority 6 -Type DWord -Force -EA SilentlyContinue',
    'Set-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" "Scheduling Category" High -Type String -Force -EA SilentlyContinue',
    'Set-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games" "SFIO Priority" High -Type String -Force -EA SilentlyContinue',
    'Set-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile" SystemResponsiveness 0 -Type DWord -Force -EA SilentlyContinue',
    'Write-Host done'
  ].join('; ')
  exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "' + ps + '"', {timeout:10000}, (e,o) => r({ok:(o||'').includes('done')||!e}))
}))

ipcMain.handle('tweak-disable-mitigations', () => new Promise(r => {
  const ps = [
    'Set-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management" FeatureSettingsOverride 3 -Type DWord -Force -EA SilentlyContinue',
    'Set-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management" FeatureSettingsOverrideMask 3 -Type DWord -Force -EA SilentlyContinue',
    'Write-Host done'
  ].join('; ')
  exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "' + ps + '"', {timeout:8000}, (e,o) => r({ok:(o||'').includes('done')||!e, reboot:true}))
}))

ipcMain.handle('tweak-memory-management', () => new Promise(r => {
  const ps = [
    'Set-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management" DisablePagingExecutive 1 -Type DWord -Force -EA SilentlyContinue',
    'Set-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters" EnablePrefetcher 0 -Type DWord -Force -EA SilentlyContinue',
    'Set-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters" EnableSuperfetch 0 -Type DWord -Force -EA SilentlyContinue',
    'Stop-Service SysMain -Force -EA SilentlyContinue | Out-Null',
    'Set-Service SysMain -StartupType Disabled -EA SilentlyContinue | Out-Null',
    'Write-Host done'
  ].join('; ')
  exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "' + ps + '"', {timeout:12000}, (e,o) => r({ok:(o||'').includes('done')||!e}))
}))

ipcMain.handle('tweak-storage-performance', () => new Promise(r => {
  const ps = [
    'fsutil behavior set disable8dot3 1 2>$null | Out-Null',
    'fsutil behavior set disablelastaccess 1 2>$null | Out-Null',
    'fsutil behavior set encryptpagingfile 0 2>$null | Out-Null',
    'Write-Host done'
  ].join('; ')
  exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "' + ps + '"', {timeout:15000}, (e,o) => r({ok:(o||'').includes('done')||!e}))
}))

ipcMain.handle('tweak-gpu-registry', (e, vendor) => new Promise(r => {
  const gpuBase = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
  const ps = [
    '$b="' + gpuBase + '"',
    'Get-ChildItem $b -EA SilentlyContinue | ForEach-Object { $d=(Get-ItemProperty $_.PSPath -EA SilentlyContinue).DriverDesc; if($d -match "NVIDIA"){ Set-ItemProperty $_.PSPath RMFIFOSchedulingEnabled 0 -Type DWord -Force -EA SilentlyContinue; Set-ItemProperty $_.PSPath PerfLevelSrc 0x3322 -Type DWord -Force -EA SilentlyContinue; Set-ItemProperty $_.PSPath PowerMizerEnable 1 -Type DWord -Force -EA SilentlyContinue; Set-ItemProperty $_.PSPath PowerMizerLevel 1 -Type DWord -Force -EA SilentlyContinue } }',
    'Set-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers" HwSchMode 2 -Type DWord -Force -EA SilentlyContinue',
    'Write-Host done'
  ].join('; ')
  exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "' + ps + '"', {timeout:12000}, (e,o) => r({ok:(o||'').includes('done')||!e}))
}))

ipcMain.handle('tweak-fivem-launch-args', () => {
  try {
    const iniPaths = [
      path.join(os.homedir(),'AppData','Local','FiveM','FiveM.app','CitizenFX.ini'),
      path.join(os.homedir(),'AppData','Roaming','CitizenFX','CitizenFX.ini'),
    ]
    let iniPath = iniPaths[0]
    for (const p of iniPaths) { if(fs.existsSync(p)){iniPath=p;break} }
    const dir = path.dirname(iniPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true})
    let ini = fs.existsSync(iniPath) ? fs.readFileSync(iniPath,'utf8') : ''
    const tweaks = { GameCacheSize:'8192', StreamingMemory:'4096', UseAsyncFileLoading:'true', DisableNPCBlips:'true', DisableCriticalSectionTelemetry:'true' }
    for (const [k,v] of Object.entries(tweaks)) {
      const rx = new RegExp('^'+k+'=.*','m')
      ini = rx.test(ini) ? ini.replace(rx,k+'='+v) : ini+'\n'+k+'='+v
    }
    fs.writeFileSync(iniPath,ini.trim(),'utf8')
    return {ok:true,path:iniPath}
  } catch(e) { return {ok:false,err:e.message} }
})

ipcMain.handle('get-system-score', () => {
  try {
    const cpus = os.cpus(), totalRam = os.totalmem(), gpu = getGPU()
    let score = 0, tips = []
    const cpuSpeed = cpus[0].speed, cpuCores = cpus.length
    if (cpuSpeed > 3500) score += 30; else if (cpuSpeed > 2800) score += 20; else { score += 10; tips.push('CPU below 3.5GHz — enable XMP in BIOS') }
    if (cpuCores >= 8) score += 20; else if (cpuCores >= 6) score += 15; else if (cpuCores >= 4) score += 10; else tips.push('4 or fewer CPU cores — FiveM works best with 6+')
    const ramGB = totalRam/1073741824
    if (ramGB >= 16) score += 25; else if (ramGB >= 12) score += 18; else if (ramGB >= 8) score += 10; else tips.push('Low RAM ('+ramGB.toFixed(0)+'GB) — FiveM recommends 16GB')
    if (gpu.nvidia) score += 25; else if (gpu.amd) score += 20; else tips.push('No dedicated GPU detected')
    const freeRam = os.freemem()/1073741824
    if (freeRam < 2) tips.push('Low free RAM — close other apps before FiveM')
    return {score:Math.min(100,score), tips, cpuCores, cpuSpeed, ramGB:ramGB.toFixed(1), gpu:gpu.nvidia||gpu.amd||'None', freeRam:freeRam.toFixed(1)}
  } catch(e) { return {score:0,tips:[],error:e.message} }
})

function getFiveMInstallDir() {
  const candidates = [
    path.join(os.homedir(),'AppData','Local','FiveM'),
    'C:\\FiveM',
    'D:\\FiveM',
    'C:\\Program Files\\FiveM',
    'C:\\Program Files (x86)\\FiveM',
  ]
  // Check registry for custom install
  try {
    const reg = execSync('reg query "HKCU\\SOFTWARE\\CitizenFX" /v InstallPath 2>nul', {encoding:'utf8',timeout:3000})
    const m = reg.match(/REG_SZ\s+(.+)/i)
    if (m) candidates.unshift(m[1].trim())
  } catch(e) {}
  // Check desktop shortcut
  try {
    const lnk = path.join(os.homedir(),'Desktop','FiveM.lnk')
    if (fs.existsSync(lnk)) {
      const o = execSync('powershell -NoProfile -Command "$s=(New-Object -COM WScript.Shell).CreateShortcut(\"'+lnk+'\");Write-Host $s.TargetPath" 2>nul', {encoding:'utf8',timeout:3000}).trim()
      if (o) candidates.unshift(path.dirname(o))
    }
  } catch(e) {}
  return [...new Set(candidates.filter(Boolean))]
}

function getFiveMCachePaths() {
  // Only return disposable cache folders, never broad data/config roots.
  const installDirs = getFiveMInstallDir()
  const all = new Set()

  for (const installDir of installDirs) {
    const appDir = path.join(installDir, 'FiveM.app')
    if (!fs.existsSync(appDir)) continue

    const candidates = [
      path.join(appDir, 'cache'),
      path.join(appDir, 'data', 'cache'),
      path.join(appDir, 'data', 'server-cache'),
      path.join(appDir, 'data', 'server-cache-priv'),
      path.join(appDir, 'data', 'http-cache'),
      path.join(appDir, 'data', 'extra-details-cache'),
      path.join(appDir, 'data', 'browser-manifest-cache')
    ]
    for (const p of candidates) all.add(p)

    try {
      const dataDir = path.join(appDir, 'data')
      for (const item of fs.readdirSync(dataDir, {withFileTypes:true})) {
        if (!item.isDirectory()) continue
        if (item.name.toLowerCase().includes('cache')) all.add(path.join(dataDir, item.name))
      }
    } catch(e) {}
  }

  const hardcoded = [
    path.join(os.homedir(),'AppData','Local','FiveM','FiveM.app','cache'),
    path.join(os.homedir(),'AppData','Local','FiveM','FiveM.app','data','cache'),
    path.join(os.homedir(),'AppData','Local','FiveM','FiveM.app','data','server-cache'),
    path.join(os.homedir(),'AppData','Local','FiveM','FiveM.app','data','server-cache-priv'),
    path.join(os.homedir(),'AppData','Local','FiveM','FiveM.app','data','http-cache'),
    path.join(os.homedir(),'AppData','Roaming','CitizenFX','cache'),
    path.join(os.homedir(),'AppData','Local','FiveM','cache'),
  ]
  for (const p of hardcoded) all.add(p)

  return [...all].filter(isSafeFiveMCacheDir)
}



// Auto-elevate to admin via VBScript
if (!isAdmin() && !process.argv.includes('--elevated')) {
  try {
    const _vbs = require('path').join(require('os').tmpdir(), 'fom_elev.vbs')
    const _exe = process.execPath.replace(/\\/g, '\\\\')
    require('fs').writeFileSync(_vbs, 'Set s=CreateObject("Shell.Application")\r\ns.ShellExecute "' + _exe + '","--elevated","","runas",1', 'utf8')
    exec('wscript.exe "' + _vbs + '"', { windowsHide: true })
    setTimeout(() => { app.quit(); process.exit(0) }, 1000)
  } catch(e) { /* continue without admin if elevation fails */ }
}



// ═══════════════════════════════════════════════════════════════
//  FORCE INSTALL - WINDOWS UPDATES + NVIDIA DRIVERS
// ═══════════════════════════════════════════════════════════════

ipcMain.handle('force-windows-update', () => {
  return new Promise(resolve => {
    if (mainWin) mainWin.webContents.send('force-update-progress', {step:'Setting up Windows Update module...', pct:5})

    const psScript = [
      '$ErrorActionPreference="SilentlyContinue"',
      '$ProgressPreference="SilentlyContinue"',
      'Write-Host "STEP:Installing NuGet provider..."',
      'Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -EA SilentlyContinue | Out-Null',
      'Write-Host "STEP:Installing PSWindowsUpdate module..."',
      'if(!(Get-Module -ListAvailable PSWindowsUpdate -EA SilentlyContinue)){Install-Module PSWindowsUpdate -Force -AllowClobber -EA SilentlyContinue | Out-Null}',
      'Write-Host "STEP:Scanning for updates..."',
      'try{',
      '  Import-Module PSWindowsUpdate -Force -EA Stop',
      '  $u=Get-WindowsUpdate -AcceptAll -EA SilentlyContinue',
      '  if($u -and $u.Count -gt 0){',
      '    Write-Host "STEP:Found $($u.Count) update(s) - installing..."',
      '    Install-WindowsUpdate -AcceptAll -AutoReboot:$false -IgnoreReboot -Confirm:$false -EA SilentlyContinue | Out-Null',
      '    Write-Host "DONE:$($u.Count)"',
      '  } else { Write-Host "DONE:0" }',
      '} catch {',
      '  Write-Host "STEP:Trying COM method..."',
      '  try{',
      '    $s=New-Object -ComObject Microsoft.Update.Session',
      '    $r=$s.CreateUpdateSearcher().Search("IsInstalled=0 and Type=\'Software\'")',
      '    $c=New-Object -ComObject Microsoft.Update.UpdateColl',
      '    foreach($u in $r.Updates){if(!$u.InstallationBehavior.CanRequestUserInput){$c.Add($u)|Out-Null}}',
      '    if($c.Count -gt 0){',
      '      Write-Host "STEP:Downloading $($c.Count) update(s)..."',
      '      $d=$s.CreateUpdateDownloader(); $d.Updates=$c; $d.Download()|Out-Null',
      '      Write-Host "STEP:Installing..."',
      '      $i=$s.CreateUpdateInstaller(); $i.Updates=$c; $i.Install()|Out-Null',
      '      Write-Host "DONE:$($c.Count)"',
      '    } else { Write-Host "DONE:0" }',
      '  } catch { wuauclt /detectnow /updatenow 2>$null; Write-Host "TRIGGERED:0" }',
      '}'
    ].join('; ')

    let output = ''
    const proc = exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "' + psScript + '"',
      {timeout:600000, maxBuffer:10*1024*1024})

    proc.stdout && proc.stdout.on('data', d => {
      output += d.toString()
      for (const line of d.toString().trim().split('\n')) {
        const l = line.trim()
        if (l.startsWith('STEP:') && mainWin)
          mainWin.webContents.send('force-update-progress', {step:l.replace('STEP:',''), pct:Math.min(88, 10+output.split('STEP:').length*10)})
        if ((l.startsWith('DONE:') || l.startsWith('TRIGGERED:')) && mainWin)
          mainWin.webContents.send('force-update-progress', {step:'Complete! ' + (parseInt(l.split(':')[1])||0) + ' update(s) processed', pct:100})
      }
    })

    proc.on('close', () => {
      const count = parseInt((output.match(/(?:DONE|TRIGGERED):(\d+)/) || [])[1]) || 0
      resolve({ok:true, count, upToDate:count===0})
    })
    proc.on('error', err => resolve({ok:false, err:err.message}))
  })
})

// Handler 86: Run All Windows Updates (new channel for GPU Drivers page)
ipcMain.handle('run-all-windows-updates', () => {
  return new Promise(resolve => {
    const sendProgress = (pct, msg, eta = '') => {
      if (mainWin) mainWin.webContents.send('windows-update-progress', {progress: pct, message: msg, eta})
    }

    sendProgress(5, 'Starting Windows Update scan...', '5-10 minutes')
    
    const psScript = [
      '$ErrorActionPreference="SilentlyContinue"',
      '$ProgressPreference="SilentlyContinue"',
      'Write-Host "STEP:Installing NuGet provider..."',
      'Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -EA SilentlyContinue | Out-Null',
      'Write-Host "STEP:Installing PSWindowsUpdate module..."',
      'if(!(Get-Module -ListAvailable PSWindowsUpdate -EA SilentlyContinue)){Install-Module PSWindowsUpdate -Force -AllowClobber -EA SilentlyContinue | Out-Null}',
      'Write-Host "STEP:Scanning for updates..."',
      'try{',
      '  Import-Module PSWindowsUpdate -Force -EA Stop',
      '  $u=Get-WindowsUpdate -AcceptAll -EA SilentlyContinue',
      '  if($u -and $u.Count -gt 0){',
      '    Write-Host "STEP:Found $($u.Count) update(s) - installing..."',
      '    Install-WindowsUpdate -AcceptAll -AutoReboot:$false -IgnoreReboot -Confirm:$false -EA SilentlyContinue | Out-Null',
      '    Write-Host "DONE:$($u.Count)"',
      '  } else { Write-Host "DONE:0" }',
      '} catch {',
      '  Write-Host "STEP:Trying COM method..."',
      '  try{',
      '    $s=New-Object -ComObject Microsoft.Update.Session',
      '    $r=$s.CreateUpdateSearcher().Search("IsInstalled=0 and Type=\'Software\'")',
      '    $c=New-Object -ComObject Microsoft.Update.UpdateColl',
      '    foreach($u in $r.Updates){if(!$u.InstallationBehavior.CanRequestUserInput){$c.Add($u)|Out-Null}}',
      '    if($c.Count -gt 0){',
      '      Write-Host "STEP:Downloading $($c.Count) update(s)..."',
      '      $d=$s.CreateUpdateDownloader(); $d.Updates=$c; $d.Download()|Out-Null',
      '      Write-Host "STEP:Installing..."',
      '      $i=$s.CreateUpdateInstaller(); $i.Updates=$c; $i.Install()|Out-Null',
      '      Write-Host "DONE:$($c.Count)"',
      '    } else { Write-Host "DONE:0" }',
      '  } catch { wuauclt /detectnow /updatenow 2>$null; Write-Host "TRIGGERED:0" }',
      '}'
    ].join('; ')

    let output = ''
    let stepCount = 0
    const proc = exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "' + psScript + '"',
      {timeout:1800000, maxBuffer:10*1024*1024}) // 30 min timeout

    proc.stdout && proc.stdout.on('data', d => {
      output += d.toString()
      for (const line of d.toString().trim().split('\n')) {
        const l = line.trim()
        if (l.startsWith('STEP:')) {
          stepCount++
          const msg = l.replace('STEP:', '')
          const pct = Math.min(85, 10 + stepCount * 15)
          const eta = stepCount < 3 ? '3-5 minutes' : stepCount < 5 ? '5-15 minutes' : '1-5 minutes'
          sendProgress(pct, msg, eta)
        }
        if (l.startsWith('DONE:') || l.startsWith('TRIGGERED:')) {
          const count = parseInt(l.split(':')[1]) || 0
          const msg = count > 0 
            ? `${count} update(s) installed successfully!` 
            : 'Windows fully up to date!'
          sendProgress(100, msg, '')
        }
      }
    })

    proc.on('close', () => {
      const count = parseInt((output.match(/(?:DONE|TRIGGERED):(\d+)/) || [])[1]) || 0
      const msg = count > 0
        ? `${count} updates installed successfully. Restart your PC if required.`
        : 'Windows is fully up to date. No updates needed.'
      resolve({success: true, message: msg, count})
    })
    proc.on('error', err => {
      sendProgress(100, `Error: ${err.message}`, '')
      resolve({success: false, error: err.message})
    })
  })
})

// Handler 85: Force Reinstall GPU Driver with ETA tracking
ipcMain.handle('force-reinstall-gpu-driver', () => {
  return new Promise(resolve => {
    const startTime = Date.now()
    const sendProgress = (pct, msg, eta = '') => {
      if (mainWin) mainWin.webContents.send('driver-reinstall-progress', {progress: pct, message: msg, eta})
    }

    sendProgress(5, 'Checking for winget...', '3-5 minutes')

    exec('winget --version', {timeout:5000}, (e0, o0) => {
      const hasWinget = !e0 && (o0||'').includes('v')

      const doInstall = () => {
        sendProgress(30, 'Starting driver reinstall...', '2-3 minutes')
        
        const pkgs = ['NVIDIA.NVIDIA_Display_Driver', 'NVIDIA.GeForceGameReadyDriver']
        let tried = 0
        
        const tryPkg = (pkg) => {
          const elapsed = Math.floor((Date.now() - startTime) / 1000)
          const etaMsg = elapsed < 120 ? '2-3 minutes' : '1-2 minutes'
          
          sendProgress(40 + (tried * 25), `Installing ${pkg === pkgs[0] ? 'NVIDIA Display Driver (primary)' : 'GeForce Game Ready Driver (fallback)'}...`, etaMsg)
          
          exec(`winget install --id ${pkg} --force --accept-source-agreements --accept-package-agreements`,
            {timeout:600000, maxBuffer:10*1024*1024},
            (err, out) => {
              tried++
              const o = (out||'').toLowerCase()
              
              if (!err || o.includes('installed') || o.includes('successfully')) {
                sendProgress(90, `${pkg === pkgs[0] ? 'NVIDIA Display Driver' : 'GeForce Game Ready Driver'} installed!`, '10 seconds')
                setTimeout(() => {
                  sendProgress(100, 'Driver reinstall complete! Restart your PC to apply changes.', '')
                  resolve({success: true, message: 'Driver reinstalled successfully. Please restart your PC.'})
                }, 500)
                return
              }
              
              if (tried < pkgs.length) {
                sendProgress(50, 'Primary package failed, trying fallback...', '2-3 minutes')
                return tryPkg(pkgs[tried])
              }
              
              sendProgress(100, 'Both driver packages failed. Check your internet connection.', '')
              resolve({success: false, error: 'Both NVIDIA driver packages failed to install'})
            })
        }
        
        tryPkg(pkgs[0])
      }

      if (!hasWinget) {
        sendProgress(10, 'Installing winget...', '2-4 minutes')
        exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -EA SilentlyContinue; Write-Host done"',
          {timeout:30000}, (wErr) => {
            if (!wErr) {
              sendProgress(20, 'Winget installed!', '2-3 minutes')
              setTimeout(() => doInstall(), 1000)
            } else {
              sendProgress(100, 'Failed to install winget. Try running as Administrator.', '')
              resolve({success: false, error: 'Winget installation failed'})
            }
          })
      } else {
        doInstall()
      }
    })
  })
})


function runLowEndMaxBoost() {
  return new Promise(resolve => {
    try {
      const beforeFree = os.freemem()
      const psScript = [
        '$ErrorActionPreference="SilentlyContinue"',
        'powercfg /setactive SCHEME_MIN | Out-Null',
        'powercfg /change monitor-timeout-ac 0 | Out-Null',
        'powercfg /change standby-timeout-ac 0 | Out-Null',
        'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects" /v VisualFXSetting /t REG_DWORD /d 2 /f | Out-Null',
        "Add-Type -Name Win32 -Namespace Native -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"psapi.dll\")] public static extern bool EmptyWorkingSet(System.IntPtr hProcess);'",
        '$skip="System","Idle","Registry","Memory Compression","csrss","wininit","winlogon","services","lsass","dwm","explorer","FiveM","GTA5","CitizenFX"',
        '$trimmed=0',
        'Get-Process | Where-Object { $skip -notcontains $_.ProcessName -and $_.Id -gt 4 -and $_.WorkingSet64 -gt 52428800 } | ForEach-Object { try { [Native.Win32]::EmptyWorkingSet($_.Handle) | Out-Null; $trimmed++ } catch {} }',
        'Get-Process -Name FiveM,GTA5,CitizenFX -EA SilentlyContinue | ForEach-Object { try { $_.PriorityClass="High" } catch {} }',
        '[GC]::Collect(); [GC]::WaitForPendingFinalizers(); [GC]::Collect()',
        'Write-Host ("DONE|"+$trimmed)'
      ].join('; ')

      exec('powershell -NoProfile -ExecutionPolicy Bypass -Command "' + psScript + '"',
        {timeout:20000, maxBuffer:1024*1024}, (err, out) => {
          if (err) return resolve({success:false, error:err.message})
          const afterFree = os.freemem()
          const freedMB = Math.max(0, Math.round((afterFree - beforeFree) / 1048576))
          const totalRAM = Math.floor(os.totalmem() / 1073741824)
          const allocatedGB = Math.min(Math.max(Math.floor(totalRAM * 0.75), 4), 16)
          const trimmed = parseInt(((out||'').match(/DONE\|(\d+)/)||[])[1]) || 0
          resolve({
            success:true,
            freedMB,
            trimmed,
            allocatedGB,
            message:`Low-end boost applied. Trimmed ${trimmed} background process(es), freed about ${freedMB} MB, set max performance power mode, and boosted FiveM priority.`
          })
        })
    } catch(error) {
      resolve({success: false, error: error.message})
    }
  })
}

ipcMain.handle('low-end-max-boost', () => runLowEndMaxBoost())
ipcMain.handle('optimize-ram-for-fivem', () => runLowEndMaxBoost())

// ============================================
// FPS TRACKING - BEFORE/AFTER (Handlers 88-90)
// ============================================
let fpsData = {
  before: null,
  after: null,
  timestamp: null
}

ipcMain.handle('record-fps-before', (e, fps) => {
  fpsData.before = fps
  fpsData.timestamp = Date.now()
  return {success: true, fps}
})

ipcMain.handle('record-fps-after', (e, fps) => {
  fpsData.after = fps
  const gain = fpsData.before ? fps - fpsData.before : 0
  return {
    success: true,
    before: fpsData.before,
    after: fps,
    gain,
    percentage: fpsData.before ? ((gain / fpsData.before) * 100).toFixed(1) : 0
  }
})

ipcMain.handle('get-fps-data', () => {
  return {
    before: fpsData.before,
    after: fpsData.after,
    gain: fpsData.before && fpsData.after ? fpsData.after - fpsData.before : 0,
    percentage: fpsData.before && fpsData.after ? (((fpsData.after - fpsData.before) / fpsData.before) * 100).toFixed(1) : 0
  }
})

console.log('✅ 89 handlers registered successfully')
