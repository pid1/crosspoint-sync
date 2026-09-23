/** CrossPoint Kindle Link popup. Thin shell over background.js messages. */

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function showError(msg) {
  const el = $('err');
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.hidden = false;
}

function showNote(msg) {
  const el = $('pending');
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.hidden = false;
}

/** Poll status until the library sync finishes (or an error appears), then refresh. */
async function pollSyncOutcome(sinceMs) {
  for (let i = 0; i < 30; i++) {
    await new Promise((r2) => setTimeout(r2, 2000));
    const st = await send({ type: 'status' });
    if (st?.lastError) { showError(st.lastError); break; }
    if (st?.lastSync && st.lastSync >= sinceMs) break;
  }
  showNote(null);
  await refresh();
}

async function guard(btn, fn) {
  btn.disabled = true;
  showError(null);
  try {
    const r = await fn();
    if (!r?.ok) showError(r?.error ?? 'failed');
    return r;
  } catch (e) {
    showError(e?.message ?? String(e));
    return null;
  } finally {
    btn.disabled = false;
  }
}

async function refresh() {
  const st = await send({ type: 'status' });
  const configured = !!st?.configured;
  const registered = !!st?.registered;
  $('connectSec').hidden = configured;
  $('registerSec').hidden = !configured || registered;
  $('statusSec').hidden = !configured || !registered;
  if (!configured) return;
  if (registered) {
    $('stDevice').textContent = st.deviceName ?? 'registered';
    $('stServer').textContent = `${st.username} @ ${st.server}`;
    $('stLibrary').textContent = `${st.libraryCount} book(s)`;
    $('stSync').textContent = st.lastSync ? new Date(st.lastSync).toLocaleString() : 'never';
    if (st.lastError) showError(st.lastError);
  }
}

$('connectBtn').addEventListener('click', (e) =>
  guard(e.target, async () => {
    const server = $('server').value.trim();
    const username = $('username').value.trim();
    const password = $('password').value;
    const region = $('region').value;
    if (!server || !username || !password) return { ok: false, error: 'fill in server, username and password' };
    // Grant host access to the user's own server (runtime optional permission).
    const origin = new URL(server.includes('://') ? server : `https://${server}`).origin;
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) return { ok: false, error: 'permission to reach your server was declined' };
    const r = await send({ type: 'connect', server, username, password, region });
    if (r?.ok) await refresh();
    return r;
  })
);

$('registerBtn').addEventListener('click', (e) =>
  guard(e.target, async () => {
    const email = $('email').value.trim();
    const password = $('amazonPassword').value;
    if (!email || !password) return { ok: false, error: 'enter your Amazon email and password' };
    const before = Date.now();
    const r = await send({ type: 'register-begin', email, password });
    if (r?.ok) {
      if (r.otp) {
        $('regForm').hidden = true;
        $('otpForm').hidden = false;
      } else {
        await refresh(); // no OTP needed — registered
        if (r.pending) {
          showNote('registered — syncing your library in the Amazon tab…');
          await pollSyncOutcome(before);
        }
      }
    }
    return r;
  })
);

$('otpBtn').addEventListener('click', (e) =>
  guard(e.target, async () => {
    const code = $('otp').value.trim();
    if (!code) return { ok: false, error: 'enter the code from Amazon\u2019s email' };
    const before = Date.now();
    const r = await send({ type: 'register-complete', code });
    if (r?.ok) {
      await refresh();
      if (r.pending) {
        showNote('registered — syncing your library in the Amazon tab…');
        await pollSyncOutcome(before);
      }
    }
    return r;
  })
);

$('syncBtn').addEventListener('click', (e) =>
  guard(e.target, async () => {
    const before = Date.now();
    const r = await send({ type: 'sync-now' });
    if (r?.ok) {
      showNote('syncing your library in the Amazon tab…');
      await pollSyncOutcome(before);
    }
    return r;
  })
);

$('unlinkBtn').addEventListener('click', (e) =>
  guard(e.target, async () => {
    const r = await send({ type: 'unlink' });
    if (r?.ok) await refresh();
    return r;
  })
);

refresh();
