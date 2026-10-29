/*
 * Kairós — Servidor de WhatsApp (Baileys) — v5.4.0
 * ------------------------------------------------------------------
 * Este processo precisa ficar LIGADO 24h: ele mantém a conexão com o
 * WhatsApp (WebSocket) e a sessão gravada em disco. Por isso ele roda em
 * um container sempre ativo (Railway, Render, VPS...), nunca em serverless.
 *
 * Responsabilidades:
 *   1. Manter a sessão do WhatsApp conectada (QR Code ou sessão salva).
 *   2. Receber mensagens dos clientes e entregar para o agente de IA.
 *   3. Enviar as respostas (IA e atendente humano) pelo WhatsApp.
 *   4. Enviar cobranças e confirmações de pagamento automáticas.
 *
 * A sessão fica salva na pasta WPP_AUTH_DIR. Essa pasta PRECISA estar em um
 * volume persistente, senão a sessão é perdida a cada deploy/reinício.
 *
 * Variáveis de ambiente (v5.3.0 — NENHUMA é obrigatória):
 *   PORT                  porta HTTP (padrão 8080, injetada pela hospedagem)
 *   WPP_API_KEY           opcional (tem padrão que combina com o painel)
 *   WPP_AGENT_SECRET      opcional (tem padrão que combina com o wpp-agente)
 *   SUPABASE_URL          opcional (tem padrão apontando para o Backend)
 *   WPP_AUTH_DIR          opcional — a pasta da sessão é detectada sozinha
 *   WPP_PUBLIC_URL        opcional — a URL pública é detectada sozinha
 *   TZ                    America/Sao_Paulo (recomendado)
 *
 * IMPORTANTE (v5.3.0): este servidor NÃO usa a chave de serviço do Backend.
 * Ela não é exposta ao usuário. Todo acesso ao banco é feito pela função
 * wpp-agente, autenticada com a chave do agente. Resultado: nada de chave
 * secreta copiada para o painel da hospedagem, e permissão completa no banco.
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const cron = require("node-cron");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require("@whiskeysockets/baileys");

const SERVER_VERSION = "5.4.0";
// Marco do realinhamento automático de chaves (v5.4.0).
// Guardado no disco para rodar UMA vez por versão, não a cada reinício.
const REALIGN_MARK = "crypto_v540";

// ───────────────────────────── Configuração ─────────────────────────────
// IMPORTANTE (causa nº1 de "deploy ok mas URL muda"):
// cada hospedagem faz a checagem de saúde numa porta. O Railway injeta PORT
// sozinho; o Fly, quando gera a configuração dele, usa 8080. Se o processo
// escutar em outra porta, a máquina é CRIADA mas nunca chega a "started" — e a
// URL responde "Request failed" para sempre (o log mostra servicecheck...-http-8080).
// Por isso o padrão é 8080, com escuta extra em 3000/3001 como rede de segurança.
const PORT = Number(process.env.PORT || 8080);
// REDE DE SEGURANÇA DE PORTAS (v5.1.2):
// O launcher web do Fly frequentemente gera um fly.toml com
// internal_port = 3000 (o padrão que ele usa para Node). Se o servidor
// escuta só em 8080/3001, quem atende é ninguém e o deploy termina com
// "Solicitação falhada" — mesmo com a máquina ligada e saudável.
// Escutando também na 3000, a checagem de saúde acerta em qualquer cenário.
const FALLBACK_PORTS = [8080, 3000, 3001].filter((p) => p !== PORT);
const API_KEY = process.env.WPP_API_KEY || "kairos_wpp_2026_7f3b9d2a";
const AGENT_SECRET = process.env.WPP_AGENT_SECRET || "kairos_ag_2026_2d8e5b1c";
const SUPABASE_URL = String(
  process.env.SUPABASE_URL || "https://het13a1zo93y9y95701f.helloreaddy.com/"
).replace(/\/+$/, "");
// v5.3.0 — Sem chave de serviço: a função wpp-agente faz o acesso ao banco.
// Assim o servidor tem permissão total sem você copiar nenhuma chave secreta.
const AGENT_URL = SUPABASE_URL + "/functions/v1/wpp-agente";

// ── Pasta da sessão: detectada sozinha (v5.2.0) ──────────────────────
// Antes essa pasta precisava ser digitada na mão (WPP_AUTH_DIR). Quando o
// caminho saía errado, a sessão era gravada na área temporária do container
// e o WhatsApp "desconectava sozinho" a cada reinício — era o erro mais
// comum de todos. Agora o servidor procura um disco montado e usa o
// primeiro que encontrar. WPP_AUTH_DIR continua funcionando se você quiser
// forçar um caminho específico.
function detectAuthDir() {
  const manual = String(process.env.WPP_AUTH_DIR || "").trim();
  if (manual) return { dir: manual, origem: "definida na variável WPP_AUTH_DIR" };
  const candidatos = [
    "/var/data",  // Render (disco criado pelo blueprint)
    "/data",      // Fly.io, Railway, EasyPanel, Docker com volume
    "/mnt/data",  // VPS com volume extra
    "/home/data", // alguns painéis
  ];
  for (const base of candidatos) {
    try {
      if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
        return { dir: path.join(base, "wpp-auth"), origem: "disco detectado em " + base };
      }
    } catch (e) {
      /* tenta o próximo */
    }
  }
  return { dir: "./wpp-auth", origem: "pasta local (NÃO persistente)" };
}

const AUTH_DETECT = detectAuthDir();
const AUTH_DIR = AUTH_DETECT.dir;

// Um diretório está em disco persistente quando pertence a um "device"
// diferente do diretório da aplicação — ou seja, é um volume montado.
// Isso evita o falso "está tudo bem" quando a pasta é temporária.
function isPersistentDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return fs.statSync(dir).dev !== fs.statSync(process.cwd()).dev;
  } catch (e) {
    return false;
  }
}

const AUTH_PERSISTENT = isPersistentDir(AUTH_DIR);
const STATE_FILE = path.join(AUTH_DIR, "server-state.json");
const MAX_RECONNECT = 12;
const LOG_PREFIX = "[wpp]";
const HORA_COBRANCA = 11; // 11:00 no horário de Brasília

const logger = pino({ level: "silent" });
const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Nada pode derrubar o processo: a sessão do WhatsApp precisa ficar viva.
process.on("uncaughtException", (err) => {
  console.error(LOG_PREFIX, "uncaughtException:", err && err.message ? err.message : err);
});
process.on("unhandledRejection", (err) => {
  console.error(LOG_PREFIX, "unhandledRejection:", err && err.message ? err.message : err);
});

