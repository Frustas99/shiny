const MOD = 'pokerole-shiny-roulette';
const CHANNEL = `module.${MOD}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const escapeHTML = v => foundry.utils.escapeHTML(String(v ?? ''));
let overlay = null;
let currentSession = null;
let gmBusy = false;

Hooks.once('init', () => {
  game.settings.register(MOD, 'shinyCount', {
    name: 'Shiny trovati dal gruppo', scope: 'world', config: false,
    type: Number, default: 0
  });
  game.settings.register(MOD, 'pending', {
    name: 'Roulette in attesa', scope: 'world', config: false,
    type: Object, default: {}
  });
});

Hooks.once('ready', () => {
  game.socket.on(CHANNEL, receive);
  game.modules.get(MOD).api = {
    open: openGM,
    count: () => game.settings.get(MOD, 'shinyCount'),
    reset: resetCount
  };
  if (game.user.isGM && game.settings.get(MOD, 'pending')?.id) {
    game.settings.set(MOD, 'pending', {}).catch(console.error);
  }
});

function emit(type, data = {}) {
  game.socket.emit(CHANNEL, { type, data, sender: game.user.id });
}

function removeOverlay() {
  overlay?.remove();
  overlay = null;
  currentSession = null;
}

function makeOverlay(session) {
  removeOverlay();
  currentSession = session;
  const root = document.createElement('div');
  root.className = 'psr-backdrop';
  root.innerHTML = `
    <div class="psr-panel">
      <div class="psr-eyebrow">✦ POKÉROLE ✦</div>
      <h1>SHINY ROULETTE</h1>
      <p class="psr-pokemon">${escapeHTML(session.pokemon)}</p>
      <div class="psr-wheel-frame">
        <div class="psr-pointer">▼</div>
        <div class="psr-wheel"><div class="psr-wheel-center">✦</div></div>
      </div>
      <div class="psr-odds">PROBABILITÀ ATTUALE <strong>1 / ${Number(session.denominator).toLocaleString('it-IT')}</strong></div>
      <div class="psr-status">In attesa di ${escapeHTML(session.playerName)}...</div>
      <button class="psr-spin" type="button" disabled>GIRA LA RUOTA ✨</button>
      <div class="psr-footer">Il risultato è deciso dal GM • Una sola possibilità</div>
      <button class="psr-close" type="button" aria-label="Chiudi">×</button>
    </div>`;
  document.body.append(root);
  overlay = root;
  root.querySelector('.psr-close').addEventListener('click', () => {
    root.style.display = 'none';
  });
  const btn = root.querySelector('.psr-spin');
  if (game.user.id === session.playerId) {
    btn.disabled = false;
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      btn.disabled = true;
      root.querySelector('.psr-status').textContent = 'Richiesta di giro inviata al GM...';
      emit('spin-request', { id: session.id });
    });
  } else {
    btn.style.display = 'none';
  }
}

async function animateResult(data) {
  if (!currentSession || currentSession.id !== data.id || !overlay) return;
  const wheel = overlay.querySelector('.psr-wheel');
  const status = overlay.querySelector('.psr-status');
  const button = overlay.querySelector('.psr-spin');
  button.disabled = true;
  status.textContent = 'LA RUOTA STA GIRANDO...';
  // 12 settori visuali, risultato già determinato dal GM.
  // Lo spicchio oro è centrato a 0°; uno spicchio blu a 60°.
  const target = data.shiny ? 0 : 300;
  const current = Number(wheel.dataset.rotation || 0);
  const currentMod = ((current % 360) + 360) % 360;
  const additional = (360 - target - currentMod + 360) % 360;
  const rotation = current + 360 * 8 + additional;
  wheel.dataset.rotation = String(rotation);
  wheel.style.transform = `rotate(${rotation}deg)`;
  await sleep(7600);
  if (!overlay || currentSession?.id !== data.id) return;
  overlay.classList.toggle('psr-winner', !!data.shiny);
  status.textContent = data.shiny
    ? '✨ SHINY! ✨ IL DESTINO HA PARLATO!'
    : 'Pokémon normale. La caccia continua!';
  if (data.shiny) {
    for (let i = 0; i < 36; i++) {
      const spark = document.createElement('span');
      spark.className = 'psr-spark';
      spark.textContent = ['✦', '✧', '★', '✨'][i % 4];
      spark.style.left = `${Math.random() * 100}%`;
      spark.style.top = `${Math.random() * 100}%`;
      spark.style.animationDelay = `${Math.random() * 0.7}s`;
      overlay.append(spark);
      setTimeout(() => spark.remove(), 3300);
    }
  }
}

async function receive(message) {
  if (!message || message.sender === game.user.id) return;
  const { type, data, sender } = message;
  if (type === 'show') return makeOverlay(data);
  if (type === 'cancel') {
    if (currentSession?.id === data.id) removeOverlay();
    return;
  }
  if (type === 'result') return animateResult(data);
  if (type !== 'spin-request' || !game.user.isGM) return;
  const gm = game.users.filter(u => u.active && u.isGM).sort((a,b) => a.id.localeCompare(b.id))[0];
  if (gm?.id !== game.user.id || gmBusy) return;
  const pending = game.settings.get(MOD, 'pending');
  if (!pending?.id || pending.id !== data.id || pending.playerId !== sender) return;
  gmBusy = true;
  try {
    const count = game.settings.get(MOD, 'shinyCount');
    const denominator = 800 * 2 ** count;
    if (!Number.isSafeInteger(denominator)) throw new Error('Contatore troppo alto per probabilità esatta.');
    const shiny = Math.floor(Math.random() * denominator) === 0;
    // Riserva il giro prima di annunciarlo: previene doppi clic.
    await game.settings.set(MOD, 'pending', {});
    if (shiny) {
      const actor = game.actors.get(pending.actorId);
      if (actor) {
        await actor.setFlag(MOD, 'isShiny', true);
        await actor.setFlag(MOD, 'shinyFoundAt', Date.now());
      }
      await game.settings.set(MOD, 'shinyCount', count + 1);
    }
    const result = { id: data.id, shiny };
    emit('result', result);
    await animateResult(result);
    const speaker = ChatMessage.getSpeaker();
    await ChatMessage.create({
      speaker,
      content: `<div style="text-align:center"><h2>🎡 Shiny Roulette</h2><p><b>${escapeHTML(pending.pokemon)}</b></p><h2>${shiny ? '✨ SHINY! ✨' : 'Pokémon normale'}</h2><p>Probabilità del giro: 1 su ${denominator.toLocaleString('it-IT')}</p></div>`
    });
  } catch (err) {
    console.error(`[${MOD}]`, err);
    ui.notifications.error(`Roulette: ${err.message}`);
  } finally {
    gmBusy = false;
  }
}

async function openGM() {
  if (!game.user.isGM) return ui.notifications.warn('Solo il GM può autorizzare la roulette.');
  const gm = game.users.filter(u => u.active && u.isGM).sort((a,b) => a.id.localeCompare(b.id))[0];
  if (gm?.id !== game.user.id) return ui.notifications.warn('Solo il GM principale può gestire la roulette.');
  if (game.settings.get(MOD, 'pending')?.id) return ui.notifications.warn('Una roulette è già in attesa.');
  const token = canvas.tokens.controlled[0];
  if (!token?.actor) return ui.notifications.warn('Seleziona prima un token Pokémon.');
  const players = game.users.filter(u => u.active && !u.isGM);
  if (!players.length) return ui.notifications.warn('Nessun giocatore online.');
  const count = game.settings.get(MOD, 'shinyCount');
  const denominator = 800 * 2 ** count;
  const options = players.map(u => `<option value="${escapeHTML(u.id)}">${escapeHTML(u.name)}</option>`).join('');
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: '🎡 Autorizza Shiny Roulette' },
    content: `<div style="padding:12px;display:grid;gap:12px"><h2>${escapeHTML(token.name)}</h2><p>✨ Shiny trovati: <b>${count}</b><br>Probabilità attuale: <b>1 su ${denominator.toLocaleString('it-IT')}</b></p><label>Giocatore autorizzato<select name="psr-player">${options}</select></label><p>La ruota apparirà a tutti. Solo il giocatore scelto potrà avviarla.</p></div>`,
    buttons: [
      { action: 'start', label: '🎡 Apri la ruota', default: true, callback: (_event, _button, dialog) => dialog.element.querySelector('[name="psr-player"]').value },
      { action: 'cancel', label: 'Annulla', callback: () => null }
    ]
  });
  if (!result) return;
  const player = game.users.get(result);
  if (!player?.active) return ui.notifications.warn('Giocatore non più online.');
  const session = {
    id: foundry.utils.randomID(),
    actorId: token.actor.id,
    pokemon: token.name,
    playerId: result,
    playerName: player.name,
    denominator
  };
  await game.settings.set(MOD, 'pending', session);
  makeOverlay(session);
  emit('show', session);
}

async function resetCount(value = 0) {
  if (!game.user.isGM) throw new Error('Solo il GM può modificare il contatore.');
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Contatore non valido.');
  await game.settings.set(MOD, 'shinyCount', value);
  return value;
}
