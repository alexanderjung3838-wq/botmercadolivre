require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DE SEGURANÇA ---
const ADMIN_LOGIN = 'botpro';
const ADMIN_SENHA = 'aj065630'; 

// Middleware de Autenticação para o Painel
const protegerPainel = (req, res, next) => {
  const auth = { login: ADMIN_LOGIN, password: ADMIN_SENHA };
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
  if (login && password && login === auth.login && password === auth.password) return next();
  res.set('WWW-Authenticate', 'Basic realm="401"');
  res.status(401).send('Acesso negado: Senha incorreta.');
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- CONEXÃO MONGODB ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Conectado ao MongoDB'))
  .catch((err) => console.error('❌ Erro MongoDB:', err));

// --- SCHEMAS ---
const TokenSchema = new mongoose.Schema({
  access_token: String,
  refresh_token: String,
  expires_in: Number,
  updated_at: { type: Date, default: Date.now }
});
const Token = mongoose.model('Token', TokenSchema);

const Produto = mongoose.model('Produto', new mongoose.Schema({
  nome: String, id_anuncio: String, mensagem: String
}));

// NOVO: Schema para lembrar das vendas já processadas
const VendaProcessada = mongoose.model('VendaProcessada', new mongoose.Schema({
  id_venda: { type: String, unique: true },
  data_processamento: { type: Date, default: Date.now }
}));

// --- FUNÇÃO DE RENOVAÇÃO DE TOKEN ---
async function getValidToken() {
  const tokenData = await Token.findOne();
  if (!tokenData) return null;

  const agora = new Date();
  const dataExpiracao = new Date(tokenData.updated_at.getTime() + (tokenData.expires_in * 1000));
  
  if (agora < dataExpiracao - 5 * 60000) {
    return tokenData.access_token;
  }

  console.log('🔄 Token vencido! Renovando...');
  try {
    const response = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type: 'refresh_token',
      client_id: process.env.ML_APP_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      refresh_token: tokenData.refresh_token
    });

    tokenData.access_token = response.data.access_token;
    tokenData.refresh_token = response.data.refresh_token; 
    tokenData.expires_in = response.data.expires_in;
    tokenData.updated_at = new Date();
    await tokenData.save();
    return tokenData.access_token;
  } catch (error) {
    console.error('❌ Erro ao renovar token:', error.message);
    return null;
  }
}

// --- ROTAS PÚBLICAS ---
app.get('/auth', (req, res) => {
  res.redirect(`https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${process.env.ML_APP_ID}&redirect_uri=${process.env.ML_REDIRECT_URI}`);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const r = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type: 'authorization_code', client_id: process.env.ML_APP_ID, client_secret: process.env.ML_CLIENT_SECRET, code, redirect_uri: process.env.ML_REDIRECT_URI,
    });
    await Token.findOneAndUpdate({}, { ...r.data, updated_at: new Date() }, { upsert: true });
    res.send('<h1>Login realizado! Tokens salvos.</h1>');
  } catch (e) { res.status(500).send('Erro ao autenticar.'); }
});

app.post('/notifications', async (req, res) => {
  res.status(200).send('OK'); // Responde rápido
  const { resource, topic, user_id } = req.body;
  
  if (topic === 'orders_v2' || topic === 'orders') {
    // Extrai apenas o número do ID da venda (ex: /orders/12345 -> 12345)
    const idVenda = resource.split('/').pop();

    // 1. VERIFICAÇÃO DE MEMÓRIA (Anti-Duplicidade)
    const jaProcessada = await VendaProcessada.findOne({ id_venda: idVenda });
    if (jaProcessada) {
      console.log(`✋ Venda ${idVenda} já foi atendida. Ignorando.`);
      return;
    }

    try {
      const accessToken = await getValidToken();
      if (!accessToken) return;

      const venda = (await axios.get(`https://api.mercadolibre.com${resource}`, { headers: { Authorization: `Bearer ${accessToken}` } })).data;
      const itemID = venda.order_items[0].item.id;
      
      const produto = await Produto.findOne({ id_anuncio: itemID });
      
      if (produto) {
        console.log(`🔔 Venda nova: ${produto.nome}. Enviando mensagem...`);
        
        await axios.post(`https://api.mercadolibre.com/messages/packs/${venda.pack_id || venda.id}/sellers/${user_id}?tag=post_sale`, 
          { from: { user_id }, to: { user_id: venda.buyer.id }, text: produto.mensagem }, 
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        // 2. MARCA COMO PROCESSADA NO BANCO
        await VendaProcessada.create({ id_venda: idVenda });
        console.log(`✅ Mensagem enviada e venda registrada para não repetir!`);
      }
    } catch (e) { 
      // Se der erro de "Mensagem já enviada", a gente marca como processada também pra parar de tentar
      if (e.response && e.response.status === 400) {
          await VendaProcessada.create({ id_venda: idVenda });
      }
      console.error('❌ Erro processando venda:', e.message); 
    }
  }
});

// --- ROTAS DO PAINEL ---
app.use(protegerPainel);
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/produtos', async (req, res) => res.json(await Produto.find()));
app.post('/api/produtos', async (req, res) => {
  const { nome, id_anuncio, mensagem } = req.body;
  let p = await Produto.findOne({ id_anuncio });
  if (p) { p.nome = nome; p.mensagem = mensagem; await p.save(); } 
  else { await Produto.create({ nome, id_anuncio, mensagem }); }
  res.json({ ok: true });
});
app.delete('/api/produtos/:id', async (req, res) => { await Produto.findByIdAndDelete(req.params.id); res.json({ ok: true }); });

app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));