require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');
const cron = require('node-cron');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'chave_mestra_secreta_mercadobot';

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Banco SaaS Conectado'))
    .catch(err => console.error('❌ Erro Mongo:', err));

// --- MODELOS ---
const Usuario = mongoose.model('Usuario', new mongoose.Schema({
    email: { type: String, unique: true, required: true },
    senha: { type: String, required: true },
    status: { type: String, default: 'bloqueado' }
}));

const Produto = mongoose.model('Produto', new mongoose.Schema({
    usuarioId: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
    nome: String, id_anuncio: String, mensagem: String,
    mensagem_pos_venda: { type: String, default: '' }, 
    tempo_espera_horas: { type: Number, default: 24 } 
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

const Agendamento = mongoose.model('Agendamento', new mongoose.Schema({
    id_venda: String, usuarioId: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
    ml_user_id: String, buyer_id: String, pack_id: String, mensagem: String, data_programada: Date
}));

// NOVO: Modelo para as configurações do Admin (Tela de Espera)
const Configuracao = mongoose.model('Configuracao', new mongoose.Schema({
    mensagem_bloqueio: { type: String, default: 'Seu cadastro foi realizado com sucesso! Para liberar seu acesso ao painel, clique no botão abaixo e envie o comprovante via WhatsApp.' },
    whatsapp: { type: String, default: '5511999999999' }
}));

async function getConfig() {
    let conf = await Configuracao.findOne();
    if (!conf) conf = await Configuracao.create({});
    return conf;
}

// --- SEGURANÇA ---
const autenticar = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(401).json({ erro: 'Acesso negado.' });
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return res.status(401).json({ erro: 'Sessão expirada.' });
        req.usuarioId = decoded.id; req.isAdmin = decoded.isAdmin; next();
    });
};
const somenteAdmin = (req, res, next) => {
    if (!req.isAdmin) return res.status(403).json({ erro: 'Acesso restrito.' });
    next();
};

// --- LOGIN, CADASTRO E CONFIGURAÇÕES ---
app.get('/api/config/bloqueio', async (req, res) => res.json(await getConfig()));

app.put('/api/admin/config/bloqueio', autenticar, somenteAdmin, async (req, res) => {
    let conf = await getConfig();
    conf.mensagem_bloqueio = req.body.mensagem_bloqueio;
    conf.whatsapp = req.body.whatsapp;
    await conf.save(); res.json({ ok: true });
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const hash = await bcrypt.hash(req.body.senha, 10);
        await Usuario.create({ email: req.body.email, senha: hash });
        res.json({ ok: true }); // O Frontend agora puxa a tela de Espera sozinho
    } catch (e) { res.status(400).json({ erro: 'Este e-mail já está cadastrado.' }); }
});

app.post('/api/auth/login', async (req, res) => {
    const u = await Usuario.findOne({ email: req.body.email });
    if (u && await bcrypt.compare(req.body.senha, u.senha)) {
        const isSuperAdmin = u.email === process.env.ADMIN_EMAIL;
        
        // NOVO: Se bloqueado, manda os dados da tela de espera
        if (!isSuperAdmin && u.status !== 'ativo') {
            const conf = await getConfig();
            return res.status(403).json({ erro: 'bloqueado', msg: conf.mensagem_bloqueio, wpp: conf.whatsapp });
        }
        
        const token = jwt.sign({ id: u._id, isAdmin: isSuperAdmin }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, isAdmin: isSuperAdmin, msg: 'Login efetuado!' });
    } else { res.status(401).json({ erro: 'Email ou senha inválidos.' }); }
});

// --- ROTAS DO ADMIN (Excluir e Mudar Status) ---
app.get('/api/admin/usuarios', autenticar, somenteAdmin, async (req, res) => res.json(await Usuario.find({}, '-senha')));
app.put('/api/admin/usuarios/:id/status', autenticar, somenteAdmin, async (req, res) => {
    const u = await Usuario.findById(req.params.id); u.status = u.status === 'ativo' ? 'bloqueado' : 'ativo';
    await u.save(); res.json({ ok: true });
});
// NOVO: Exclusão definitiva de usuário e seus rastros
app.delete('/api/admin/usuarios/:id', autenticar, somenteAdmin, async (req, res) => {
    await Usuario.findByIdAndDelete(req.params.id);
    await Produto.deleteMany({ usuarioId: req.params.id });
    await Token.deleteMany({ usuarioId: req.params.id });
    await Agendamento.deleteMany({ usuarioId: req.params.id });
    res.json({ ok: true });
});

// --- ML AUTH E VENDAS ---
app.get('/api/ml/auth-url', autenticar, (req, res) => {
    res.json({ url: `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${process.env.ML_APP_ID}&redirect_uri=${process.env.ML_REDIRECT_URI}&state=${req.usuarioId}` });
});
app.get('/callback', async (req, res) => {
    const { code, state } = req.query; if (!state) return res.status(400).send('Erro: Cliente não identificado.');
    try {
        const r = await axios.post('https://api.mercadolibre.com/oauth/token', { grant_type: 'authorization_code', client_id: process.env.ML_APP_ID, client_secret: process.env.ML_CLIENT_SECRET, code, redirect_uri: process.env.ML_REDIRECT_URI });
        await Token.findOneAndUpdate({ usuarioId: state }, { ...r.data, usuarioId: state, ml_user_id: r.data.user_id, updated_at: new Date() }, { upsert: true });
        res.send('<h1>Mercado Livre conectado! Pode fechar esta janela.</h1>');
    } catch (e) { res.status(500).send('Erro ao conectar com Mercado Livre.'); }
});

