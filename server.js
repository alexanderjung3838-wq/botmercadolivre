require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURAÇÃO DE SEGURANÇA (SENHA DO PAINEL) ---
const ADMIN_LOGIN = 'BotPro';      // <--- Mude seu usuário aqui
const ADMIN_SENHA = 'aj065630';     // <--- Mude sua senha aqui

// Middleware para verificar senha
const protegerPainel = (req, res, next) => {
  const auth = { login: ADMIN_LOGIN, password: ADMIN_SENHA };
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

  if (login && password && login === auth.login && password === auth.password) {
    return next();
  }
  
  // Se a senha estiver errada, pede de novo
  res.set('WWW-Authenticate', 'Basic realm="401"');
  res.status(401).send('Acesso negado: Você precisa da senha do administrador.');
};

// Configurações básicas
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 1. CONEXÃO COM O BANCO ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Conectado ao MongoDB'))
  .catch((err) => console.error('❌ Erro no MongoDB:', err));

// --- 2. SCHEMAS ---
const TokenSchema = new mongoose.Schema({
  access_token: String,
  refresh_token: String,
  expires_in: Number,
  updated_at: { type: Date, default: Date.now }
});
const Token = mongoose.model('Token', TokenSchema);

const ProdutoSchema = new mongoose.Schema({
  nome: String,
  id_anuncio: String,
  mensagem: String,
  link_download: String,
  ativo: { type: Boolean, default: true }
});
const Produto = mongoose.model('Produto', ProdutoSchema);

// --- 3. ROTAS PÚBLICAS (O Mercado Livre acessa aqui sem senha) ---

// Login do ML
app.get('/auth', (req, res) => {
  const authUrl = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${process.env.ML_APP_ID}&redirect_uri=${process.env.ML_REDIRECT_URI}`;
  res.redirect(authUrl);
});

// Callback do ML
app.get('/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const response = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type: 'authorization_code',
      client_id: process.env.ML_APP_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      code: code,
      redirect_uri: process.env.ML_REDIRECT_URI,
    });
    await Token.findOneAndUpdate({}, response.data, { upsert: true, new: true });
    res.send('<h1>Login realizado! Pode fechar.</h1>');
  } catch (error) {
    res.status(500).send('Erro ao autenticar.');
  }
});

// Notificações de Venda (O Gatilho)
app.post('/notifications', async (req, res) => {
  res.status(200).send('OK');
  const { resource, topic, user_id } = req.body;
  
  if (topic === 'orders_v2' || topic === 'orders') {
    console.log(`🔔 Venda detectada: ${resource}`);
    try {
      // Pega o token
      const tokenData = await Token.findOne();
      if (!tokenData) return;
      const accessToken = tokenData.access_token;

      // Detalhes da venda
      const venda = (await axios.get(`https://api.mercadolibre.com${resource}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      })).data;

      const compradorId = venda.buyer.id;
      const packId = venda.pack_id || venda.id;
      const itemVendido = venda.order_items[0].item;
      const idAnuncio = itemVendido.id;

      // Busca produto no banco
      const produto = await Produto.findOne({ id_anuncio: idAnuncio });

      if (produto) {
        console.log(`✅ Produto encontrado: ${produto.nome}. Enviando mensagem...`);
        await axios.post(`https://api.mercadolibre.com/messages/packs/${packId}/sellers/${user_id}?tag=post_sale`, {
          from: { user_id },
          to: { user_id: compradorId },
          text: produto.mensagem
        }, { headers: { Authorization: `Bearer ${accessToken}` } });
        console.log(`🚀 Mensagem enviada!`);
      }
    } catch (error) {
      console.error('Erro processando venda:', error.message);
    }
  }
});

// --- 4. ROTAS PROTEGIDAS (Só acessa com SENHA) ---

// Aplica a proteção daqui para baixo
app.use(protegerPainel); 

// Serve o Painel Visual
app.use(express.static(path.join(__dirname, 'public')));

// API do Painel (Salvar/Listar)
app.get('/api/produtos', async (req, res) => {
  const produtos = await Produto.find();
  res.json(produtos);
});

app.post('/api/produtos', async (req, res) => {
  const { nome, id_anuncio, mensagem } = req.body;
  let produto = await Produto.findOne({ id_anuncio });
  if (produto) {
    produto.nome = nome;
    produto.mensagem = mensagem;
    await produto.save();
  } else {
    produto = await Produto.create({ nome, id_anuncio, mensagem });
  }
  res.json({ ok: true });
});

app.delete('/api/produtos/:id', async (req, res) => {
  await Produto.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

// Iniciar
app.listen(PORT, () => console.log(`🚀 Rodando na porta ${PORT}`));