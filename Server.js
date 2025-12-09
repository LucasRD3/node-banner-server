// server.js (CONTROLE INDIVIDUAL POR ARQUIVO DINÂMICO COM CLOUDINARY - JSONBIN REMOVIDO)

const express = require('express');
const cors = require('cors'); 
const { DateTime } = require('luxon'); // Mantido, mas sem uso prático
// const fetch = require('node-fetch'); // Removido por não ser mais necessário para JSONBin
const cloudinary = require('cloudinary').v2;
const multer = require('multer');           
const app = express();

app.use(express.json()); 
app.use(cors()); 

// --- CONFIGURAÇÃO CLOUDINARY ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configuração do Multer: Armazena o arquivo na memória temporariamente
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// =========================================================================
// === FUNÇÕES DE CONFIGURAÇÃO REMOTA (JSONBIN REMOVIDO) ===
// =========================================================================

// JSONBIN_URL, JSONBIN_WRITE_URL e getBannerConfig removidos.
// O código agora não tem onde armazenar ou ler o estado dos banners.

// =========================================================================
// === ROTAS DA API ===
// =========================================================================

// --- ROTA PARA UPLOAD DE BANNER (Cloudinary) ---
app.post('/api/banners/upload', upload.single('bannerFile'), async (req, res) => {
    
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado.' });
    }
    
    try {
        const fileBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

        // 1. Upload para o Cloudinary (MANTIDO)
        const result = await cloudinary.uploader.upload(fileBase64, {
            folder: 'site_banners', // Pasta no Cloudinary
        });

        const newBannerUrl = result.secure_url;
        const newBannerPublicId = result.public_id; 

        // 2. A lógica de busca, atualização e salvamento no JSON Bin foi removida.
        
        // Apenas retorna o sucesso do upload para o Cloudinary.
        res.json({ 
            success: true, 
            message: 'Banner enviado para Cloudinary com sucesso. A configuração de exibição não foi salva.', 
            url: newBannerUrl,
            publicId: newBannerPublicId
        });
        
    } catch (error) {
        console.error('Erro no upload para Cloudinary:', error);
        // O erro do JSON Bin foi substituído por um erro mais genérico
        res.status(500).json({ success: false, error: `Falha interna no upload: ${error.message}` });
    }
});


// --- ROTA 1: API PARA OBTER OS BANNERS ATIVOS (CONSUMO DO CLIENTE) ---
app.get('/api/banners', async (req, res) => {
    
    // A chamada a getBannerConfig foi removida. Não há configuração para ler.
    
    // A rota retorna banners vazios, pois não há persistência.
    const today = DateTime.local().setZone('America/Sao_Paulo').weekday.toString(); 
    
    res.json({ 
        banners: [], // Sempre vazia
        debug: {
            currentDay: today,
            timezone: 'America/Sao_Paulo',
            numGenericosAtivos: 0 
        }
    });
});

// --- ROTA 2: API PARA OBTER LISTA COMPLETA DE BANNERS E STATUS (PAINEL) ---
app.get('/api/config/banners/list', async (req, res) => {
    
    // A chamada a getBannerConfig foi removida. Não há configuração para ler.
    
    // A rota retorna uma lista vazia, pois não há persistência.
    res.json({
        config: {}, 
        banners: [] // Sempre vazia
    });
});

// --- ROTA 3: API PARA ATUALIZAR CONFIGURAÇÃO (ESCRITA DO PAINEL) ---
app.put('/api/config/banners', async (req, res) => {
    
    // A lógica de leitura e escrita no JSON Bin foi removida.
    
    // A rota apenas retorna um erro/aviso de que não há persistência.
    res.status(501).json({ 
        success: false, 
        error: 'A persistência de configuração (JSON Bin) foi removida. Esta rota não tem mais função.' 
    });
});

module.exports = app;