// ───────────────────────────── Estado global ─────────────────────────────
const runtime = {
  status: "disconnected", // disconnected | connecting | waiting_qr | connected
  qr: null,
  lastError: null,
  sock: null,
  me: null,
  starting: false,
  attempts: 0,
  manualStop: true,
  connectedAt: null,
  lastMessageAt: null,
  messagesReceived: 0,
  messagesSent: 0,
  reconnects: 0,
  humanSent: 0,
};

const seenMessageIds = new Map(); // dedup de mensagens recebidas
const SEEN_TTL = 10 * 60 * 1000;

// ───────────── Cache das mensagens enviadas (v5.3.1) ─────────────
// POR QUE ISSO EXISTE — era o balão "Aguardando mensagem" no celular do cliente:
// quando o aparelho do cliente recebe uma mensagem e não consegue decifrar
// (a chave da sessão saiu de sincronia), o WhatsApp dele pede de volta o
// conteúdo original para quem enviou. Quem enviou PRECISA responder com a
// mensagem de verdade e assinada. Como antes a resposta era vazia, o cliente
// ficava eternamente no balão cinza com o relógio.
const sentMessages = new Map(); // id da mensagem -> { message, em }
const SENT_TTL = 30 * 60 * 1000; // 30 minutos

function rememberSent(id, message) {
  if (!id || !message) return;
  sentMessages.set(id, { message: message, em: Date.now() });
  if (sentMessages.size > 300) {
    const agora = Date.now();
    for (const [k, v] of sentMessages) {
      if (agora - v.em > SENT_TTL || sentMessages.size > 300) sentMessages.delete(k);
    }
  }
}

function getSentMessage(id) {
  const item = id ? sentMessages.get(id) : null;
  if (!item) return null;
  if (Date.now() - item.em > SENT_TTL) {
    sentMessages.delete(id);
    return null;
  }
  return item.message;
}

// Cache minúsculo usado para o contador de retentativas do Baileys.
// Sem ele, o mesmo pedido de reenvio pode entrar em loop.
function createTinyCache() {
  const data = new Map();
  return {
    get: (k) => {
      const item = data.get(k);
      if (!item) return undefined;
      if (item.exp && item.exp < Date.now()) {
        data.delete(k);
        return undefined;
      }
      return item.value;
    },
    set: (k, value, ttlSegundos) => {
      data.set(k, { value: value, exp: ttlSegundos ? Date.now() + ttlSegundos * 1000 : 0 });
    },
    del: (k) => {
      data.delete(k);
    },
    flushAll: () => data.clear(),
  };
}

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function setError(message) {
  runtime.lastError = message ? String(message).slice(0, 400) : null;
}

// ───────────────────────────── Plataforma / URLs ─────────────────────────────
// Detecta a URL pública sem depender de uma hospedagem específica.
function detectPublicUrl() {
  const fromEnv = String(process.env.WPP_PUBLIC_URL || "").trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  if (process.env.FLY_APP_NAME) return "https://" + process.env.FLY_APP_NAME + ".fly.dev";
  if (process.env.RENDER_EXTERNAL_URL) return String(process.env.RENDER_EXTERNAL_URL).replace(/\/+$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return "https://" + process.env.RAILWAY_PUBLIC_DOMAIN;
  if (process.env.KOYEB_PUBLIC_DOMAIN) return "https://" + process.env.KOYEB_PUBLIC_DOMAIN;
  if (process.env.COOLIFY_URL) return String(process.env.COOLIFY_URL).replace(/\/+$/, "");
  return "";
}

function detectPlatform() {
  if (process.env.FLY_APP_NAME) return "fly.io";
  if (process.env.RENDER) return "render";
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN) return "railway";
  if (process.env.KOYEB_PUBLIC_DOMAIN) return "koyeb";
  return "docker/vps";
}

const PUBLIC_URL = detectPublicUrl();
const PLATFORM = detectPlatform();

// ───────────────────────────── Estado persistido ─────────────────────────────
// Fica no volume, junto da sessão, para sobreviver a reinícios.
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) || {};
  } catch (e) {
    return {};
  }
}

function writeState(patch) {
  try {
    const state = Object.assign({}, readState(), patch);
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return state;
  } catch (e) {
    console.error(LOG_PREFIX, "Não foi possível salvar o estado:", e.message);
    return null;
  }
}

