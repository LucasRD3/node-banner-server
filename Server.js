// server.js (CONTROLE DE BANNER COM CLOUDINARY E MONGODB)

const express = require('express');
const cors = require('cors'); 
const { DateTime } = require('luxon');
const fetch = require('node-fetch'); // Mantido por compatibilidade
const cloudinary = require('cloudinary').v2;
const multer = require('multer');           
const { MongoClient } = require('mongodb'); // NOVO: Driver MongoDB
const app = express();

app.use(express.json()); 
app.use(cors()); 

// =========================================================================
// === CONFIGURAÇÃO E CONEXÃO MONGODB ===
// =========================================================================

// Variáveis de Ambiente Necessárias: MONGODB_URI
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = 'banner_db'; // Nome do seu banco de dados
const COLLECTION_NAME = 'banners'; // Nome da coleção de banners

let db;

async function connectToDatabase() {
    if (db) {
        return db; // Retorna a conexão existente se já estiver ativa
    }

    if (!MONGODB_URI) {
        throw new Error('A variável de ambiente MONGODB_URI não está configurada.');
    }

    try {
        const client = await MongoClient.connect(MONGODB_URI);
        db = client.db(DB_NAME);
        console.log('Conectado ao MongoDB com sucesso!');
        return db;
    } catch (error) {
        console.error('Falha ao conectar ao MongoDB:', error.message);
        throw error;
    }
}

async function getBannersCollection() {
    const database = await connectToDatabase();
    return database.collection(COLLECTION_NAME);
}

// =========================================================================
// === CONFIGURAÇÃO CLOUDINARY ===
// =========================================================================
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configuração do Multer
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });


// =========================================================================
// === ROTAS DA API ===
// =========================================================================

// --- ROTA PARA UPLOAD DE BANNER (Cloudinary + MongoDB) ---
app.post('/api/banners/upload', upload.single('bannerFile'), async (req, res) => {
    
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado.' });
    }
    
    try {
        const fileBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

        // 1. Upload para o Cloudinary
        const result = await cloudinary.uploader.upload(fileBase64, {
            folder: 'site_banners', // Pasta no Cloudinary
        });

        const newBannerUrl = result.secure_url;
        const newBannerPublicId = result.public_id; 

        // 2. Salva a configuração no MongoDB
        const collection = await getBannersCollection();
        
        const newBannerDocument = {
            url: newBannerUrl,
            publicId: newBannerPublicId,
            day: 'random', 
            priority: 999,
            isActive: true // Ativado por padrão
        };
        
        await collection.insertOne(newBannerDocument);
        
        res.json({ 
            success: true, 
            message: 'Banner enviado e ativado como Aleatório, com prioridade baixa (999)!', 
            url: newBannerUrl,
            publicId: newBannerPublicId
        });
        
    } catch (error) {
        console.error('Erro no upload para Cloudinary/MongoDB:', error);
        res.status(500).json({ success: false, error: `Falha interna ao salvar configuração: ${error.message}` });
    }
});


// --- ROTA PARA EXCLUSÃO PERMANENTE DE BANNER (Cloudinary + MongoDB) ---
app.delete('/api/banners/delete', async (req, res) => {
    const { fileUrl } = req.body; 

    if (!fileUrl) {
        return res.status(400).json({ success: false, error: 'URL do arquivo não fornecida para exclusão.' });
    }
    
    try {
        const collection = await getBannersCollection();
        
        // 1. Busca o documento para obter o publicId
        const banner = await collection.findOne({ url: fileUrl });

        if (!banner) {
            return res.status(404).json({ success: false, error: 'Banner não encontrado no banco de dados.' });
        }
        
        const publicId = banner.publicId;

        // 2. Excluir do Cloudinary (usando o publicId)
        if (publicId && publicId !== 'unknown') {
            const cloudinaryResult = await cloudinary.uploader.destroy(publicId);
            
            if (cloudinaryResult.result !== 'ok' && cloudinaryResult.result !== 'not found') {
                console.warn(`Aviso: Falha ao excluir do Cloudinary: ${cloudinaryResult.result}`);
            }
        }
        
        // 3. Remover do MongoDB
        await collection.deleteOne({ url: fileUrl });
        
        res.json({ 
            success: true, 
            message: 'Banner excluído com sucesso do Cloudinary e do MongoDB.'
        });

    } catch (error) {
        console.error('Erro na exclusão do banner:', error);
        res.status(500).json({ success: false, error: `Falha interna ao excluir banner: ${error.message}` });
    }
});


