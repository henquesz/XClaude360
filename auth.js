// Login com e-mail e senha (Supabase) antes de abrir o site. Depois do primeiro login a pessoa cria a
// gamertag e escolhe o avatar; só então o app (app.js) é carregado.
// Configuração do projeto em auth-config.js, tabela e regras em supabase/schema.sql.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './auth-config.js';
import { avatarSvg, PALETTES, randomSeed } from './boring-avatar.js';

const GAMERTAG_RE = /^[A-Za-z][A-Za-z0-9_ ]{2,14}$/;
const EMAIL_KEY = 'nfsu2.auth.email';
const MIN_PASSWORD = 6;
const root = document.getElementById('auth');
const configured = !SUPABASE_URL.includes('SEU-PROJETO') && !SUPABASE_ANON_KEY.includes('SUA-CHAVE');

let client = null;
let user = null;
let profile = null;
let appStarted = false;
let background = null;

// Mesmo fundo animado do dashboard, sobre quase preto
const BACKGROUND = {
  colors: ['#071a0a', '#0f6b1a', '#1aa41a', '#8ef07a'],
  shape: 'rise',
  characters: ' .:-=+x*#%@',
  cellSize: 15,
  density: 0.7,
  glyphOpacity: 0.75,
  gradientOpacity: 0.45,
  glow: 0.35,
  flicker: 0.15,
  softness: 0.6,
  flow: 0.45,
  speed: 0.6,
  grain: 0.05,
  scrambleRadius: 0.08,
  clickEffect: 'wave',
  dpr: 1.5,
};

// ---------------------------------------------------------------------------
// Telas

function show(html, { wide = false } = {}) {
  root.hidden = false;
  root.classList.toggle('is-overlay', appStarted);
  let content = document.getElementById('auth-content');
  if (!content) {
    root.innerHTML = '<div id="auth-bg" aria-hidden="true"></div><div id="auth-content"></div>';
    content = document.getElementById('auth-content');
    // Só antes de entrar: com o site aberto (editar perfil) o dashboard ou um jogo já usam a GPU
    if (!appStarted) startBackground();
  }
  content.innerHTML = `<div class="auth-card${wide ? ' is-wide' : ''}">${html}</div>`;
}

function startBackground() {
  import('./gradient-ascii.js')
    .then(({ createGradientAscii }) => {
      const container = document.getElementById('auth-bg');
      if (!container || appStarted || background) return;
      background = createGradientAscii(container, BACKGROUND);
    })
    .catch((err) => console.warn('auth: fundo animado indisponível', err));
}

function stopBackground() {
  if (background) background.stop();
  background = null;
}

function showLoading(text = 'Conectando…') {
  show(`<div class="auth-loading"><span class="auth-spinner" aria-hidden="true"></span>${escapeHtml(text)}</div>`);
}