// Data de hoje no horário de Brasília (YYYY-MM-DD).
function todayBRT() {
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

function minutesNowBRT() {
  try {
    const partes = new Date().toLocaleTimeString("en-GB", {
      timeZone: "America/Sao_Paulo",
      hour12: false,
    });
    const [h, m] = partes.split(":").map(Number);
    return h * 60 + m;
  } catch (e) {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }
}

// ───────────────────────────── Helpers gerais ─────────────────────────────
function normalizeNumber(phone) {
  let p = String(phone || "").replace(/\D/g, "");
  if (!p) return "";
  if (p.length <= 11) p = "55" + p;
  return p;
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error((label || "Operação") + " excedeu o tempo limite"));
    }, ms);
    Promise.resolve(promise)
      .then((value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

function formatCurrency(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDateBR(iso) {
  if (!iso) return "";
  const raw = String(iso).slice(0, 10);
  const d = new Date(raw + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function credsExist() {
  try {
    return fs.existsSync(path.join(AUTH_DIR, "creds.json"));
  } catch (e) {
    return false;
  }
}

function isRegistered() {
  try {
    return !!(runtime.sock && runtime.sock.authState && runtime.sock.authState.creds.registered);
  } catch (e) {
    return false;
  }
}

function clearAuthDir() {
  try {
    const state = readState();
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    if (state.lastCobrancaDate) writeState({ lastCobrancaDate: state.lastCobrancaDate });
    return true;
  } catch (e) {
    console.error(LOG_PREFIX, "Falha ao limpar sessão:", e.message);
    return false;
  }
}

// ───────────────────── Realinhamento das chaves de conversa (v5.4.0) ─────────────────────
// POR QUE ISSO EXISTE — era o balão "Aguardando mensagem" no celular do CLIENTE,
// mesmo com o servidor conectado e o painel dizendo "enviado":
// cada conversa guarda um arquivo session-*.json por aparelho do contato. Quando
// esse arquivo sai de sincronia (cliente trocou de celular, migração do número
// para LID, reinício no meio da troca de chaves, dois processos usando o mesmo
// disco), o servidor continua cifrando com uma chave que o celular do cliente
// NÃO reconhece. A mensagem sai, o cliente recebe o envelope, não consegue abrir,
// pede o conteúdo de volta... e nunca destrava: fica no balão cinza com o relógio.
//
// A cura é apagar SÓ esses arquivos de sessão de conversa. Eles são recriados na
// hora, no envio seguinte, por uma troca nova de chaves. O creds.json (que é o
// vínculo do número com o WhatsApp) NÃO é tocado — ou seja, não precisa escanear
// QR Code de novo e a conexão não cai.
function listarArquivosSessao() {
  try {
    return fs.readdirSync(AUTH_DIR).filter((f) => f.startsWith("session-") && f.endsWith(".json"));
  } catch (e) {
    return [];
  }
}

function limparSessoesDeConversa() {
  let removidos = 0;
  for (const arquivo of listarArquivosSessao()) {
    try {
      fs.rmSync(path.join(AUTH_DIR, arquivo), { force: true });
      removidos += 1;
    } catch (e) {
      /* segue tentando os outros */
    }
  }
  return removidos;
}

// Reinicia o socket mantendo a sessão do número: só as chaves de conversa somem.
async function realinharCriptografia() {
  if (!credsExist()) {
    return { ok: false, erro: "Não existe sessão salva para realinhar. Conecte o WhatsApp primeiro." };
  }
  runtime.manualStop = true;
  try {
    if (runtime.sock) runtime.sock.end(undefined);
  } catch (e) {
    /* ignora */
  }
  runtime.sock = null;
  runtime.status = "disconnected";
  runtime.qr = null;

  const removidos = limparSessoesDeConversa();
  writeState({
    realinhamento: REALIGN_MARK,
    lastRealinhamentoAt: new Date().toISOString(),
    lastRealinhamentoQtd: removidos,
  });

  // Dá um instante para o disco respirar antes de reler as credenciais.
  await new Promise((r) => setTimeout(r, 500));

  runtime.manualStop = false;
  await connect();
  log("Chaves de conversa realinhadas. Arquivos renovados: " + removidos);
  return { ok: true, sessoes: removidos };
}

// ───────────────────────────── Agente de IA ─────────────────────────────
async function callAgent(payload) {
  try {
    const res = await withTimeout(
      fetch(AGENT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": AGENT_SECRET },
        body: JSON.stringify(payload),
      }),
      45000,
      "Agente de IA"
    );
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      console.error(LOG_PREFIX, "Resposta inválida do agente:", text.slice(0, 200));
      return null;
    }
  } catch (err) {
    console.error(LOG_PREFIX, "Falha ao chamar o agente:", err.message);
    return null;
  }
}

async function confirmMessageStatus(mensagemId, status, erro) {
  if (!mensagemId) return;
  await callAgent({
    acao: "confirmar_envio",
    mensagem_id: mensagemId,
    status: status,
    erro: erro || null,
  });
}

// ───────────────────────────── Envio ─────────────────────────────
async function resolveJid(phone) {
  const fallback = normalizeNumber(phone) + "@s.whatsapp.net";
  try {
    if (!runtime.sock || typeof runtime.sock.onWhatsApp !== "function") {
      return { jid: fallback, existe: null };
    }
    const res = await withTimeout(
      runtime.sock.onWhatsApp(normalizeNumber(phone)),
      8000,
      "Consulta do número"
    );
    if (!Array.isArray(res) || res.length === 0) return { jid: fallback, existe: null };
    const found = res.find((item) => item && item.exists);
    if (found) {
      // v5.4.0 — alguns contatos novos existem só no formato LID (identidade
      // interna do WhatsApp). Enviar no formato antigo (@s.whatsapp.net) faz o
      // celular do cliente receber um envelope que ele não consegue abrir, que
      // é justamente o balão "Aguardando mensagem". Por isso aqui usamos o
      // identificador que o próprio WhatsApp devolveu.
      const alvo = found.jid || found.lid;
      if (alvo) return { jid: alvo, existe: true };
      return { jid: fallback, existe: true };
    }
    return { jid: fallback, existe: false };
  } catch (e) {
    return { jid: fallback, existe: null };
  }
}

async function sendToJid(jid, text, mensagemId) {
  if (!runtime.sock || runtime.status !== "connected") {
    await confirmMessageStatus(mensagemId, "falhou", "WhatsApp não conectado");
    return { ok: false, error: "WhatsApp não conectado" };
  }
  try {
    try {
      await runtime.sock.sendPresenceUpdate("composing", jid);
    } catch (e) {
      /* presença é opcional */
    }
    const enviada = await withTimeout(runtime.sock.sendMessage(jid, { text: text }), 30000, "Envio");
    if (enviada && enviada.key && enviada.key.id) {
      rememberSent(enviada.key.id, enviada.message);
    }
    runtime.messagesSent += 1;
    await confirmMessageStatus(mensagemId, "enviado");
    return { ok: true };
  } catch (err) {
    await confirmMessageStatus(mensagemId, "falhou", err.message);
    return { ok: false, error: err.message };
  }
}

async function sendToPhone(phone, text) {
  const target = await resolveJid(phone);
  if (target.existe === false) return { ok: false, error: "Número não possui WhatsApp" };
  return sendToJid(target.jid, text);
}

// ───────────────────────────── Conexão ─────────────────────────────
async function onConnectionUpdate(update) {
  const { connection, qr, lastDisconnect } = update;

  if (qr) {
    runtime.status = "waiting_qr";
    try {
      runtime.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    } catch (e) {
      runtime.qr = qr;
    }
    setError(null);
  }

  if (connection === "open") {
    runtime.status = "connected";
    runtime.qr = null;
    runtime.attempts = 0;
    runtime.connectedAt = Date.now();
    setError(null);
    const user = runtime.sock && runtime.sock.user;
    runtime.me = user ? { id: user.id || "", name: user.name || user.verifiedName || "" } : null;
    log("WhatsApp conectado", runtime.me ? "(" + runtime.me.id + ")" : "");
    // Aproveita a conexão para recuperar cobrança do dia que tenha sido perdida.
    setTimeout(() => {
      runDailyCobranca("recuperacao").catch(() => {});
    }, 15000);
  }

  if (connection === "close") {
    const code =
      lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
        ? lastDisconnect.error.output.statusCode
        : null;
    runtime.status = "disconnected";
    runtime.qr = null;
    runtime.me = null;
    log("Conexão encerrada. Código:", code);

    if (code === DisconnectReason.loggedOut) {
      clearAuthDir();
      setError("A sessão foi encerrada no celular. Clique em Conectar e escaneie o QR Code novamente.");
      return;
    }
    if (code === DisconnectReason.connectionReplaced) {
      setError("Outra conexão assumiu este número do WhatsApp. Feche a outra sessão e conecte novamente.");
      return;
    }
    if (runtime.manualStop) return;

    // Sem sessão salva o QR expirou: esperar o usuário clicar em Conectar.
    if (!credsExist()) {
      setError("O QR Code expirou. Clique em Conectar WhatsApp para gerar um novo.");
      return;
    }
    if (runtime.attempts >= MAX_RECONNECT) {
      setError("Não foi possível reconectar automaticamente. Clique em Conectar WhatsApp.");
      return;
    }

    runtime.attempts += 1;
    runtime.reconnects += 1;
    const delay = Math.min(3000 * runtime.attempts, 30000);
    log("Reconectando em " + Math.round(delay / 1000) + "s (tentativa " + runtime.attempts + ")");
    setTimeout(() => {
      if (!runtime.manualStop) connect();
    }, delay);
  }
}

function extractText(message) {
  if (!message) return "";
  if (typeof message.conversation === "string") return message.conversation;
  if (message.extendedTextMessage && message.extendedTextMessage.text) {
    return message.extendedTextMessage.text;
  }
  if (message.imageMessage && message.imageMessage.caption) return message.imageMessage.caption;
  if (message.videoMessage && message.videoMessage.caption) return message.videoMessage.caption;
  if (message.documentMessage && message.documentMessage.caption) return message.documentMessage.caption;
  if (message.buttonsResponseMessage && message.buttonsResponseMessage.selectedDisplayText) {
    return message.buttonsResponseMessage.selectedDisplayText;
  }
  if (message.listResponseMessage && message.listResponseMessage.title) {
    return message.listResponseMessage.title;
  }
  if (message.templateButtonReplyMessage && message.templateButtonReplyMessage.selectedDisplayText) {
    return message.templateButtonReplyMessage.selectedDisplayText;
  }
  if (message.ephemeralMessage && message.ephemeralMessage.message) {
    return extractText(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage && message.viewOnceMessage.message) {
    return extractText(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2 && message.viewOnceMessageV2.message) {
    return extractText(message.viewOnceMessageV2.message);
  }
  return "";
}

function cleanupSeen() {
  const now = Date.now();
  for (const [id, ts] of seenMessageIds) {
    if (now - ts > SEEN_TTL) seenMessageIds.delete(id);
  }
}

async function handleIncomingMessage(msg) {
  const key = msg.key || {};
  const jid = key.remoteJid || "";
  if (!jid || key.fromMe) return;
  if (jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@broadcast")) return;

  const phone = jid.split("@")[0].split(":")[0].replace(/\D/g, "");
  if (!phone) return;

  if (key.id) {
    if (seenMessageIds.has(key.id)) return;
    seenMessageIds.set(key.id, Date.now());
    if (seenMessageIds.size > 500) cleanupSeen();
  }

  const texto = String(extractText(msg.message) || "").trim();
  runtime.messagesReceived += 1;
  runtime.lastMessageAt = Date.now();

  if (!texto) {
    await sendToJid(
      jid,
      "Oi! Por enquanto eu consigo ler apenas mensagens de texto. Pode me escrever que eu já te ajudo? 🙂"
    );
    return;
  }

  const resposta = await callAgent({
    acao: "mensagem",
    whatsapp: phone,
    jid: jid,
    mensagem: texto,
    mensagem_id: key.id || null,
  });

  if (!resposta) return;
  if (!resposta.respondido || !resposta.resposta) return;

  const envio = await sendToJid(jid, resposta.resposta, resposta.mensagem_id);
  if (!envio.ok) {
    log("Falha ao responder " + phone + ": " + envio.error);
  } else {
    log("IA respondeu para " + phone);
  }
}

async function onMessagesUpsert(payload) {
  if (!payload || payload.type !== "notify") return;
  const messages = payload.messages || [];
  for (const msg of messages) {
    try {
      await handleIncomingMessage(msg);
    } catch (err) {
      console.error(LOG_PREFIX, "Erro ao processar mensagem:", err.message);
    }
  }
}

async function connect() {
  if (runtime.starting) {
    log("Conexão já em andamento, ignorando chamada duplicada.");
    return;
  }
  runtime.starting = true;
  runtime.manualStop = false;
  setError(null);
  runtime.status = "connecting";

  try {
    if (runtime.sock) {
      try {
        runtime.sock.end(undefined);
      } catch (e) {
        /* ignora */
      }
      runtime.sock = null;
    }

    const authState = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch (e) {
      version = undefined;
    }

    const sock = makeWASocket({
      version: version,
      auth: {
        creds: authState.state.creds,
        keys: makeCacheableSignalKeyStore(authState.state.keys, logger),
      },
      logger: logger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Chrome"),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      msgRetryCounterCache: createTinyCache(),
      // Devolve a mensagem ORIGINAL quando o cliente pede reenvio.
      // Nunca devolver vazio: é exatamente isso que deixa o cliente
      // preso no balão "Aguardando mensagem".
      getMessage: async (key) => {
        const original = getSentMessage(key && key.id);
        return original || undefined;
      },
    });

    runtime.sock = sock;
    sock.ev.on("creds.update", authState.saveCreds);
    sock.ev.on("connection.update", (update) => {
      onConnectionUpdate(update).catch((err) => {
        console.error(LOG_PREFIX, "Erro em connection.update:", err.message);
      });
    });
    sock.ev.on("messages.upsert", (payload) => {
      onMessagesUpsert(payload).catch((err) => {
        console.error(LOG_PREFIX, "Erro em messages.upsert:", err.message);
      });
    });

    log("Socket iniciado. Sessão salva:", credsExist() ? "sim" : "não");
  } catch (err) {
    runtime.status = "disconnected";
    setError("Falha ao iniciar a conexão: " + err.message);
    console.error(LOG_PREFIX, "Erro ao iniciar conexão:", err.message);
  } finally {
    runtime.starting = false;
  }
}

async function disconnect() {
  runtime.manualStop = true;
  runtime.attempts = 0;
  try {
    if (runtime.sock) runtime.sock.end(undefined);
  } catch (e) {
    /* ignora */
  }
  runtime.sock = null;
  runtime.status = "disconnected";
  runtime.qr = null;
  runtime.me = null;
  log("Desconectado manualmente");
}

// Remove o vínculo no celular e apaga a sessão salva (conectar do zero).
async function resetSession() {
  runtime.manualStop = true;
  try {
    if (runtime.sock) {
      try {
        await withTimeout(runtime.sock.logout(), 10000, "Logout");
      } catch (e) {
        /* segue limpando */
      }
      try {
        runtime.sock.end(undefined);
      } catch (e) {
        /* ignora */
      }
    }
  } catch (e) {
    /* ignora */
  }
  runtime.sock = null;
  clearAuthDir();
  runtime.status = "disconnected";
  runtime.qr = null;
  runtime.me = null;
  runtime.attempts = 0;
  runtime.starting = false;
  runtime.manualStop = false;
  setError(null);
  await connect();
}

// ───────────────────────────── Cobrança / confirmações ─────────────────────────────
function buildMessageTemplate(daysDiff, nome, valor, link) {
  const v = formatCurrency(valor);
  const app = link || "https://kairostempodedeus.com/cliente";
  if (daysDiff < 0) {
    const d = Math.abs(daysDiff);
    return (
      "⚠️ Olá, " + nome + "! Tudo bem? 😊\n\n" +
      "Percebemos que sua parcela de " + v + " venceu há " + d + (d === 1 ? " dia" : " dias") + " 📅.\n\n" +
      "Para regularizar sua situação e manter sua linha de crédito ativa 💙, realize o pagamento o quanto antes.\n\n" +
      "📱 Aplicativo: 🔗 " + app + "\n\n💙 Loja Kairós"
    );
  }
  if (daysDiff === 0) {
    return (
      "📢 Olá, " + nome + "! Tudo bem? 😊\n\n" +
      "Sua parcela de " + v + " vence hoje 📝💳✨. Pague hoje para evitar juros e manter seu bom histórico.\n\n" +
      "🔗 " + app + "\n\nKairós Crédito 💙🚀"
    );
  }
  if (daysDiff === 1) {
    return (
      "🌟 Olá, " + nome + "! Sua parcela de " + v + " vence amanhã 📅. Mensagem automática para ajudar na sua organização.\n\n" +
      "🔗 " + app + "\n\n💙 Loja Kairós"
    );
  }
  return (
    "🌟 Olá, " + nome + "! Sua parcela de " + v + " vence em " + daysDiff + " dias 📅. Mensagem automática para ajudar na sua organização.\n\n" +
    "🔗 " + app + "\n\n💙 Loja Kairós"
  );
}

function buildMessage(nome, valor, vencimento, link) {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const venc = new Date(String(vencimento || "").slice(0, 10) + "T00:00:00");
  const diff = isNaN(venc.getTime()) ? 0 : Math.round((venc - hoje) / 86400000);
  return buildMessageTemplate(diff, nome, valor, link);
}

async function saveMessageRecord(rec) {
  try {
    const res = await callAgent({
      acao: "salvar_mensagem",
      registro: {
        client_id: rec.client_id || null,
        parcela_id: rec.parcela_id || null,
        cliente_nome: rec.cliente_nome,
        whatsapp: rec.whatsapp,
        mensagem: rec.mensagem,
        status: rec.status,
        erro: rec.erro || null,
        tipo: rec.tipo || "manual",
      },
    });
    if (!res || res.ok !== true) {
      console.error(LOG_PREFIX, "Não foi possível salvar o histórico de mensagem.");
    }
  } catch (e) {
    console.error(LOG_PREFIX, "Erro ao salvar histórico de mensagem:", e.message);
  }
}

const DEFAULT_CONFIRMACAO =
  "✅ Olá, {nome}! Pagamento confirmado com sucesso! 💙\n\n" +
  "📄 Parcela: {parcela} de {produto}\n" +
  "💰 Valor: {valor}\n" +
  "📅 Data do pagamento: {data}\n\n" +
  "Agradecemos pela sua confiança! Continuamos à disposição. 🙌\n\n" +
  "💙 {empresa}";

function fillTokens(template, map) {
  let out = String(template || "");
  Object.keys(map).forEach((key) => {
    out = out.split("{" + key + "}").join(String(map[key] == null ? "" : map[key]));
  });
  return out;
}

let confirmRunning = false;
let confirmStartedAt = 0;
const confirmFailCount = {};

async function sendPaymentConfirmations() {
  if (runtime.status !== "connected" || !runtime.sock) return;
  if (confirmRunning) {
    if (confirmStartedAt && Date.now() - confirmStartedAt > 120000) {
      confirmRunning = false;
    } else {
      return;
    }
  }
  confirmRunning = true;
  confirmStartedAt = Date.now();

  try {
    // MARCO DE INÍCIO: a função wpp-agente aplica o campo iniciar_em da
    // configuração. Nada é enviado para pagamentos ANTERIORES ao momento em
    // que a confirmação foi ativada — só o que o cliente pagar daqui pra frente.
    const desde = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const lote = await callAgent({ acao: "confirmacao_lote", desde });
    if (!lote || lote.ok !== true) {
      if (lote && lote.erro) console.error(LOG_PREFIX, "Confirmações:", lote.erro);
      return;
    }

    const cfg = lote.config;
    if (cfg && cfg.ativo === false) return;
    const template = (cfg && cfg.mensagem) || DEFAULT_CONFIRMACAO;

    const parcelas = Array.isArray(lote.parcelas) ? lote.parcelas : [];
    if (parcelas.length === 0) return;

    for (const p of parcelas) {
      const client = p.cliente || null;
      if (!client || !client.whatsapp) continue;

      // Reserva atômica: a mesma parcela nunca é avisada duas vezes.
      const claim = await callAgent({ acao: "confirmacao_marcar", parcela_id: p.id });
      if (!claim || claim.ok !== true) continue;

      const phone = normalizeNumber(client.whatsapp);
      const nome = client.full_name || "Cliente";
      const dataPago = p.data_pagamento || (p.pago_em ? String(p.pago_em).slice(0, 10) : "");
      const carne = p.carne || null;
      const mensagem = fillTokens(template, {
        nome: nome,
        valor: formatCurrency(p.valor),
        parcela: p.numero,
        produto: (carne && carne.product_name) || "Carnê",
        data: dataPago ? formatDateBR(dataPago) : "",
        link: (carne && carne.link) || "",
        empresa: "Kairós",
      });

      try {
        const destino = await resolveJid(phone);
        if (destino.existe === false) {
          await saveMessageRecord({
            client_id: client.id,
            parcela_id: p.id,
            cliente_nome: nome,
            whatsapp: phone,
            mensagem: mensagem,
            status: "falhou",
            erro: "Número não possui WhatsApp",
            tipo: "confirmacao",
          });
          continue;
        }
        const conf = await withTimeout(
          runtime.sock.sendMessage(destino.jid, { text: mensagem }),
          30000,
          "Envio"
        );
        if (conf && conf.key && conf.key.id) rememberSent(conf.key.id, conf.message);
        delete confirmFailCount[p.id];
        await saveMessageRecord({
          client_id: client.id,
          parcela_id: p.id,
          cliente_nome: nome,
          whatsapp: phone,
          mensagem: mensagem,
          status: "enviado",
          tipo: "confirmacao",
        });
        log("Confirmação enviada para", nome);
        await new Promise((r) => setTimeout(r, 2000));
      } catch (err) {
        confirmFailCount[p.id] = (confirmFailCount[p.id] || 0) + 1;
        const tentativas = confirmFailCount[p.id];
        if (tentativas < 5) {
          await callAgent({ acao: "confirmacao_desmarcar", parcela_id: p.id });
        }
        if (tentativas === 1 || tentativas >= 5) {
          await saveMessageRecord({
            client_id: client.id,
            parcela_id: p.id,
            cliente_nome: nome,
            whatsapp: phone,
            mensagem: mensagem,
            status: "falhou",
            erro: tentativas >= 5 ? "Falha repetida: " + err.message : err.message,
            tipo: "confirmacao",
          });
        }
      }
    }
  } catch (err) {
    console.error(LOG_PREFIX, "Erro na varredura de confirmações:", err.message);
  } finally {
    confirmRunning = false;
    confirmStartedAt = 0;
  }
}

// Envia a cobrança do dia. Protegida por estado em disco para NÃO repetir
// quando o serviço reinicia (deploy, queda, troca de hospedagem).
let cobrancaRunning = false;
async function runDailyCobranca(origem) {
  const hoje = todayBRT();
  if (cobrancaRunning) return;
  if (runtime.status !== "connected" || !runtime.sock) {
    log("[COBRANCA] Ignorada (" + origem + "): WhatsApp não conectado.");
    return;
  }
  if (readState().lastCobrancaDate === hoje) {
    log("[COBRANCA] Já executada hoje (" + hoje + "). Nada a fazer.");
    return;
  }

  cobrancaRunning = true;
  // Marca antes de enviar: garante que um reinício no meio não duplique mensagens.
  writeState({ lastCobrancaDate: hoje, lastCobrancaAt: new Date().toISOString(), lastCobrancaOrigem: origem });

  try {
    log("[COBRANCA] Iniciando envio do dia (" + origem + ")...");
    const lote = await callAgent({ acao: "cobranca_lote", hoje });
    if (!lote || lote.ok !== true) {
      if (lote && lote.erro) console.error(LOG_PREFIX, "[COBRANCA] Banco:", lote.erro);
      // Libera a data para tentar de novo na próxima checagem.
      writeState({ lastCobrancaDate: null });
      return;
    }

    const parcelas = Array.isArray(lote.parcelas) ? lote.parcelas : [];
    if (parcelas.length === 0) return;

    let enviados = 0;
    for (const p of parcelas) {
      const client = p.cliente || null;
      if (!client || !client.whatsapp) continue;
      const carne = p.carne || null;
      const phone = normalizeNumber(client.whatsapp);
      const mensagem = buildMessage(client.full_name || "Cliente", p.valor, p.vencimento, (carne && carne.link) || "");
      const resultado = await sendToPhone(phone, mensagem);
      if (resultado.ok) enviados += 1;
      await saveMessageRecord({
        client_id: client.id,
        parcela_id: p.id,
        cliente_nome: client.full_name,
        whatsapp: phone,
        mensagem: mensagem,
        status: resultado.ok ? "enviado" : "falhou",
        erro: resultado.error,
        tipo: "automatico",
      });
      await new Promise((r) => setTimeout(r, 2000));
    }
    writeState({ lastCobrancaEnviados: enviados });
    log("[COBRANCA] Finalizada. Enviadas: " + enviados + " de " + parcelas.length + ".");
  } catch (err) {
    console.error(LOG_PREFIX, "[COBRANCA] Erro:", err.message);
  } finally {
    cobrancaRunning = false;
  }
}

// Envia as mensagens que os atendentes humanos escrevem no painel.
// A fila vem do agente de IA, porque o servidor não tem permissão de leitura
// nessas tabelas — era isso que deixava as respostas presas em "pendente".
let pendingRunning = false;
async function sendPendingHumanMessages() {
  if (runtime.status !== "connected" || !runtime.sock || pendingRunning) return;
  pendingRunning = true;
  try {
    const fila = await callAgent({ acao: "pendentes", limite: 15 });
    const mensagens = (fila && Array.isArray(fila.mensagens)) ? fila.mensagens : [];
    if (mensagens.length === 0) return;

    for (const m of mensagens) {
      const resultado = await sendToPhone(m.whatsapp, m.mensagem);
      await confirmMessageStatus(m.id, resultado.ok ? "enviado" : "falhou", resultado.error);
      if (resultado.ok) runtime.humanSent += 1;
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (err) {
    console.error(LOG_PREFIX, "Erro ao enviar mensagens humanas:", err.message);
  } finally {
    pendingRunning = false;
  }
}

// ───────────────────────────── Rotas ─────────────────────────────
function checkAuth(req, res, next) {
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// v5.3.0 — a permissão do banco não depende mais de nenhuma chave no servidor:
// quem executa as consultas é a função wpp-agente, com permissão total.
function permissoesBanco() {
  if (dbHealth.status === "ok") return "completa";
  if (String(dbHealth.status).indexOf("erro") === 0) return "limitada";
  return "verificando";
}

function statusPayload() {
  const state = readState();
  return {
    status: runtime.status,
    qr: runtime.qr,
    last_error: runtime.lastError,
    engine: "baileys",
    server_version: SERVER_VERSION,
    platform: PLATFORM,
    registered: isRegistered() || credsExist(),
    uptime: Math.round(process.uptime()),
    me: runtime.me,
    connected_at: runtime.connectedAt,
    last_message_at: runtime.lastMessageAt,
    messages_received: runtime.messagesReceived,
    messages_sent: runtime.messagesSent,
    human_sent: runtime.humanSent,
    reconnectAttempts: runtime.attempts,
    maxReconnect: MAX_RECONNECT,
    reconnects: runtime.reconnects,
    auth_dir: AUTH_DIR,
    auth_dir_origem: AUTH_DETECT.origem,
    auth_persistente: AUTH_PERSISTENT,
    volume_ok: credsExist(),
    db_key: "agente",
    last_cobranca: state.lastCobrancaDate || null,
    last_cobranca_at: state.lastCobrancaAt || null,
    conversas_ativas: listarArquivosSessao().length,
    realinhamento_em: state.lastRealinhamentoAt || null,
    realinhamento_qtd: state.lastRealinhamentoQtd == null ? null : state.lastRealinhamentoQtd,
    today: todayBRT(),
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Kairos WPP",
    version: SERVER_VERSION,
    engine: "baileys",
    platform: PLATFORM,
    status: runtime.status,
  });
});

// Saúde do banco fica em CACHE.
// IMPORTANTE: a verificação de saúde da hospedagem (Fly/Render) tem tempo
// limite. Se ela consultasse o banco a cada checagem, uma resposta lenta do
// banco estourava o limite, a máquina era considerada "doente", reiniciava,
// estourava de novo... e o site ficava fora do ar em loop ("Request failed").
// Por isso /api/health responde na hora, sem consultar nada externo.
const dbHealth = { status: "verificando", at: 0 };

async function probeDb() {
  try {
    const res = await withTimeout(callAgent({ acao: "probe" }), 8000, "Banco");
    if (!res) dbHealth.status = "offline";
    else dbHealth.status = res.ok ? "ok" : "erro: " + (res.erro || "sem resposta");
  } catch (e) {
    dbHealth.status = "offline";
  }
  dbHealth.at = Date.now();
  return dbHealth.status;
}

function healthPayload() {
  return {
    ok: true,
    version: SERVER_VERSION,
    platform: PLATFORM,
    status: runtime.status,
    uptime: Math.round(process.uptime()),
    registered: isRegistered() || credsExist(),
    volume_ok: credsExist(),
    auth_dir: AUTH_DIR,
    auth_persistente: AUTH_PERSISTENT,
    db: dbHealth.status,
    db_key: "agente",
    db_checked_at: dbHealth.at || null,
    last_cobranca: readState().lastCobrancaDate || null,
    today: todayBRT(),
  };
}

// Endpoint de monitoramento: responde SEMPRE na hora (é o que a hospedagem usa).
app.get("/api/health", (req, res) => {
  res.json(healthPayload());
});

// Diagnóstico profundo: consulta o banco de verdade. Usado pelo painel.
app.get("/api/health/deep", async (req, res) => {
  await probeDb();
  res.json(healthPayload());
});

app.get("/api/status", (req, res) => {
  res.json(statusPayload());
});

// Diagnóstico da configuração: diz em português o que está faltando.
// Não expõe nenhum valor de chave, só informa se cada uma está presente.
app.get("/api/diagnostico", (req, res) => {
  const avisos = [];
  if (!AUTH_PERSISTENT) {
    avisos.push(
      "A pasta da sessão não está em um disco persistente (" + AUTH_DIR + "). O WhatsApp vai pedir QR Code de novo a cada reinício. Crie um disco e monte em /var/data (no Render isso já vem no render.yaml)."
    );
  }
  res.json({
    ok: avisos.length === 0,
    versao: SERVER_VERSION,
    plataforma: PLATFORM,
    url_publica: PUBLIC_URL || "(não detectada)",
    pasta_da_sessao: AUTH_DIR,
    pasta_origem: AUTH_DETECT.origem,
    pasta_persistente: AUTH_PERSISTENT,
    sessao_salva: credsExist(),
    permissoes_banco: permissoesBanco(),
    chaves_com_padrao: {
      WPP_API_KEY: !process.env.WPP_API_KEY,
      WPP_AGENT_SECRET: !process.env.WPP_AGENT_SECRET,
      SUPABASE_URL: !process.env.SUPABASE_URL,
    },
    avisos: avisos,
  });
});

app.post("/api/connect", checkAuth, async (req, res) => {
  runtime.attempts = 0;
  runtime.manualStop = false;
  await connect();
  res.json({ success: true, message: "Iniciando conexão..." });
});

app.post("/api/disconnect", checkAuth, async (req, res) => {
  await disconnect();
  res.json({ success: true, message: "WhatsApp desconectado" });
});

// Realinha as chaves de conversa SEM apagar a sessão (não pede QR Code).
// É o botão que resolve o balão "Aguardando mensagem" no celular do cliente.
app.post("/api/realinhar", checkAuth, async (req, res) => {
  const resultado = await realinharCriptografia();
  if (!resultado.ok) {
    return res.status(400).json({ success: false, error: resultado.erro });
  }
  res.json({
    success: true,
    sessoes_renovadas: resultado.sessoes,
    message:
      "Chaves de conversa renovadas. Nenhum QR Code é necessário e a conexão continua a mesma.",
  });
});

app.post("/api/reset", checkAuth, async (req, res) => {
  const limpo = clearAuthDir();
  await resetSession();
  res.json({
    success: true,
    message: limpo
      ? "Sessão apagada. Escaneie o novo QR Code."
      : "Sessão não pôde ser apagada do disco. Tente novamente.",
  });
});

app.post("/api/send", checkAuth, async (req, res) => {
  const body = req.body || {};
  if (!body.whatsapp) return res.status(400).json({ success: false, error: "whatsapp é obrigatório" });
  if (runtime.status !== "connected" || !runtime.sock) {
    return res.status(400).json({ success: false, error: "WhatsApp não conectado" });
  }

  const phone = normalizeNumber(body.whatsapp);
  const nome = body.nome || "Cliente";
  const mensagem = body.mensagem || buildMessage(nome, body.valor, body.vencimento, body.link);

  const resultado = await sendToPhone(phone, mensagem);
  await saveMessageRecord({
    client_id: body.client_id,
    parcela_id: body.parcela_id,
    cliente_nome: nome,
    whatsapp: phone,
    mensagem: mensagem,
    status: resultado.ok ? "enviado" : "falhou",
    erro: resultado.error,
    tipo: "manual",
  });

  if (!resultado.ok) return res.status(400).json({ success: false, error: resultado.error });
  res.json({ success: true, message: "Enviado!" });
});

app.post("/api/send-bulk", checkAuth, async (req, res) => {
  const clientes = (req.body && req.body.clientes) || [];
  if (!Array.isArray(clientes) || clientes.length === 0) {
    return res.status(400).json({ success: false, error: "Lista vazia" });
  }
  if (runtime.status !== "connected" || !runtime.sock) {
    return res.status(400).json({ success: false, error: "WhatsApp não conectado" });
  }

  let enviados = 0;
  let falhas = 0;
  for (const c of clientes) {
    const phone = normalizeNumber(c.whatsapp);
    const nome = c.nome || "Cliente";
    const mensagem = c.mensagem || buildMessage(nome, c.valor, c.vencimento, c.link);
    const resultado = await sendToPhone(phone, mensagem);
    await saveMessageRecord({
      client_id: c.client_id,
      parcela_id: c.parcela_id,
      cliente_nome: nome,
      whatsapp: phone,
      mensagem: mensagem,
      status: resultado.ok ? "enviado" : "falhou",
      erro: resultado.error,
      tipo: "manual",
    });
    if (resultado.ok) enviados += 1;
    else falhas += 1;
    await new Promise((r) => setTimeout(r, 2000));
  }

  res.json({ success: true, total: clientes.length, enviados: enviados, falhas: falhas });
});

app.post("/api/sweep-confirmacoes", checkAuth, async (req, res) => {
  if (runtime.status !== "connected" || !runtime.sock) {
    return res.status(400).json({ success: false, error: "WhatsApp não conectado" });
  }
  await sendPaymentConfirmations();
  res.json({ success: true, message: "Verificação executada." });
});

// Envia uma mensagem de teste (usado pelo painel para validar a conexão).
app.post("/api/test", checkAuth, async (req, res) => {
  const phone = normalizeNumber((req.body && req.body.whatsapp) || "");
  if (!phone) return res.status(400).json({ success: false, error: "Informe um número com DDD" });
  if (runtime.status !== "connected" || !runtime.sock) {
    return res.status(400).json({ success: false, error: "WhatsApp não conectado" });
  }
  const texto =
    "✅ Teste do painel Kairós: seu WhatsApp está conectado e enviando mensagens corretamente.";
  const resultado = await sendToPhone(phone, texto);
  if (!resultado.ok) return res.status(400).json({ success: false, error: resultado.error });
  res.json({ success: true, message: "Mensagem de teste enviada!" });
});

// ───────────────────────────── Tarefas periódicas ─────────────────────────────
// Cobrança automática diária: 11:00 no horário de Brasília.
cron.schedule(
  "0 " + HORA_COBRANCA + " * * *",
  () => {
    runDailyCobranca("agendamento").catch(() => {});
  },
  { timezone: "America/Sao_Paulo" }
);

setInterval(sendPendingHumanMessages, 5000);
setInterval(sendPaymentConfirmations, 8000);
// Mantém o diagnóstico de banco atualizado (o /api/health só devolve o cache).
setInterval(() => {
  probeDb().catch(() => {});
}, 60000);

// Rede de segurança: de hora em hora confere se a cobrança do dia saiu.
// Cobre o caso de o serviço estar reiniciando exatamente no horário marcado.
setInterval(() => {
  const agora = minutesNowBRT();
  if (agora >= HORA_COBRANCA * 60) {
    runDailyCobranca("verificacao_horaria").catch(() => {});
  }
}, 60 * 60 * 1000);

// Mantém o serviço acordado. Em hospedagens "always-on" isso é dispensável,
// mas não custa nada e protege contra planos que hibernam por inatividade.
if (PUBLIC_URL) {
  setInterval(() => {
    fetch(PUBLIC_URL.replace(/\/+$/, "") + "/api/health").catch(() => {
      /* ignora */
    });
  }, 2 * 60 * 1000);
  log("Keep-alive ativo:", PUBLIC_URL);
} else {
  log("Keep-alive inativo (sem URL pública detectada). Defina WPP_PUBLIC_URL se precisar.");
}

// Desligamento limpo: salva a sessão antes de morrer. Sem isso, um deploy
// poderia corromper o arquivo de credenciais e derrubar a conexão.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("Recebido " + signal + ". Encerrando com segurança...");
  runtime.manualStop = true;
  try {
    if (runtime.sock) runtime.sock.end(undefined);
  } catch (e) {
    /* ignora */
  }
  writeState({ lastShutdown: new Date().toISOString(), lastShutdownSignal: signal });
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Rede de segurança: escuta também nas portas alternativas (8080/3001).
// Assim a checagem de saúde da hospedagem acerta a porta em qualquer cenário.
FALLBACK_PORTS.forEach((porta) => {
  try {
    const extra = app.listen(porta, "0.0.0.0", () => {
      log("Escutando também na porta " + porta + " (compatibilidade)");
    });
    extra.on("error", (err) => {
      log("Porta " + porta + " indisponível: " + err.message);
    });
  } catch (e) {
    /* ignora */
  }
});

app.listen(PORT, "0.0.0.0", () => {
  log("Servidor Kairós WPP v" + SERVER_VERSION + " na porta " + PORT);
  log("Plataforma:", PLATFORM);
  log("Pasta da sessão:", AUTH_DIR, "(" + AUTH_DETECT.origem + ")");
  log("Disco persistente:", AUTH_PERSISTENT ? "SIM" : "NÃO — a sessão será perdida a cada reinício!");
  log("Credenciais salvas:", credsExist() ? "sim" : "não (vai precisar de QR Code)");
  log("Banco: via função wpp-agente (permissão completa, sem chave secreta no servidor)");

  // Primeira checagem do banco em segundo plano (não trava a subida).
  probeDb().catch(() => {});

  // Só reconecta sozinho se já existe sessão salva. Sem sessão, o QR só é
  // gerado quando o administrador clica em "Conectar WhatsApp".
  if (credsExist()) {
    // v5.4.0 — primeira subida desta versão: renova as chaves de conversa uma
    // única vez. É isso que destrava o balão "Aguardando mensagem" que já
    // ficou preso nos celulares dos clientes com a sessão antiga.
    const estadoAtual = readState();
    if (estadoAtual.realinhamento !== REALIGN_MARK) {
      const removidos = limparSessoesDeConversa();
      writeState({
        realinhamento: REALIGN_MARK,
        lastRealinhamentoAt: new Date().toISOString(),
        lastRealinhamentoQtd: removidos,
      });
      log("Chaves de conversa renovadas automaticamente (" + removidos + " arquivos).");
    }
    runtime.manualStop = false;
    connect();
  }

  // Se o serviço estava fora do ar no horário da cobrança, recupera agora.
  setTimeout(() => {
    const agora = minutesNowBRT();
    if (agora >= HORA_COBRANCA * 60) {
      runDailyCobranca("inicializacao").catch(() => {});
    } else {
      log("[COBRANCA] Hoje ainda não passou do horário. Aguardando " + HORA_COBRANCA + ":00.");
    }
  }, 20000);
});