async function getValidToken(tokenData) {
    const agora = new Date(); const expira = new Date(tokenData.updated_at.getTime() + (tokenData.expires_in * 1000));
    if (agora < expira - 5 * 60000) return tokenData.access_token;
    try {
        const r = await axios.post('https://api.mercadolibre.com/oauth/token', { grant_type: 'refresh_token', client_id: process.env.ML_APP_ID, client_secret: process.env.ML_CLIENT_SECRET, refresh_token: tokenData.refresh_token });
        tokenData.access_token = r.data.access_token; tokenData.refresh_token = r.data.refresh_token; tokenData.expires_in = r.data.expires_in; tokenData.updated_at = new Date();
        await tokenData.save(); return tokenData.access_token;
    } catch (e) { return null; }
}

app.post('/notifications', async (req, res) => {
    res.status(200).send('OK');
    const { resource, topic, user_id } = req.body;
    if (topic === 'orders_v2' || topic === 'orders') {
        const idVenda = resource.split('/').pop();
        try { await VendaProcessada.create({ id_venda: idVenda }); } catch (err) { return; } 
        try {
            const tokenData = await Token.findOne({ ml_user_id: String(user_id) }); if (!tokenData) return;
            const dono = await Usuario.findById(tokenData.usuarioId); if (!dono || dono.status !== 'ativo') return;
            const accessToken = await getValidToken(tokenData); if (!accessToken) return;
            const venda = (await axios.get(`https://api.mercadolibre.com${resource}`, { headers: { Authorization: `Bearer ${accessToken}` } })).data;
            const itemID = venda.order_items[0].item.id;
            const produto = await Produto.findOne({ usuarioId: tokenData.usuarioId, id_anuncio: itemID });
            if (produto) {
                await axios.post(`https://api.mercadolibre.com/messages/packs/${venda.pack_id || venda.id}/sellers/${user_id}?tag=post_sale`, 
                    { from: { user_id }, to: { user_id: venda.buyer.id }, text: produto.mensagem }, { headers: { Authorization: `Bearer ${accessToken}` } }
                );
                if (produto.mensagem_pos_venda && produto.tempo_espera_horas > 0) {
                    const dataProgramada = new Date(Date.now() + (produto.tempo_espera_horas * 60 * 60 * 1000));
                    await Agendamento.create({
                        id_venda: idVenda, usuarioId: tokenData.usuarioId, ml_user_id: user_id, buyer_id: venda.buyer.id, pack_id: venda.pack_id || venda.id, 
                        mensagem: produto.mensagem_pos_venda, data_programada: dataProgramada
                    });
                }
            }
        } catch (e) { await VendaProcessada.findOneAndDelete({ id_venda: idVenda }); }
    }
});

cron.schedule('*/15 * * * *', async () => {
    const agora = new Date(); const pendentes = await Agendamento.find({ data_programada: { $lte: agora } });
    for (const ag of pendentes) {
        try {
            const dono = await Usuario.findById(ag.usuarioId); if (!dono || dono.status !== 'ativo') continue;
            const tokenData = await Token.findOne({ ml_user_id: ag.ml_user_id }); if (!tokenData) continue;
            const accessToken = await getValidToken(tokenData);
            if (accessToken) {
                await axios.post(`https://api.mercadolibre.com/messages/packs/${ag.pack_id}/sellers/${ag.ml_user_id}?tag=post_sale`, 
                    { from: { user_id: ag.ml_user_id }, to: { user_id: ag.buyer_id }, text: ag.mensagem }, { headers: { Authorization: `Bearer ${accessToken}` } }
                );
            }
        } catch (e) {} finally { await Agendamento.findByIdAndDelete(ag._id); }
    }
});

// --- ROTAS DO PRODUTO ---
app.get('/api/produtos', autenticar, async (req, res) => res.json(await Produto.find({ usuarioId: req.usuarioId })));
app.post('/api/produtos', autenticar, async (req, res) => {
    const { nome, id_anuncio, mensagem, mensagem_pos_venda, tempo_espera_horas } = req.body;
    let p = await Produto.findOne({ usuarioId: req.usuarioId, id_anuncio });
    if (p) { p.nome = nome; p.mensagem = mensagem; p.mensagem_pos_venda = mensagem_pos_venda; p.tempo_espera_horas = tempo_espera_horas; await p.save(); } 
    else { await Produto.create({ usuarioId: req.usuarioId, nome, id_anuncio, mensagem, mensagem_pos_venda, tempo_espera_horas: tempo_espera_horas || 24 }); }
    res.json({ ok: true });
});
app.delete('/api/produtos/:id', autenticar, async (req, res) => { await Produto.findOneAndDelete({ _id: req.params.id, usuarioId: req.usuarioId }); res.json({ ok: true }); });

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`🚀 SaaS rodando na porta ${PORT}`));