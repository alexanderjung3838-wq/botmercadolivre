require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'chave_mestra_secreta_mercadobot';

// --- 1. CONEXÃO MONGODB ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Banco SaaS Conectado'))
    .catch(err => console.error('❌ Erro Mongo:', err));

// --- 2. MODELOS DO BANCO (MULTI-CONTAS) ---
const UsuarioSchema = new mongoose.Schema({
    email: { type: String, unique: true, required: true },
    senha: { type: String, required: true }
});
const Usuario = mongoose.model('Usuario', UsuarioSchema);

const ProdutoSchema = new mongoose.Schema({
    usuarioId: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
    nome: String, id_anuncio: String, mensagem: String
});
const Produto = mongoose.model('Produto', ProdutoSchema);

const TokenSchema = new mongoose.Schema({
    usuarioId: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
    ml_user_id: { type: String, unique: true },
    access_token: String, refresh_token: String,
    expires_in: Number, updated_at: { type: Date, default: Date.now }
});
const Token = mongoose.model('Token', TokenSchema);

const VendaProcessada = mongoose.model('VendaProcessada', new mongoose.Schema({
    id_venda: { type: String, unique: true }
}));

// --- 3. MIDDLEWARE DE SEGURANÇA ---
const autenticar = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ erro: 'Acesso negado. Faça login.' });
    
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ erro: 'Sessão expirada.' });
        req.usuarioId = decoded.id; // Guarda o ID do cliente que está usando o sistema
        next();
    });
};

// --- 4. ROTAS DE LOGIN E CADASTRO (CLIENTES) ---
app.post('/api/auth/register', async (req, res) => {
    try {
        const hash = await bcrypt.hash(req.body.senha, 10);
        await Usuario.create({ email: req.body.email, senha: hash });
        res.json({ ok: true, msg: 'Cliente cadastrado com sucesso!' });
    } catch (e) { res.status(400).json({ erro: 'Email já existe.' }); }
});

app.post('/api/auth/login', async (req, res) => {
    const u = await Usuario.findOne({ email: req.body.email });
    if (u && await bcrypt.compare(req.body.senha, u.senha)) {
        const token = jwt.sign({ id: u._id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, msg: 'Login efetuado!' });
    } else { 
        res.status(401).json({ erro: 'Email ou senha inválidos.' }); 
    }
});

// --- 5. INTEGRAÇÃO MERCADO LIVRE (AUTORIZAÇÃO) ---

// Essa rota gera o link do ML exclusivo para o cliente logado
app.get('/api/ml/auth-url', autenticar, (req, res) => {
    // O 'state' manda o ID do cliente pro ML devolver pra gente depois
    const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${process.env.ML_APP_ID}&redirect_uri=${process.env.ML_REDIRECT_URI}&state=${req.usuarioId}`;
    res.json({ url });
});

// O Mercado Livre devolve o cliente para cá
app.get('/callback', async (req, res) => {
    const { code, state } = req.query; // state = usuarioId do cliente
    if (!state) return res.status(400).send('Erro: Cliente não identificado.');

    try {
        const r = await axios.post('https://api.mercadolibre.com/oauth/token', {
            grant_type: 'authorization_code', client_id: process.env.ML_APP_ID, 
            client_secret: process.env.ML_CLIENT_SECRET, code, redirect_uri: process.env.ML_REDIRECT_URI
        });
        
        await Token.findOneAndUpdate(
            { usuarioId: state }, 
            { ...r.data, usuarioId: state, ml_user_id: r.data.user_id, updated_at: new Date() }, 
            { upsert: true }
        );
        res.send('<h1>Conta do Mercado Livre conectada com sucesso! Pode fechar esta janela.</h1>');
    } catch (e) { res.status(500).send('Erro ao conectar com Mercado Livre.'); }
});

// --- 6. O CÉREBRO: RECEBENDO VENDAS (MULTI-CONTAS) ---
async function getValidToken(tokenData) {
    const agora = new Date();
    const expira = new Date(tokenData.updated_at.getTime() + (tokenData.expires_in * 1000));
    if (agora < expira - 5 * 60000) return tokenData.access_token;

    try {
        const r = await axios.post('https://api.mercadolibre.com/oauth/token', {
            grant_type: 'refresh_token', client_id: process.env.ML_APP_ID,
            client_secret: process.env.ML_CLIENT_SECRET, refresh_token: tokenData.refresh_token
        });
        tokenData.access_token = r.data.access_token;
        tokenData.refresh_token = r.data.refresh_token;
        tokenData.expires_in = r.data.expires_in;
        tokenData.updated_at = new Date();
        await tokenData.save();
        return tokenData.access_token;
    } catch (e) { return null; }
}

app.post('/notifications', async (req, res) => {
    res.status(200).send('OK');
    const { resource, topic, user_id } = req.body;
    
    if (topic === 'orders_v2' || topic === 'orders') {
        const idVenda = resource.split('/').pop();
        if (await VendaProcessada.findOne({ id_venda: idVenda })) return; // Anti-duplicidade

        try {
            // Acha o dono da venda
            const tokenData = await Token.findOne({ ml_user_id: String(user_id) });
            if (!tokenData) return;

            const accessToken = await getValidToken(tokenData);
            if (!accessToken) return;

            const venda = (await axios.get(`https://api.mercadolibre.com${resource}`, { headers: { Authorization: `Bearer ${accessToken}` } })).data;
            const itemID = venda.order_items[0].item.id;
            
            // Busca o produto focado NO CLIENTE correto
            const produto = await Produto.findOne({ usuarioId: tokenData.usuarioId, id_anuncio: itemID });
            
            if (produto) {
                await axios.post(`https://api.mercadolibre.com/messages/packs/${venda.pack_id || venda.id}/sellers/${user_id}?tag=post_sale`, 
                    { from: { user_id }, to: { user_id: venda.buyer.id }, text: produto.mensagem }, 
                    { headers: { Authorization: `Bearer ${accessToken}` } }
                );
                await VendaProcessada.create({ id_venda: idVenda });
                console.log(`✅ Mensagem enviada para a loja do cliente ID: ${tokenData.usuarioId}`);
            }
        } catch (e) { console.error('❌ Erro Notificação:', e.message); }
    }
});

// --- 7. ROTAS DO PAINEL DE PRODUTOS (PROTEGIDAS) ---
app.get('/api/produtos', autenticar, async (req, res) => {
    res.json(await Produto.find({ usuarioId: req.usuarioId })); // Cliente só vê o que é dele
});

app.post('/api/produtos', autenticar, async (req, res) => {
    const { nome, id_anuncio, mensagem } = req.body;
    let p = await Produto.findOne({ usuarioId: req.usuarioId, id_anuncio });
    if (p) { p.nome = nome; p.mensagem = mensagem; await p.save(); } 
    else { await Produto.create({ usuarioId: req.usuarioId, nome, id_anuncio, mensagem }); }
    res.json({ ok: true });
});

app.delete('/api/produtos/:id', autenticar, async (req, res) => {
    await Produto.findOneAndDelete({ _id: req.params.id, usuarioId: req.usuarioId });
    res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`🚀 SaaS rodando na porta ${PORT}`));