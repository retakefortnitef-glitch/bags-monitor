import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';

// ─── Config ──────────────────────────────────────
const CONFIG_PATH = 'bags_config.json';
const BAGS_FEE_V2 = 'FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK';
const BAGS_FEE_V1 = 'FEEhPbKVKnco9EXnaY3i4R5rQVUx91wgVfu8qokixywi';
const MONITOR_VERSION = 'v1.1.0';
const TG_TOKEN = process.env.TG_TOKEN || '8732092516:AAG-C3CneofOGTwgJeBNyH6nzoECkZ7kN7A';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '-5171513471';

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return { wallets: [], discordWebhookUrl: '', rpcUrl: 'https://api.mainnet-beta.solana.com', pollIntervalSecs: 1 };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();

// ─── State ───────────────────────────────────────
let running = true;
let claimCount = 0;
let txChecked = 0;
const seenSigs = new Map(); // wallet -> Set
const claims = [];
const wsClients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    try { ws.send(data); } catch {}
  }
}

function log(msg, type = 'info') {
  const time = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
  broadcast({ type: 'log', time, msg, logType: type });
}

function emitStats() {
  broadcast({
    type: 'stats',
    claims: claimCount,
    txChecked,
    running,
    walletCount: config.wallets.length,
  });
}

function getPubkey(key) {
  return typeof key === 'string' ? key : key?.pubkey || '';
}

function collectBagsInstructionNames(tx) {
  const names = [];
  const outer = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap(group => group?.instructions || []);

  for (const instr of [...outer, ...inner]) {
    const pid = instr?.programId || '';
    if (pid !== BAGS_FEE_V2 && pid !== BAGS_FEE_V1) continue;

    const parsedType = String(instr?.parsed?.type || '').trim();
    if (parsedType) {
      names.push(parsedType);
    } else if (instr?.data) {
      names.push(`bags_instruction (${instr.data.slice(0, 12)}...)`);
    }
  }

  return names;
}

function collectBagsClaimLogs(tx) {
  const logs = tx?.meta?.logMessages || [];
  const claimLogs = [];

  for (const logLine of logs) {
    if (typeof logLine !== 'string') continue;
    if (!logLine.toLowerCase().includes('claim')) continue;
    if (!logLine.includes(BAGS_FEE_V1) && !logLine.includes(BAGS_FEE_V2) && !logLine.includes('Program log: Instruction:')) continue;
    claimLogs.push(logLine);
  }

  return claimLogs;
}

function formatClaimInstruction(claimInstructions, claimLogs) {
  const rawNames = claimInstructions.length
    ? claimInstructions
    : claimLogs
        .map(logLine => {
          const match = logLine.match(/Instruction:\s*([A-Za-z0-9_]+)/);
          return match ? match[1] : null;
        })
        .filter(Boolean);

  if (!rawNames.length) return 'Fees: Claim';
  if (rawNames.some(name => name.toLowerCase().includes('claim'))) return 'Fees: Claim';
  return rawNames.join(' + ');
}

function getWalletSolChange(tx, walletAddress) {
  const accountKeys = tx?.transaction?.message?.accountKeys || [];
  const walletIndex = accountKeys.findIndex(key => getPubkey(key) === walletAddress);
  if (walletIndex === -1) return null;

  const preBal = tx?.meta?.preBalances || [];
  const postBal = tx?.meta?.postBalances || [];
  if (preBal[walletIndex] == null || postBal[walletIndex] == null) return null;

  const diff = (postBal[walletIndex] - preBal[walletIndex]) / 1e9;
  return Math.abs(diff) > 0.000001 ? diff : null;
}

function getWalletTokenChanges(tx, walletAddress) {
  const preTok = tx?.meta?.preTokenBalances || [];
  const postTok = tx?.meta?.postTokenBalances || [];
  const changes = [];

  const touchedAccounts = new Set([
    ...preTok.filter(balance => balance?.owner === walletAddress).map(balance => balance.accountIndex),
    ...postTok.filter(balance => balance?.owner === walletAddress).map(balance => balance.accountIndex),
  ]);

  for (const accountIndex of touchedAccounts) {
    const pre = preTok.find(balance => balance.accountIndex === accountIndex);
    const post = postTok.find(balance => balance.accountIndex === accountIndex);
    const mint = post?.mint || pre?.mint || '';
    const preAmt = pre?.uiTokenAmount?.uiAmount || 0;
    const postAmt = post?.uiTokenAmount?.uiAmount || 0;
    const diff = postAmt - preAmt;

    if (Math.abs(diff) > 0.0000001) {
      changes.push({ mint, change: diff, from: preAmt, to: postAmt });
    }
  }

  return changes;
}