// mode: 'signin' (entrar) ou 'signup' (criar conta). message aparece embaixo, como erro ou aviso.
function showLogin({ mode = 'signin', message = '', isError = true } = {}) {
  const signup = mode === 'signup';
  let savedEmail = '';
  try { savedEmail = localStorage.getItem(EMAIL_KEY) || ''; } catch {}
  show(`
    <div class="auth-brand"><span class="auth-orb" aria-hidden="true"></span><span>PS2 · PS1 no navegador</span></div>
    <nav class="auth-tabs" role="tablist">
      <button type="button" role="tab" aria-selected="${!signup}" class="${signup ? '' : 'is-active'}" ${signup ? 'id="auth-switch"' : ''}>entrar</button>
      <button type="button" role="tab" aria-selected="${signup}" class="${signup ? 'is-active' : ''}" ${signup ? '' : 'id="auth-switch"'}>criar conta</button>
    </nav>
    <p class="auth-sub">${signup
      ? 'Crie sua conta com e-mail e senha. Depois você escolhe a gamertag e o avatar.'
      : 'Bem-vindo de volta. Seus jogos e saves continuam guardados só neste navegador.'}</p>
    <form class="auth-form" id="auth-login" novalidate>
      <label class="auth-field">
        <span>E-mail</span>
        <input id="auth-email" type="email" autocomplete="email" spellcheck="false" value="${escapeHtml(savedEmail)}" placeholder="voce@exemplo.com">
      </label>
      <label class="auth-field">
        <span>Senha</span>
        <input id="auth-password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" placeholder="${signup ? `Pelo menos ${MIN_PASSWORD} caracteres` : '••••••••'}">
      </label>
      ${signup ? `<label class="auth-field">
        <span>Repita a senha</span>
        <input id="auth-password2" type="password" autocomplete="new-password" placeholder="••••••••">
      </label>` : ''}
      <button class="auth-btn auth-primary auth-wide" id="auth-submit" type="submit">${signup ? 'Criar conta' : 'Entrar'}</button>
      ${signup ? '' : '<button class="auth-link auth-forgot" id="auth-forgot" type="button">Esqueci a senha</button>'}
      <p class="${isError ? 'auth-error' : 'auth-notice'}" id="auth-message">${escapeHtml(message)}</p>
    </form>`);

  const email = document.getElementById('auth-email');
  const password = document.getElementById('auth-password');
  const submit = document.getElementById('auth-submit');
  const setMessage = (text, error = true) => {
    const line = document.getElementById('auth-message');
    line.className = error ? 'auth-error' : 'auth-notice';
    line.textContent = text;
  };

  document.getElementById('auth-switch').onclick = () => showLogin({ mode: signup ? 'signin' : 'signup' });
  const forgot = document.getElementById('auth-forgot');
  if (forgot) {
    forgot.onclick = async () => {
      const address = email.value.trim();
      if (!address) { setMessage('Digite seu e-mail acima e clique de novo em "Esqueci a senha".'); email.focus(); return; }
      forgot.disabled = true;
      const { error } = await client.auth.resetPasswordForEmail(address, { redirectTo: location.origin + location.pathname });
      forgot.disabled = false;
      if (error) setMessage(describeError(error));
      else setMessage(`Se existir uma conta com ${address}, enviamos um link para criar uma senha nova.`, false);
    };
  }

  document.getElementById('auth-login').onsubmit = async (event) => {
    event.preventDefault();
    const address = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) { setMessage('Digite um e-mail válido.'); email.focus(); return; }
    if (password.value.length < MIN_PASSWORD) { setMessage(`A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`); password.focus(); return; }
    if (signup && password.value !== document.getElementById('auth-password2').value) {
      setMessage('As senhas não são iguais.');
      document.getElementById('auth-password2').focus();
      return;
    }
    try { localStorage.setItem(EMAIL_KEY, address); } catch {}
    submit.disabled = true;
    setMessage('', false);
    try {
      if (signup) {
        const { data, error } = await client.auth.signUp({
          email: address,
          password: password.value,
          options: { emailRedirectTo: location.origin + location.pathname },
        });
        if (error) throw error;
        if (data.session) { await continueWithSession(data.session); return; }
        //Com "Confirm email" ligado o Supabase não diz se o e-mail já existia: uma conta sem identidades é esse caso
        if (data.user && data.user.identities && data.user.identities.length === 0) {
          showLogin({ message: 'Esse e-mail já tem conta. Entre com sua senha.' });
          return;
        }
        showLogin({ message: `Enviamos um link de confirmação para ${address}. Abra o e-mail, confirme e depois entre aqui.`, isError: false });
      } else {
        const { data, error } = await client.auth.signInWithPassword({ email: address, password: password.value });
        if (error) throw error;
        await continueWithSession(data.session);
      }
    } catch (err) {
      //Conta já existe: leva para "entrar" com o e-mail preenchido
      if (signup && (err.code === 'user_already_exists' || /already registered/i.test(err.message || ''))) {
        showLogin({ message: describeError(err) });
        return;
      }
      setMessage(describeError(err));
      submit.disabled = false;
    }
  };

  (email.value ? password : email).focus();
}

// Depois de abrir o link de "esqueci a senha"
function showNewPassword() {
  show(`
    <h1 class="auth-title">nova senha</h1>
    <p class="auth-sub">Escolha uma senha nova para a sua conta.</p>
    <form class="auth-form auth-login" id="auth-newpass" novalidate>
      <label for="auth-password">Senha nova</label>
      <input id="auth-password" type="password" autocomplete="new-password" placeholder="Pelo menos ${MIN_PASSWORD} caracteres">
      <label for="auth-password2">Repita a senha</label>
      <input id="auth-password2" type="password" autocomplete="new-password">
      <div class="auth-actions"><button class="auth-btn auth-primary" id="auth-submit" type="submit">Salvar senha</button></div>
      <p class="auth-error" id="auth-message"></p>
    </form>`);
  const password = document.getElementById('auth-password');
  const line = document.getElementById('auth-message');
  document.getElementById('auth-newpass').onsubmit = async (event) => {
    event.preventDefault();
    if (password.value.length < MIN_PASSWORD) { line.textContent = `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`; return; }
    if (password.value !== document.getElementById('auth-password2').value) { line.textContent = 'As senhas não são iguais.'; return; }
    document.getElementById('auth-submit').disabled = true;
    const { data, error } = await client.auth.updateUser({ password: password.value });
    if (error) {
      line.textContent = describeError(error);
      document.getElementById('auth-submit').disabled = false;
      return;
    }
    const { data: { session } } = await client.auth.getSession();
    await continueWithSession(session || { user: data.user });
  };
  password.focus();
}

