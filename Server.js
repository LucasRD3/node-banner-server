// server.js (CONTROLE INDIVIDUAL POR ARQUIVO DINÂMICO COM CLOUDINARY)

const express = require('express');
const cors = require('cors'); 
const { DateTime } = require('luxon');
const fetch = require('node-fetch'); 
const cloudinary = require('cloudinary').v2;
const multer = require('multer');           
const { MongoClient, ServerApiVersion } = require('mongodb'); // NOVO: Import MongoDB
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
// === CONFIGURAÇÃO MONGODB (NOVO) ===
// =========================================================================
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || 'BannerConfigDB';
const collectionName = process.env.MONGODB_COLLECTION_NAME || 'Configurations';
// ID Fixo para o nosso único documento de configuração, substituindo o JSONBIN_BIN_ID
const CONFIG_DOCUMENT_ID = "banner_configuration_v1"; 

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

let db;

async function connectToMongo() {
    if (db) return db; // Retorna conexão existente
    
    if (!uri) {
        console.error("ERRO: MONGODB_URI não está definida.");
        return null;
    }

    try {
        console.log("Tentando conectar ao MongoDB...");
        await client.connect();
        db = client.db(dbName);
        console.log("Conexão MongoDB estabelecida com sucesso!");
        return db;
    } catch (error) {
        console.error("Falha ao conectar ao MongoDB:", error);
        return null; 
    }
}


// =========================================================================
// === FUNÇÕES DE CONFIGURAÇÃO (AGORA MONGODB) ===
// =========================================================================

// REMOVIDO: As variáveis JSONBIN_URL e JSONBIN_WRITE_URL

async function getBannerConfig() {
    // A estrutura de retorno continua a mesma: { specific_banners: {...} }
    const defaultFallback = { specific_banners: {} }; 
    const mongoDb = await connectToMongo();

    if (!mongoDb) {
        console.warn("MongoDB não conectado, usando fallback padrão.");
        return defaultFallback;
    }
    
    try {
        const collection = mongoDb.collection(collectionName);
        
        // Busca o documento único
        const configDocument = await collection.findOne({ _id: CONFIG_DOCUMENT_ID });
        
        if (configDocument) {
            return { specific_banners: configDocument.specific_banners || {} };
        } else {
            // Se não existir, cria o documento padrão
            await collection.insertOne({ 
                _id: CONFIG_DOCUMENT_ID, 
                specific_banners: {} 
            });
            return defaultFallback;
        }
    } catch (error) {
        console.error('Falha ao buscar estado de banners no MongoDB:', error.message);
        return defaultFallback; 
    }
}

// NOVA FUNÇÃO: Escreve ou atualiza o documento de configuração no MongoDB
async function updateBannerConfig(newConfig) {
    const mongoDb = await connectToMongo();

    if (!mongoDb) {
        throw new Error("Conexão com MongoDB indisponível para escrita.");
    }

    try {
        const collection = mongoDb.collection(collectionName);
        
        // Usa `updateOne` com `upsert: true` para garantir que o documento exista
        const result = await collection.updateOne(
            { _id: CONFIG_DOCUMENT_ID },
            { $set: newConfig }, 
            { upsert: true }
        );
        
        if (result.acknowledged) {
            return true;
        } else {
            throw new Error("MongoDB não reconheceu a operação de escrita.");
        }

    } catch (error) {
        console.error('Falha ao escrever no MongoDB:', error.message);
        throw error;
    }
}

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

        // 1. Upload para o Cloudinary
        const result = await cloudinary.uploader.upload(fileBase64, {
            folder: 'site_banners', // Pasta no Cloudinary
        });

        const newBannerUrl = result.secure_url;
        const newBannerPublicId = result.public_id; 

        // 2. Busca a configuração atual
        const currentConfig = await getBannerConfig();
        const newConfig = { ...currentConfig };
        
        // 3. Adiciona o novo banner: Padrão é 'random' e PRIORIDADE BAIXA (999)
        newConfig.specific_banners = newConfig.specific_banners || {};
        newConfig.specific_banners[newBannerUrl] = {
            publicId: newBannerPublicId,
            day: 'random', 
            priority: 999 
        }; 
        
        // 4. Salva a nova configuração no MONGODB (SUBSTITUI JSONBIN AQUI)
        await updateBannerConfig(newConfig);
        
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


