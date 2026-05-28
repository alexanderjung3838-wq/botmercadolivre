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

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Banco SaaS Conectado'))
    .catch(err => console.error('❌ Erro Mongo:', err));

// --- MODELOS ---
const UsuarioSchema = new mongoose.Schema({
    email: { type: String, unique: true, required: true },
    senha: { type: String, required: true },
    status: { type: String, default: 'bloqueado' } // ALTERADO: Agora todos nascem bloqueados
});
const Usuario = mongoose.model('Usuario', UsuarioSchema);

const Produto = mongoose.model('Produto', new mongoose.Schema({
    usuarioId: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
    nome: String, id_anuncio: String, mensagem: String
}));

const Token = mongoose.model('Token', new mongoose.Schema({
    usuarioId: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
    ml_user_id: { type: String, unique: true },
    access_token: String, refresh_token: String,
    expires_in: Number, updated_at: { type: Date, default: Date.now }
}));

const VendaProcessada = mongoose.model('VendaProcessada', new mongoose.Schema({
    id_venda: { type: String, unique: true }
}));

// --- SEGURANÇA ---
const autenticar = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ erro: 'Acesso negado.' });
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ erro: 'Sessão expirada.' });
        req.usuarioId = decoded.id;
        req.isAdmin = decoded.isAdmin;
        next();
    });
};

const somenteAdmin = (req, res, next) => {
    if (!req.isAdmin) return res.status(403).json({ erro: 'Acesso restrito ao Dono.' });
    next();
};

// --- LOGIN E CADASTRO ---
app.post('/api/auth/register', async (req, res) => {
    try {
        const hash = await bcrypt.hash(req.body.senha, 10);
        await Usuario.create({ email: req.body.email, senha: hash });
        res.json({ ok: true, msg: 'Conta criada! Aguarde a liberação do administrador.' }); // Mensagem atualizada
    } catch (e) { res.status(400).json({ erro: 'Email já existe.' }); }
});

app.post('/api/auth/login', async (req, res) => {
    const u = await Usuario.findOne({ email: req.body.email });
    if (u && await bcrypt.compare(req.body.senha, u.senha)) {
        const isSuperAdmin = u.email === process.env.ADMIN_EMAIL;
        
        // Bloqueia se não for admin E estiver com status bloqueado
        if (!isSuperAdmin && u.status !== 'ativo') {
            return res.status(403).json({ erro: 'Sua conta ainda não foi ativada. Contate o suporte.' });
        }
        
        const token = jwt.sign({ id: u._id, isAdmin: isSuperAdmin }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, isAdmin: isSuperAdmin, msg: 'Login efetuado!' });
    } else { 
        res.status(401).json({ erro: 'Email ou senha inválidos.' }); 
    }
});

// --- ROTAS DO ADMINISTRADOR (SÓ VOCÊ VÊ) ---
app.get('/api/admin/usuarios', autenticar, somenteAdmin, async (req, res) => {
    const usuarios = await Usuario.find({}, '-senha');
    res.json(usuarios);
});

app.put('/api/admin/usuarios/:id/status', autenticar, somenteAdmin, async (req, res) => {
    const u = await Usuario.findById(req.params.id);
    u.status = u.status === 'ativo' ? 'bloqueado' : 'ativo';
    await u.save();
    res.json({ ok: true, status: u.status });
});

// --- INTEGRAÇÃO MERCADO LIVRE ---
app.get('/api/ml/auth-url', autenticar, (req, res) => {
    const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${process.env.ML_APP_ID}&redirect_uri=${process.env.ML_REDIRECT_URI}&state=${req.usuarioId}`;
    res.json({ url });
});

app.get('/callback', async (req, res) => {
    const { code, state } = req.query; 
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
        res.send('<h1>Mercado Livre conectado! Pode fechar esta janela.</h1>');
    } catch (e) { res.status(500).send('Erro ao conectar com Mercado Livre.'); }
});

// --- RECEBENDO VENDAS ---
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
    // 1. Responde o Mercado Livre na hora para ele parar de insistir
    res.status(200).send('OK');
    const { resource, topic, user_id } = req.body;
    
    if (topic === 'orders_v2' || topic === 'orders') {
        const idVenda = resource.split('/').pop();

        // 🔥 A MÁGICA ACONTECE AQUI: Tenta "trancar" a venda no banco imediatamente
        try {
            await VendaProcessada.create({ id_venda: idVenda });
        } catch (err) {
            // Se cair aqui, é porque o MongoDB avisou que essa venda já existe. Ignoramos as duplicatas!
            return console.log(`🔄 Notificação duplicada ignorada (Venda ${idVenda})`);
        }

        try {
            const tokenData = await Token.findOne({ ml_user_id: String(user_id) });
            if (!tokenData) return;

            // TRAVA DE SEGURANÇA: O cliente pagou a conta?
            const dono = await Usuario.findById(tokenData.usuarioId);
            if (!dono || dono.status !== 'ativo') {
                return console.log(`🚫 Venda ignorada: Cliente ${dono?.email} não está ativo.`);
            }

            const accessToken = await getValidToken(tokenData);
            if (!accessToken) return;

            // Busca detalhes da venda
            const venda = (await axios.get(`https://api.mercadolibre.com${resource}`, { headers: { Authorization: `Bearer ${accessToken}` } })).data;
            const itemID = venda.order_items[0].item.id;
            
            // Busca a mensagem do produto
            const produto = await Produto.findOne({ usuarioId: tokenData.usuarioId, id_anuncio: itemID });
            
            if (produto) {
                // Envia a mensagem
                await axios.post(`https://api.mercadolibre.com/messages/packs/${venda.pack_id || venda.id}/sellers/${user_id}?tag=post_sale`, 
                    { from: { user_id }, to: { user_id: venda.buyer.id }, text: produto.mensagem }, 
                    { headers: { Authorization: `Bearer ${accessToken}` } }
                );
                console.log(`✅ Mensagem única enviada para a venda ${idVenda}`);
            }
        } catch (e) { 
            console.error('❌ Erro Notificação:', e.message); 
            // Se der erro ao enviar a mensagem, destrancamos a venda para a próxima notificação tentar de novo
            await VendaProcessada.findOneAndDelete({ id_venda: idVenda });
        }
    }
});

// --- ROTAS DO PAINEL DO CLIENTE ---
app.get('/api/produtos', autenticar, async (req, res) => {
    res.json(await Produto.find({ usuarioId: req.usuarioId }));
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