// Criação (ou edição) do perfil: gamertag + avatar
function showProfileEditor({ editing = false, onSave, onCancel } = {}) {
  let seed = profile?.avatar_seed || randomSeed();
  let paletteIndex = Math.max(0, PALETTES.findIndex((p) => p.join() === (profile?.avatar_colors || []).join()));
  let availabilityTimer = 0;
  let lastChecked = '';

  show(`
    <div class="auth-brand"><span class="auth-orb" aria-hidden="true"></span><span>${editing ? 'Perfil' : 'Último passo'}</span></div>
    <h1 class="auth-title">${editing ? 'seu perfil' : 'criar perfil'}</h1>
    <p class="auth-sub">${editing ? 'Troque a gamertag ou o avatar quando quiser.' : 'Escolha a gamertag que os outros jogadores vão ver e gere o seu avatar.'}</p>
    <div class="auth-profile">
      <div class="auth-avatar-col">
        <div class="auth-avatar" id="auth-avatar"></div>
        <button class="auth-btn" id="auth-reroll">Gerar outro</button>
        <div class="auth-palettes" id="auth-palettes" role="radiogroup" aria-label="Cores do avatar"></div>
      </div>
      <form class="auth-form" id="auth-form" novalidate>
        <label for="auth-gamertag">Gamertag</label>
        <input id="auth-gamertag" maxlength="15" autocomplete="off" spellcheck="false" value="${escapeHtml(profile?.gamertag || '')}" placeholder="Ex.: Vini Henques">
        <small class="auth-hint" id="auth-hint">3 a 15 caracteres: letras, números, espaço e _ (começando com letra).</small>
        <div class="auth-actions">
          <button class="auth-btn auth-primary" id="auth-save" type="submit">${editing ? 'Salvar' : 'Criar perfil'}</button>
          ${editing ? '<button class="auth-btn" id="auth-cancel" type="button">Cancelar</button>' : '<button class="auth-btn auth-link" id="auth-signout" type="button">Sair</button>'}
        </div>
        <p class="auth-error" id="auth-error"></p>
      </form>
    </div>`, { wide: true });

  const input = document.getElementById('auth-gamertag');
  const hint = document.getElementById('auth-hint');
  const errorLine = document.getElementById('auth-error');
  const save = document.getElementById('auth-save');

  const renderAvatar = () => {
    document.getElementById('auth-avatar').innerHTML = avatarSvg(seed, PALETTES[paletteIndex], { size: 160, square: true });
    document.getElementById('auth-palettes').innerHTML = PALETTES.map((colors, i) =>
      `<button type="button" role="radio" aria-checked="${i === paletteIndex}" class="auth-swatch${i === paletteIndex ? ' is-on' : ''}" data-i="${i}" title="Cores ${i + 1}">` +
      colors.slice(0, 4).map((c) => `<i style="background:${c}"></i>`).join('') + '</button>').join('');
  };
  renderAvatar();

  document.getElementById('auth-reroll').onclick = () => { seed = randomSeed(); renderAvatar(); };
  document.getElementById('auth-palettes').onclick = (event) => {
    const swatch = event.target.closest('.auth-swatch');
    if (!swatch) return;
    paletteIndex = Number(swatch.dataset.i);
    renderAvatar();
  };

  const validate = () => {
    const tag = input.value.trim();
    if (!tag) return 'Escolha uma gamertag.';
    if (!GAMERTAG_RE.test(tag) || /  /.test(tag)) return 'Use 3 a 15 caracteres: letras, números, espaço e _ (começando com letra).';
    return '';
  };

  // Avisa se a gamertag já existe enquanto a pessoa digita
  input.oninput = () => {
    errorLine.textContent = '';
    clearTimeout(availabilityTimer);
    const problem = validate();
    hint.classList.toggle('bad', !!problem && input.value.trim().length >= 3);
    hint.classList.remove('good');
    if (problem) { hint.textContent = problem; return; }
    const tag = input.value.trim();
    if (editing && tag.toLowerCase() === (profile?.gamertag || '').toLowerCase()) { hint.textContent = 'Essa é a sua gamertag atual.'; return; }
    hint.textContent = 'Verificando…';
    availabilityTimer = setTimeout(async () => {
      lastChecked = tag;
      const available = await isGamertagAvailable(tag);
      if (lastChecked !== input.value.trim()) return;
      hint.textContent = available ? 'Disponível!' : 'Essa gamertag já está em uso.';
      hint.classList.toggle('good', available);
      hint.classList.toggle('bad', !available);
    }, 350);
  };

  document.getElementById('auth-form').onsubmit = async (event) => {
    event.preventDefault();
    const problem = validate();
    if (problem) { errorLine.textContent = problem; input.focus(); return; }
    save.disabled = true;
    errorLine.textContent = '';
    try {
      await onSave({ gamertag: input.value.trim(), avatar_seed: seed, avatar_colors: PALETTES[paletteIndex] });
    } catch (err) {
      errorLine.textContent = describeError(err);
      save.disabled = false;
    }
  };
  const cancel = document.getElementById('auth-cancel');
  if (cancel) cancel.onclick = onCancel;
  const signOutButton = document.getElementById('auth-signout');
  if (signOutButton) signOutButton.onclick = signOut;
  input.focus();
}

