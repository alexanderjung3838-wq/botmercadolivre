const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
app.use(express.json());

// --- CONFIGURAÇÕES ---
const PORT = process.env.PORT || 3000;
const APP_ID = process.env.ML_APP_ID ? process.env.ML_APP_ID.trim() : '';
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET ? process.env.ML_CLIENT_SECRET.trim() : '';
const REDIRECT_URI = process.env.ML_REDIRECT_URI ? process.env.ML_REDIRECT_URI.trim() : '';

// --- CONEXÃO MONGODB ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Conectado ao MongoDB'))
    .catch(err => console.error('❌ Erro no MongoDB:', err));

// Schema do Token
const TokenSchema = new mongoose.Schema({
    _id: String,
    access_token: String,
    refresh_token: String,
    expires_in: Number,
    saved_at: Number
});
const TokenModel = mongoose.model('Token', TokenSchema);

// --- GERENCIAMENTO DE TOKENS ---
async function saveTokens(tokens) {
    const data = { 
        ...tokens, 
        saved_at: Date.now(),
        _id: 'bot_auth'
    };
    await TokenModel.findByIdAndUpdate('bot_auth', data, { upsert: true });
    console.log('💾 Tokens salvos no Banco de Dados.');
}

async function getAccessToken() {
    let tokens = await TokenModel.findById('bot_auth');
    if (!tokens) throw new Error("Sem token. Faça login em /auth");

    const agora = Date.now();
    const expiracao = tokens.saved_at + (tokens.expires_in * 1000) - (30 * 60 * 1000); 

    if (agora > expiracao) {
        console.log('⌛ Renovando token...');
        try {
            const response = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
                params: {
                    grant_type: 'refresh_token',
                    client_id: APP_ID,
                    client_secret: CLIENT_SECRET,
                    refresh_token: tokens.refresh_token
                },
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            await saveTokens(response.data);
            return response.data.access_token;
        } catch (error) {
            console.error('❌ Erro fatal ao renovar token:', error.response?.data || error.message);
            throw error;
        }
    }
    return tokens.access_token;
}

// --- ROTAS ---
app.get('/', (req, res) => {
    res.send('O Robô Vendedor está ONLINE e pronto para vender! 🚀');
});

app.get('/auth', (req, res) => {
    const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${APP_ID}&redirect_uri=${REDIRECT_URI}`;
    res.redirect(url);
});

app.get('/callback', async (req, res) => {
    const { code } = req.query;
    try {
        const response = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
            params: {
                grant_type: 'authorization_code',
                client_id: APP_ID,
                client_secret: CLIENT_SECRET,
                code: code,
                redirect_uri: REDIRECT_URI
            },
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        
        await saveTokens(response.data);
        res.send('<h1>SUCESSO!</h1> <p>Robô autenticado no MongoDB. Pode fechar esta janela.</p>');
    } catch (error) {
        res.status(500).send('Erro: ' + JSON.stringify(error.response?.data));
    }
});

app.post('/notifications', async (req, res) => {
    res.status(200).send('OK');
    const { topic, resource } = req.body;
    if (topic === 'orders_v2') {
        processarVenda(resource);
    }
});

// --- LÓGICA DE ENVIO INTELIGENTE (CATÁLOGO) ---
async function processarVenda(resourceUri) {
    try {
        const token = await getAccessToken();
        const orderResponse = await axios.get(`https://api.mercadolibre.com${resourceUri}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const order = orderResponse.data;

        if (order.status !== 'paid') {
            console.log(`Venda ${order.id} ignorada: Status é ${order.status}`);
            return;
        }

        console.log(`💰 Venda Paga detectada! ID da Venda: ${order.id}`);

        // 1. Identifica o produto vendido
        const itemVendido = order.order_items[0].item;
        const mlbId = itemVendido.id; // Aqui vem o ID (Ex: MLBU1425061106)
        const tituloItem = itemVendido.title;

        console.log(`📦 Produto: ${tituloItem} | ID: ${mlbId}`);

        const packId = order.pack_id || order.id;
        const buyerId = order.buyer.id;
        const sellerId = order.seller.id;

        // ============================================================
        // CATÁLOGO DE MENSAGENS
        // ============================================================
        let mensagemTexto = "";

        // CASO 1: SEU PRODUTO ESPECÍFICO (ID MLBU1425061106)
        if (mlbId === 'MLBU1425061106') {
            mensagemTexto = `Olá! Muito obrigado pela compra do Sistema! 🚀

O seu acesso já está liberado.

⬇️ LINK PARA DOWNLOAD:

Link do produto
https://drive.google.com/file/d/1fUhg46DIUvUT_UUQKRyTwZCifVS3JHK8/view?usp=sharing

Link do passo a passo
https://drive.google.com/file/d/1bj_L0_4ZNRVEcHit9mRjeBnfjoYO118d/view?usp=drive_link

🔑 SUA CHAVE DE LICENÇA:
SISTEMA-

❓ Dúvidas?
Se precisar de suporte, basta responder esta mensagem.

Att, Alexander Jung.`;

        } 
        // CASO 2: OUTROS PRODUTOS (Padrão)
        else {
            mensagemTexto = `Olá! Obrigado pela compra do produto: ${tituloItem}.
Já recebemos seu pedido e logo entraremos em contato para fazer a entrega!

Att, Alexander Jung.`;
        }
        // ============================================================

        // Envia a mensagem escolhida
        await axios.post(`https://api.mercadolibre.com/messages/packs/${packId}/sellers/${sellerId}?access_token=${token}`, {
            from: { user_id: sellerId },
            to: { user_id: buyerId },
            text: mensagemTexto
        }, { headers: { 'Content-Type': 'application/json' }});
        
        console.log(`✅ Mensagem enviada para o comprador do item ${mlbId}!`);

    } catch (error) {
        console.error('❌ Erro no processamento:', error.response?.data || error.message);
    }
}

app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});