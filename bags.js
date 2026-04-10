import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';

// ─── Config ──────────────────────────────────────
const CONFIG_PATH = 'bags_config.json';
const BAGS_FEE_V2 = 'FEE2tBhCKAt7shrod19QttSVREUYPiyMzoku1mL1gqVK';
const BAGS_FEE_V1 = 'FEEhPbKVKnco9EXnaY3i4R5rQVUx91wgVfu8qokixywi';

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
function checkBagsClaim(tx) {
  const keys = tx?.transaction?.message?.accountKeys;
  if (!keys) return null;

  const hasBags = keys.some(k => {
    const pubkey = typeof k === 'string' ? k : k?.pubkey;
    return pubkey === BAGS_FEE_V2 || pubkey === BAGS_FEE_V1;
  });

  if (!hasBags) return null;

  // Find claim instructions
  let claimType = '';
  const instrs = tx?.transaction?.message?.instructions || [];
  for (const instr of instrs) {
    const pid = instr.programId || '';
    if (pid === BAGS_FEE_V2 || pid === BAGS_FEE_V1) {
      const name = instr?.parsed?.type || '';
      if (name.includes('claim')) {
        claimType += (claimType ? ' + ' : '') + name;
      } else if (!claimType && instr.data) {
        claimType = `bags_instruction (${instr.data.slice(0, 12)}...)`;
      }
    }
  }
  if (!claimType) claimType = 'bags_fee_interaction';

  // Token changes
  const tokenChanges = [];
  const detailParts = [];
  const preTok = tx?.meta?.preTokenBalances || [];
  const postTok = tx?.meta?.postTokenBalances || [];

  for (const post of postTok) {
    const mint = post.mint || '';
    const postAmt = post?.uiTokenAmount?.uiAmount || 0;
    const pre = preTok.find(p => p.accountIndex === post.accountIndex);
    const preAmt = pre?.uiTokenAmount?.uiAmount || 0;
    const diff = postAmt - preAmt;
    if (Math.abs(diff) > 0.0000001) {
      tokenChanges.push({ mint, change: diff, from: preAmt, to: postAmt });
      detailParts.push(`${mint.slice(0, 4)}...${mint.slice(-4)}: ${diff > 0 ? '+' : ''}${diff.toFixed(6)}`);
    }
  }

  // SOL change
  let solAmount = null;
  const preBal = tx?.meta?.preBalances;
  const postBal = tx?.meta?.postBalances;
  if (preBal?.length && postBal?.length) {
    const diff = (postBal[0] - preBal[0]) / 1e9;
    if (Math.abs(diff) > 0.000001) {
      solAmount = diff;
      detailParts.push(`SOL: ${diff > 0 ? '+' : ''}${diff.toFixed(6)}`);
    }
  }

  return {
    instruction: claimType,
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
      footer: { text: 'Bags Fee Monitor' },
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
            const claim = checkBagsClaim(tx);

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