// ---------------------------------------------------------------------------
// Supabase

async function signOut() {
  try { await client.auth.signOut(); } catch {}
  location.reload();
}

async function loadProfile() {
  const { data, error } = await client
    .from('profiles')
    .select('gamertag, avatar_seed, avatar_colors')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function saveProfile(values, isNew) {
  const query = isNew
    ? client.from('profiles').insert({ id: user.id, ...values })
    : client.from('profiles').update(values).eq('id', user.id);
  const { error } = await query;
  if (error) throw error;
  profile = { ...profile, ...values };
}

async function isGamertagAvailable(tag) {
  const { data, error } = await client.rpc('gamertag_available', { tag });
  return error ? true : data !== false; // Sem resposta, deixa o banco decidir na hora de salvar
}

function describeError(error) {
  const code = error && (error.code || error.status);
  const text = String((error && (error.message || error.error_description)) || '').toLowerCase();
  if (code === 'invalid_credentials' || text.includes('invalid login credentials')) return 'E-mail ou senha incorretos.';
  if (code === 'email_not_confirmed' || text.includes('email not confirmed')) return 'Confirme seu e-mail pelo link que enviamos antes de entrar.';
  if (code === 'user_already_exists' || text.includes('already registered')) return 'Esse e-mail já tem conta. Entre com sua senha.';
  if (code === 'weak_password' || text.includes('password should be')) return `Senha fraca: use pelo menos ${MIN_PASSWORD} caracteres.`;
  if (code === 'same_password') return 'A senha nova precisa ser diferente da atual.';
  if (code === 'email_address_invalid' || text.includes('invalid format') || (text.includes('email address') && text.includes('invalid'))) return 'E-mail inválido.';
  if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit' || text.includes('rate limit')) return 'Muitas tentativas em pouco tempo. Espere alguns minutos e tente de novo.';
  if (code === 'signup_disabled' || text.includes('signups not allowed')) return 'Criação de contas desativada no momento.';
  if (text.includes('error sending') || code === 'email_address_not_authorized') return 'Não foi possível enviar o e-mail. Sem um SMTP próprio o Supabase só envia para os membros do projeto.';
  if (code === 'otp_expired' || text.includes('expired')) return 'O link expirou ou já foi usado. Peça outro.';
  if (code === '23505') return 'Essa gamertag já está em uso. Escolha outra.';
  if (code === '23514') return 'Gamertag inválida: use 3 a 15 caracteres (letras, números, espaço e _).';
  if (code === '42P01' || code === 'PGRST205' || code === 'PGRST202') return 'A tabela de perfis não existe: rode o supabase/schema.sql no SQL Editor do Supabase.';
  const message = (error && (error.message || error.error_description)) || String(error);
  return 'Erro: ' + message;
}

// Erro devolvido pelo Supabase no link do e-mail (#error=...&error_description=...)
function takeRedirectError() {
  const params = new URLSearchParams(location.search + '&' + location.hash.slice(1));
  const description = params.get('error_description') || params.get('error');
  if (description || params.has('code')) {
    // Limpa a URL (o código já foi trocado pela sessão)
    history.replaceState(null, '', location.pathname);
  }
  return description ? decodeURIComponent(description.replace(/\+/g, ' ')) : '';
}

// ---------------------------------------------------------------------------
// App

function mountProfileChip() {
  const status = document.getElementById('dash-status');
  if (!status || !profile) return;
  let chip = document.getElementById('auth-chip');
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'auth-chip';
    status.prepend(chip);
  }
  chip.innerHTML = `
    <button class="auth-chip-btn" aria-haspopup="menu" aria-expanded="false" title="Perfil">
      ${avatarSvg(profile.avatar_seed, profile.avatar_colors, { size: 28, square: true })}
      <b>${escapeHtml(profile.gamertag)}</b>
    </button>
    <div class="auth-menu" role="menu" hidden>
      <button role="menuitem" data-act="edit">Editar perfil</button>
      <button role="menuitem" data-act="signout">Sair</button>
    </div>`;
  const button = chip.querySelector('.auth-chip-btn');
  const menu = chip.querySelector('.auth-menu');
  button.onclick = (event) => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
  };
  document.addEventListener('click', () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); });
  menu.onclick = (event) => {
    const act = event.target.closest('button')?.dataset.act;
    if (act === 'signout') signOut();
    if (act === 'edit') editProfile();
  };
}