// --- ROTA 1: API PARA OBTER OS BANNERS ATIVOS (CONSUMO DO CLIENTE) ---
// Não alterada, pois usa getBannerConfig()
app.get('/api/banners', async (req, res) => {
    
    const config = await getBannerConfig();
    const specificStatuses = config.specific_banners || {}; 
    
    const today = DateTime.local().setZone('America/Sao_Paulo').weekday.toString(); 
    
    let activeBanners = [];

    // 1. Processa Banners Genéricos (Cloudinary)
    Object.keys(specificStatuses).forEach(url => {
        const bannerConfig = specificStatuses[url];
        
        const isActive = bannerConfig && bannerConfig !== false; 
        
        if (isActive) {
            const dayToDisplay = bannerConfig.day || 'random'; 
            
            if (dayToDisplay === 'random' || dayToDisplay === today) {
                activeBanners.push({
                    url: url,
                    priority: bannerConfig.priority || 999 
                });
            }
        }
    });
    
    // 2. Ordena a lista de banners ativos pela prioridade (menor número = maior prioridade)
    activeBanners.sort((a, b) => a.priority - b.priority);

    // 3. Extrai apenas os URLs para a resposta final
    const finalBannerUrls = activeBanners.map(b => b.url);
    
    res.json({ 
        banners: [...new Set(finalBannerUrls)],
        debug: {
            currentDay: today,
            timezone: 'America/Sao_Paulo',
            numGenericosAtivos: finalBannerUrls.length 
        }
    });
});

// --- ROTA 2: API PARA OBTER LISTA COMPLETA DE BANNERS E STATUS (PAINEL) ---
// Não alterada, pois usa getBannerConfig()
app.get('/api/config/banners/list', async (req, res) => {
    const config = await getBannerConfig(); 
    const specificStatuses = config.specific_banners || {};
    
    let bannerList = [];

    // 1. Adiciona Banners Genéricos (lidos do JSON Bin/Cloudinary)
    Object.keys(specificStatuses).forEach(url => {
        const bannerConfig = specificStatuses[url];
        
        const isActive = bannerConfig && bannerConfig !== false; 
        
        const day = isActive ? (bannerConfig.day || 'random') : 'random'; 
        const priority = isActive ? (bannerConfig.priority || 999) : 999; 
        
        bannerList.push({
            fileName: url, 
            isDailyBanner: false, 
            isActive: isActive,
            day: day, 
            priority: priority 
        });
    });
    
    // Ordena a lista para exibição no painel pela prioridade
    bannerList.sort((a, b) => a.priority - b.priority);

    res.json({
        config: {}, 
        banners: bannerList
    });
});

// --- ROTA 3: API PARA ATUALIZAR CONFIGURAÇÃO (ESCRITA DO PAINEL) ---
app.put('/api/config/banners', async (req, res) => {
    
    const { file, active, day, priority } = req.body; 
    
    if (typeof active !== 'boolean' || !file) {
        return res.status(400).json({ success: false, error: 'O campo "active" deve ser booleano e "file" (URL) deve ser fornecido.' });
    }

    // REMOVIDO: As variáveis de URL e API Key do JSON Bin
    
    try {
        const currentConfig = await getBannerConfig();
        const newConfig = { ...currentConfig };
        
        newConfig.specific_banners = newConfig.specific_banners || {};
            
        const currentBannerConfig = currentConfig.specific_banners[file];
        
        const baseConfig = currentBannerConfig && currentBannerConfig !== false ? currentBannerConfig : {};

        if (active === true) {
            
            const publicId = baseConfig.publicId || 'unknown'; 
            
            newConfig.specific_banners[file] = {
                publicId: publicId,
                day: day || baseConfig.day || 'random', 
                priority: priority !== undefined ? priority : (baseConfig.priority || 999) 
            };
            
        } else {
            // DESATIVAR: Define explicitamente a chave (URL) como 'false'
            newConfig.specific_banners[file] = false;
        }

        // NOVO: Salva a nova configuração no MONGODB (SUBSTITUI JSONBIN AQUI)
        await updateBannerConfig(newConfig);

        // Retorna a nova config para confirmação
        const updatedConfig = newConfig.specific_banners[file] === false ? { day: baseConfig.day || 'random', priority: baseConfig.priority || 999 } : newConfig.specific_banners[file];

        res.json({ 
            success: true, 
            new_state: active, 
            banner_file: file, 
            new_day: updatedConfig.day,
            new_priority: updatedConfig.priority,
            message: `Configuração do banner ${file} atualizada com sucesso.` 
        });
    } catch (error) {
        console.error('Erro de escrita no MongoDB:', error);
        res.status(500).json({ success: false, error: `Falha interna ao salvar configuração: ${error.message}` });
    }
});

module.exports = app;