// --- ROTA 1: API PARA OBTER OS BANNERS ATIVOS (CONSUMO DO CLIENTE) ---
app.get('/api/banners', async (req, res) => {
    
    try {
        const collection = await getBannersCollection();
        // Busca todos os banners ativos
        const allBanners = await collection.find({ isActive: true }).toArray();
        
        const today = DateTime.local().setZone('America/Sao_Paulo').weekday.toString(); 
        
        let activeBanners = [];

        allBanners.forEach(banner => {
            const dayToDisplay = banner.day || 'random'; 
            
            // Ativo se for 'random' OU o dia configurado for o dia de hoje
            if (dayToDisplay === 'random' || dayToDisplay === today) {
                activeBanners.push({
                    url: banner.url,
                    priority: banner.priority || 999 
                });
            }
        });
        
        // Ordena a lista de banners ativos pela prioridade (menor número = maior prioridade)
        activeBanners.sort((a, b) => a.priority - b.priority);

        // Extrai apenas os URLs para a resposta final
        const finalBannerUrls = activeBanners.map(b => b.url);
        
        res.json({ 
            banners: [...new Set(finalBannerUrls)],
            debug: {
                currentDay: today,
                timezone: 'America/Sao_Paulo',
                numGenericosAtivos: finalBannerUrls.length 
            }
        });

    } catch (error) {
        console.error('Erro ao buscar banners ativos:', error);
        res.status(500).json({ success: false, error: `Falha interna ao buscar banners: ${error.message}` });
    }
});

// --- ROTA 2: API PARA OBTER LISTA COMPLETA DE BANNERS E STATUS (PAINEL) ---
app.get('/api/config/banners/list', async (req, res) => {
    
    try {
        const collection = await getBannersCollection();
        // Busca todos os banners
        const allBanners = await collection.find({}).toArray();
        
        let bannerList = allBanners.map(banner => ({
            fileName: banner.url, 
            isDailyBanner: false, 
            isActive: banner.isActive,
            day: banner.day || 'random', 
            priority: banner.priority || 999 
        }));
        
        // Ordena a lista para exibição no painel pela prioridade
        bannerList.sort((a, b) => a.priority - b.priority);

        res.json({
            config: {}, 
            banners: bannerList
        });

    } catch (error) {
        console.error('Erro ao listar banners:', error);
        res.status(500).json({ success: false, error: `Falha interna ao listar banners: ${error.message}` });
    }
});

// --- ROTA 3: API PARA ATUALIZAR CONFIGURAÇÃO (ESCRITA DO PAINEL) ---
// Agora lida com 'active', 'day' e 'priority' no MongoDB
app.put('/api/config/banners', async (req, res) => {
    
    const { file, active, day, priority } = req.body; 
    
    if (typeof active !== 'boolean' || !file) {
        return res.status(400).json({ success: false, error: 'O campo "active" deve ser booleano e "file" (URL) deve ser fornecido.' });
    }
    
    try {
        const collection = await getBannersCollection();
        
        // Dados a serem atualizados (update object)
        const updateData = {
            isActive: active,
            // Só atualiza day e priority se for passado OU se o banner estiver ativo
            day: day || 'random', 
            priority: priority !== undefined ? priority : 999
        };
        
        // Se estiver desativando, garantimos que day e priority refletem o que já estava lá (para não perder a config)
        if (!active) {
            const currentBanner = await collection.findOne({ url: file });
            if (currentBanner) {
                updateData.day = currentBanner.day || 'random';
                updateData.priority = currentBanner.priority || 999;
            }
        }
        
        const result = await collection.updateOne(
            { url: file }, // Filtro: usa a URL como identificador único
            { $set: updateData }, 
            { upsert: false } // Não cria se não existir (upsert false)
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ success: false, error: 'Banner não encontrado para atualização.' });
        }

        res.json({ 
            success: true, 
            new_state: updateData.isActive, 
            banner_file: file, 
            new_day: updateData.day,
            new_priority: updateData.priority,
            message: `Configuração do banner ${file} atualizada com sucesso no MongoDB.` 
        });
        
    } catch (error) {
        console.error('Erro de escrita no MongoDB:', error);
        res.status(500).json({ success: false, error: `Falha interna ao salvar configuração: ${error.message}` });
    }
});

module.exports = app;