function editProfile() {
  showProfileEditor({
    editing: true,
    onSave: async (values) => {
      await saveProfile(values, false);
      root.hidden = true;
      mountProfileChip();
      window.dispatchEvent(new CustomEvent('nfsu2:profile', { detail: profile }));
    },
    onCancel: () => { root.hidden = true; },
  });
}

async function startApp() {
  if (appStarted) return;
  appStarted = true;
  stopBackground();
  root.hidden = true;
  root.innerHTML = '';
  // Disponível para o resto do site (ex.: mostrar a gamertag em algum lugar)
  window.nfsu2Profile = profile;
  window.nfsu2Auth = { client, user, signOut, editProfile };
  mountProfileChip();
  await import('./app.js');
  window.dispatchEvent(new CustomEvent('nfsu2:profile', { detail: profile }));
}

// ---------------------------------------------------------------------------

async function main() {
  // Pré-visualização das telas sem backend, só em localhost: ?authpreview=login, conta, perfil ou dash
  const preview = new URLSearchParams(location.search).get('authpreview');
  if (preview && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    if (preview === 'login' || preview === 'conta') {
      client = { auth: {} };
      showLogin({ mode: preview === 'conta' ? 'signup' : 'signin' });
      return;
    }
    if (preview === 'dash') {
      profile = { gamertag: 'Vini Henques', avatar_seed: randomSeed(), avatar_colors: PALETTES[0] };
      await startApp();
      return;
    }
    user = { id: 'preview' };
    client = { rpc: async () => ({ data: true }) };
    showProfileEditor({ onSave: async () => {}, onCancel: () => {} });
    return;
  }

  if (!configured) {
    console.warn('auth: auth-config.js sem os dados do Supabase, abrindo o site sem login.');
    await startApp();
    return;
  }

  if (!window.supabase || !window.supabase.createClient) {
    show('<p class="auth-error">Não foi possível carregar o Supabase (vendor/supabase.js).</p>');
    return;
  }

  showLoading();
  // Links dos e-mails (confirmação, senha nova) voltam com os tokens no #hash: lê o tipo antes do
  // Supabase limpar a URL. O fluxo "implicit" funciona mesmo se o link for aberto em outro navegador.
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const isRecovery = hashParams.get('type') === 'recovery';
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { flowType: 'implicit', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
  });

  const { data: { session }, error } = await client.auth.getSession();
  const redirectError = takeRedirectError();
  if (error || !session) {
    showLogin({ message: redirectError ? describeError({ message: redirectError, code: hashParams.get('error_code') }) : (error ? describeError(error) : '') });
    return;
  }
  if (isRecovery) {
    user = session.user;
    showNewPassword();
    return;
  }
  await continueWithSession(session);
}

async function continueWithSession(session) {
  user = session.user;

  // Sessão encerrada em outra aba ou expirada: volta para a tela de login
  client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') location.reload();
  });

  try {
    profile = await loadProfile();
  } catch (err) {
    show(`<h1 class="auth-title">ops</h1><p class="auth-error">${escapeHtml(describeError(err))}</p>
      <div class="auth-actions"><button class="auth-btn" id="auth-retry">Tentar de novo</button><button class="auth-btn auth-link" id="auth-signout">Sair</button></div>`);
    document.getElementById('auth-retry').onclick = () => location.reload();
    document.getElementById('auth-signout').onclick = signOut;
    return;
  }

  if (!profile) {
    showProfileEditor({
      onSave: async (values) => {
        await saveProfile(values, true);
        await startApp();
      },
    });
    return;
  }

  await startApp();
}

function escapeHtml(text) {
  return String(text).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]);
}

main().catch((err) => {
  console.error(err);
  show(`<p class="auth-error">${escapeHtml(describeError(err))}</p>`);
});