// ─── Solana RPC ──────────────────────────────────
async function rpcCall(method, params) {
  const resp = await fetch(config.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await resp.json();
  if (body.error) throw new Error(`RPC: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function fetchSignatures(address, limit = 20) {
  return await rpcCall('getSignaturesForAddress', [address, { limit }]);
}

async function fetchTransaction(sig) {
  return await rpcCall('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
}

// ─── Claim Detection ─────────────────────────────
function checkBagsClaim(tx, walletAddress) {
  const keys = tx?.transaction?.message?.accountKeys;
  if (!keys || !walletAddress) return null;

  const hasBags = keys.some(k => {
    const pubkey = getPubkey(k);
    return pubkey === BAGS_FEE_V2 || pubkey === BAGS_FEE_V1;
  });

  if (!hasBags) return null;

  const instructionNames = collectBagsInstructionNames(tx);
  const claimInstructions = instructionNames.filter(name => name.toLowerCase().includes('claim'));
  const claimLogs = collectBagsClaimLogs(tx);
  const tokenChanges = getWalletTokenChanges(tx, walletAddress);
  const detailParts = [];
  for (const change of tokenChanges) {
    const mint = change.mint || '';
    detailParts.push(`${mint.slice(0, 4)}...${mint.slice(-4)}: ${change.change > 0 ? '+' : ''}${change.change.toFixed(6)}`);
  }

  const solAmount = getWalletSolChange(tx, walletAddress);
  if (solAmount != null) {
    detailParts.push(`SOL: ${solAmount > 0 ? '+' : ''}${solAmount.toFixed(6)}`);
  }

  const hasExplicitClaim = claimInstructions.length > 0 || claimLogs.length > 0;
  if (!hasExplicitClaim) return null;
  const instructionLabel = formatClaimInstruction(claimInstructions, claimLogs);

  return {
    instruction: instructionLabel || 'claim_detected_from_logs',
    details: detailParts.length ? detailParts.join(' | ') : 'Claim de fees detectado',
    solAmount,
    tokenChanges,
  };
}

// ─── Discord ─────────────────────────────────────
async function sendDiscordAlert(wallet, signature, claim) {
  if (!config.discordWebhookUrl) return;

  const solscanUrl = `https://solscan.io/tx/${signature}`;
  const walletUrl = `https://solscan.io/account/${wallet.address}`;
  const solField = claim.solAmount != null ? `${claim.solAmount.toFixed(6)} SOL` : 'Ver na tx';
  const axiomField = wallet.coinMint
    ? `[${wallet.coinMint}](https://axiom.trade/meme/${wallet.coinMint}?chain=sol)`
    : 'N/A';

  const embed = {
    embeds: [{
      title: 'BAGS FEE CLAIM DETECTADO',
      color: 0x00FF88,
      fields: [
        { name: 'Wallet', value: `[${wallet.label}](${walletUrl})\n\`${wallet.address}\``, inline: false },
        { name: 'Instrucao', value: claim.instruction, inline: true },
        { name: 'Valor', value: solField, inline: true },
        { name: 'Detalhes', value: claim.details, inline: false },
        { name: 'Moeda (Axiom)', value: axiomField, inline: false },
        { name: 'Transacao', value: `[Ver no Solscan](${solscanUrl})`, inline: false },
      ],
      footer: { text: `Bags Fee Monitor ${MONITOR_VERSION}` },
      timestamp: new Date().toISOString(),
    }],
  };

  try {
    await fetch(config.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(embed),
    });
    log('Alerta enviado no Discord!', 'ok');
  } catch (e) {
    log(`Erro Discord: ${e.message}`, 'err');
  }

  // Telegram
  const axiomLink = wallet.coinMint
    ? `https://axiom.trade/meme/${wallet.coinMint}?chain=sol`
    : '';
  const tgMsg = `🚨 <b>BAGS FEE CLAIM DETECTADO</b>\n\n`
    + `<b>Label:</b> ${wallet.label}\n`
    + `<b>Instrucao:</b> ${claim.instruction}\n`
    + `<b>Valor:</b> ${solField}\n`
    + `<b>Detalhes:</b> ${claim.details}\n`
    + (axiomLink ? `<b>Moeda:</b> <a href="${axiomLink}">Axiom</a>\n` : '')
    + `<b>Tx:</b> <a href="${solscanUrl}">Solscan</a>\n`
    + `<b>Wallet:</b> <a href="${walletUrl}">Ver</a>`;
  await sendTelegram(`<b>[${MONITOR_VERSION}]</b>\n${tgMsg}`);
}

async function sendTelegram(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch {}
}

async function sendWalletAddedAlert(wallet) {
  if (!config.discordWebhookUrl) return;

  const walletUrl = `https://solscan.io/account/${wallet.address}`;
  const axiomField = wallet.coinMint
    ? `[${wallet.coinMint}](https://axiom.trade/meme/${wallet.coinMint}?chain=sol)`
    : 'N/A';

  const embed = {
    embeds: [{
      title: 'NOVA COIN ADICIONADA',
      color: 0x3B82F6,
      fields: [
        { name: 'Label', value: wallet.label || 'Sem nome', inline: true },
        { name: 'Wallet', value: `[Ver no Solscan](${walletUrl})\n\`${wallet.address}\``, inline: false },
        { name: 'Moeda (Axiom)', value: axiomField, inline: false },
      ],
      footer: { text: `Bags Fee Monitor ${MONITOR_VERSION}` },
      timestamp: new Date().toISOString(),
    }],
  };

  try {
    await fetch(config.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(embed),
    });
  } catch {}

  // Telegram
  const axiomLink = wallet.coinMint
    ? `https://axiom.trade/meme/${wallet.coinMint}?chain=sol`
    : '';
  const tgMsg = `📌 <b>NOVA COIN ADICIONADA</b>\n\n`
    + `<b>Label:</b> ${wallet.label || 'Sem nome'}\n`
    + `<b>Wallet:</b> <a href="${walletUrl}">${wallet.address.slice(0, 8)}...</a>\n`
    + (axiomLink ? `<b>Moeda:</b> <a href="${axiomLink}">Axiom</a>\n` : '');
  await sendTelegram(`<b>[${MONITOR_VERSION}]</b>\n${tgMsg}`);
}

