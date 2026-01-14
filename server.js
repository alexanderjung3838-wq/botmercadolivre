require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurações para entender dados JSON e formulários
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuração para servir o Painel (HTML) que faremos depois
app.use(express.static(path.join(__dirname, 'public')));

// --- 1. CONEXÃO COM O BANCO DE DADOS ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Conectado ao MongoDB'))
  .catch((err) => console.error('❌ Erro no MongoDB:', err));

// --- 2. SCHEMAS (AS GAVETAS DO BANCO) ---

// Gaveta para guardar os Tokens (Auth)
const TokenSchema = new mongoose.Schema({
  access_token: String,
  refresh_token: String,
  expires_in: Number,
  updated_at: { type: Date, default: Date.now }
});
const Token = mongoose.model('Token', TokenSchema);

// Gaveta para guardar seus PRODUTOS (Painel)
const ProdutoSchema = new mongoose.Schema({
  nome: String,           // Ex: Iris Diagnose Pro
  id_anuncio: String,     // Ex: MLB12345678 (ID do ML)
  mensagem: String,       // A mensagem de entrega completa
  link_download: String,  // (Opcional) Apenas para organização
  ativo: { type: Boolean, default: true }
});
const Produto = mongoose.model('Produto', ProdutoSchema);

// --- 3. ROTAS DE AUTENTICAÇÃO (LOGIN) ---

// Rota 1: Iniciar login
app.get('/auth', (req, res) => {
  const authUrl = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${process.env.ML_APP_ID}&redirect_uri=${process.env.ML_REDIRECT_URI}`;
  res.redirect(authUrl);
});

// Rota 2: Receber o código e trocar por tokens
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

    // Salva ou atualiza no Banco
    await Token.findOneAndUpdate({}, response.data, { upsert: true, new: true });
    
    res.send('<h1>Login realizado com sucesso!</h1><p>Tokens salvos no banco. Pode fechar essa janela.</p>');
    console.log('✅ Novos tokens gerados e salvos.');
  } catch (error) {
    console.error('Erro no login:', error.response ? error.response.data : error.message);
    res.status(500).send('Erro ao autenticar.');
  }
});

// --- 4. API DO PAINEL (O CÉREBRO DO SEU DASHBOARD) ---

// Listar todos os produtos
app.get('/api/produtos', async (req, res) => {
  try {
    const produtos = await Produto.find();
    res.json(produtos);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar produtos' });
  }
});

// Criar ou Atualizar produto
app.post('/api/produtos', async (req, res) => {
  try {
    const { nome, id_anuncio, mensagem, link_download } = req.body;
    
    // Procura se já existe um produto com esse ID do ML
    let produto = await Produto.findOne({ id_anuncio });

    if (produto) {
      // Atualiza
      produto.nome = nome;
      produto.mensagem = mensagem;
      produto.link_download = link_download;
      await produto.save();
      console.log(`✏️ Produto atualizado: ${nome}`);
    } else {
      // Cria novo
      produto = await Produto.create({ nome, id_anuncio, mensagem, link_download });
      console.log(`✨ Novo produto criado: ${nome}`);
    }
    res.json({ success: true, produto });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao salvar produto' });
  }
});

// Deletar produto
app.delete('/api/produtos/:id', async (req, res) => {
  try {
    await Produto.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao deletar' });
  }
});


// --- 5. FUNÇÃO PARA PEGAR O TOKEN ATUALIZADO ---
async function getAccessToken() {
  const tokenData = await Token.findOne();
  if (!tokenData) return null;
  return tokenData.access_token;
}

// --- 6. ROTA DE NOTIFICAÇÕES (O GATILHO DA VENDA) ---
app.post('/notifications', async (req, res) => {
  res.status(200).send('OK'); // Responde rápido pro ML não reclamar
  
  const { resource, topic, user_id } = req.body;
  
  // Só nos interessa se for uma venda ("orders_v2" ou "orders")
  if (topic === 'orders_v2' || topic === 'orders') {
    console.log(`💰 Nova venda detectada! Resource: ${resource}`);
    
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) return console.log('❌ Erro: Nenhum token salvo no banco.');

      // 1. Vai no ML perguntar os detalhes dessa venda
      const vendaResponse = await axios.get(`https://api.mercadolibre.com${resource}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const venda = vendaResponse.data;

      // 2. Descobre quem comprou e o que comprou
      const compradorId = venda.buyer.id;
      const packId = venda.pack_id || venda.id; // ID do pacote de mensagens
      
      // Pega o primeiro item da lista (geralmente é só 1)
      const itemVendido = venda.order_items[0].item;
      const idAnuncio = itemVendido.id; // O famoso MLB...
      const nomeAnuncio = itemVendido.title;

      console.log(`📦 Produto: ${nomeAnuncio} | ID: ${idAnuncio}`);

      // 3. Procura no NOSSO banco se temos esse produto cadastrado
      const produtoConfigurado = await Produto.findOne({ id_anuncio: idAnuncio });

      if (produtoConfigurado) {
        // ACHAMOS! Vamos mandar a mensagem
        console.log(`✅ Encontrado no painel! Enviando mensagem...`);
        
        await enviarMensagem(packId, user_id, compradorId, produtoConfigurado.mensagem, accessToken);
        
      } else {
        console.log(`⚠️ Venda do item ${idAnuncio} recebida, mas NÃO cadastrada no painel.`);
      }

    } catch (error) {
      console.error('❌ Erro ao processar venda:', error.message);
    }
  }
});

// --- 7. FUNÇÃO DE ENVIAR MENSAGEM ---
async function enviarMensagem(packId, meuId, compradorId, texto, token) {
  try {
    const url = `https://api.mercadolibre.com/messages/packs/${packId}/sellers/${meuId}?tag=post_sale`;
    
    const corpoMensagem = {
      from: { user_id: meuId },
      to: { user_id: compradorId },
      text: texto
    };

    await axios.post(url, corpoMensagem, {
      headers: { 
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log(`🚀 MENSAGEM ENVIADA COM SUCESSO!`);
  } catch (error) {
    console.error(`❌ Falha ao enviar mensagem:`, error.response ? error.response.data : error.message);
  }
}

// --- INICIAR SERVIDOR ---
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});