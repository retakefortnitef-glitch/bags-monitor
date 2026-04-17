# Deploy

## Windows

1. Instale Node.js 18+.
2. Rode `npm install`.
3. Ajuste `bags_config.json` com sua `rpcUrl`, webhook e wallets.
4. Se quiser sobrescrever o Telegram sem editar o codigo:
   - defina `TG_TOKEN`
   - defina `TG_CHAT_ID`
5. Inicie com `server.bat` ou `npm start`.

Servidor padrao:

- Dashboard: `http://localhost:3001`
- Porta: `PORT` ou `BAGS_PORT`

## Linux

```bash
npm install
export PORT=3001
export TG_TOKEN='seu_token'
export TG_CHAT_ID='seu_chat_id'
node bags.js
```