// ─── Monitor Loop ────────────────────────────────
async function monitorLoop() {
  // Baseline
  for (const wallet of config.wallets) {
    log(`Carregando baseline: ${wallet.label} (${wallet.address.slice(0, 8)}...)`, 'info');
    try {
      const sigs = await fetchSignatures(wallet.address, 20);
      seenSigs.set(wallet.address, new Set(sigs.map(s => s.signature)));
      log(`${wallet.label}: ${sigs.length} txs no baseline`, 'info');
    } catch (e) {
      log(`Erro baseline ${wallet.label}: ${e.message}`, 'err');
      seenSigs.set(wallet.address, new Set());
    }
  }

  log('Monitorando wallets...', 'ok');
  emitStats();

  while (true) {
    if (!running) {
      await sleep(2000);
      continue;
    }

    config = loadConfig(); // reload config for new wallets

    for (const wallet of config.wallets) {
      if (!seenSigs.has(wallet.address)) {
        try {
          const sigs = await fetchSignatures(wallet.address, 20);
          seenSigs.set(wallet.address, new Set(sigs.map(s => s.signature)));
          log(`Nova wallet adicionada ao monitor: ${wallet.label}`, 'ok');
        } catch {
          seenSigs.set(wallet.address, new Set());
        }
        continue;
      }

      try {
        const sigs = await fetchSignatures(wallet.address, 15);
        const seen = seenSigs.get(wallet.address);

        for (const sigInfo of sigs) {
          if (seen.has(sigInfo.signature)) continue;
          if (sigInfo.err) { seen.add(sigInfo.signature); continue; }

          txChecked++;

          try {
            const tx = await fetchTransaction(sigInfo.signature);
            const claim = checkBagsClaim(tx, wallet.address);

            if (claim) {
              claimCount++;
              log(`CLAIM DETECTADO! [${wallet.label}] ${claim.instruction} | ${claim.details}`, 'ok');

              const claimData = {
                type: 'claim',
                wallet: wallet.address,
                label: wallet.label,
                coinMint: wallet.coinMint,
                signature: sigInfo.signature,
                instruction: claim.instruction,
                details: claim.details,
                solAmount: claim.solAmount,
                tokenChanges: claim.tokenChanges,
                timestamp: new Date().toISOString(),
              };
              claims.unshift(claimData);
              if (claims.length > 50) claims.pop();
              broadcast(claimData);

              await sendDiscordAlert(wallet, sigInfo.signature, claim);
            }
          } catch (e) {
            log(`Erro tx ${sigInfo.signature.slice(0, 16)}: ${e.message}`, 'warn');
          }

          seen.add(sigInfo.signature);
        }

        // Prevent memory bloat
        if (seen.size > 1000) {
          seen.clear();
          sigs.forEach(s => seen.add(s.signature));
        }
      } catch (e) {
        log(`[${wallet.label}] Erro RPC: ${e.message}`, 'warn');
      }
    }

    emitStats();
    await sleep((config.pollIntervalSecs || 1) * 1000);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HTTP Server ─────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // API routes
  if (url.pathname === '/api/status' && req.method === 'GET') {
    json(res, { running, claims: claimCount, txChecked, walletCount: config.wallets.length });
  } else if (url.pathname === '/api/config' && req.method === 'GET') {
    json(res, {
      rpcUrl: config.rpcUrl ? 'configured' : '',
      discordWebhookUrl: config.discordWebhookUrl ? 'configured' : '',
      pollIntervalSecs: config.pollIntervalSecs || 1,
    });
  } else if (url.pathname === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.rpcUrl && body.rpcUrl !== 'configured') config.rpcUrl = body.rpcUrl;
    if (body.discordWebhookUrl && body.discordWebhookUrl !== 'configured') config.discordWebhookUrl = body.discordWebhookUrl;
    if (body.pollIntervalSecs > 0) config.pollIntervalSecs = body.pollIntervalSecs;
    saveConfig(config);
    log('Config atualizado!', 'ok');
    json(res, { ok: true });
  } else if (url.pathname === '/api/wallets' && req.method === 'GET') {
    json(res, { wallets: config.wallets });
  } else if (url.pathname === '/api/wallets' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.address) { json(res, { ok: false, error: 'address required' }); return; }
    if (config.wallets.some(w => w.address === body.address)) { json(res, { ok: false, error: 'wallet already exists' }); return; }
    config.wallets.push({
      address: body.address,
      coinMint: body.coinMint || '',
      label: body.label || `Wallet ${config.wallets.length + 1}`,
    });
    saveConfig(config);
    log(`Wallet adicionada: ${body.label || body.address.slice(0, 8)}`, 'ok');
    emitStats();
    await sendWalletAddedAlert(config.wallets[config.wallets.length - 1]);
    json(res, { ok: true });
  } else if (url.pathname === '/api/wallets/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const before = config.wallets.length;
    config.wallets = config.wallets.filter(w => w.address !== body.address);
    const removed = config.wallets.length < before;
    saveConfig(config);
    if (removed) { log('Wallet removida', 'info'); emitStats(); }
    json(res, { ok: true, removed });
  } else if (url.pathname === '/api/start' && req.method === 'POST') {
    running = true; log('Monitor iniciado!', 'ok'); emitStats();
    json(res, { ok: true });
  } else if (url.pathname === '/api/stop' && req.method === 'POST') {
    running = false; log('Monitor pausado.', 'warn'); emitStats();
    json(res, { ok: true });
  } else {
    // Serve static files
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = path.join('public', 'bags', filePath);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const ext = path.extname(filePath);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
      res.end(content);
    } catch {
      // Fallback to index.html
      try {
        const content = fs.readFileSync(path.join('public', 'bags', 'index.html'), 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    }
  }
});

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } });
  });
}

// ─── WebSocket ───────────────────────────────────
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  wsClients.add(ws);
  emitStats();
  ws.on('close', () => wsClients.delete(ws));
});

// ─── Start ───────────────────────────────────────
const PORT = process.env.PORT || process.env.BAGS_PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n=== Bags Fee Claim Monitor ===`);
  console.log(`Dashboard: http://localhost:${PORT}\n`);
  log('Monitor iniciado!', 'ok');
  monitorLoop();
});
