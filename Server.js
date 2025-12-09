// server.js (CONTROLE INDIVIDUAL POR ARQUIVO DINÂMICO COM CLOUDINARY E UPSTASH REDIS)

const express = require('express');
const cors = require('cors'); 
const { DateTime } = require('luxon');
// const fetch = require('node-fetch'); // Não é mais necessário
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const Redis = require('ioredis'); // Necessário para Upstash/Redis
          
const app = express();

app.use(express.json()); 
app.use(cors()); 

// --- CONFIGURAÇÃO CLOUDINARY ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// --- CONFIGURAÇÃO UPSTASH REDIS ---
const REDIS_KEY = 'banner_config'; 
let redis;

if (process.env.REDIS_URL) {
    // ioredis pode se conectar usando o URL completo do Upstash (ex: redis://:password@host:port)
    redis = new Redis(process.env.REDIS_URL);
    
    redis.on('error', (err) => {
        console.error('Erro de conexão com o Redis/Upstash:', err);
    });
    
    // Teste de conexão (opcional)
    redis.ping().then(() => {
        console.log('Conexão com Upstash Redis estabelecida com sucesso.');
    }).catch(err => {
        console.error('Falha ao fazer PING no Redis:', err.message);
    });
    
} else {
    console.warn('Variável de ambiente REDIS_URL não definida. A persistência de banners não funcionará.');
}


// Configuração do Multer
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// =========================================================================
// === FUNÇÕES DE PERSISTÊNCIA (REDIS) ===
// =========================================================================

const defaultFallback = { specific_banners: {} }; 

/**
 * Busca a configuração de banners serializada no Redis.
 * @returns {object} O objeto de configuração.
 */
async function getBannerConfig() {
    if (!redis) return defaultFallback;
    
    try {
        const data = await redis.get(REDIS_KEY);
        if (data) {
            const config = JSON.parse(data);
            return { 
                specific_banners: config.specific_banners || {} 
            };
        }
        return defaultFallback;
    } catch (error) {
        console.error('Falha ao buscar estado de banners no Redis:', error.message);
        return defaultFallback; 
    }
}

/**
 * Salva a nova configuração de banners no Redis.
 * @param {object} config O objeto de configuração a ser salvo.
 * @returns {boolean} Sucesso da operação.
 */
async function setBannerConfig(config) {
    if (!redis) return false;
    
    try {
        await redis.set(REDIS_KEY, JSON.stringify(config));
        return true;
    } catch (error) {
        console.error('Falha ao salvar estado de banners no Redis:', error.message);
        return false;
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
            folder: 'site_banners', 
        });

        const newBannerUrl = result.secure_url;
        const newBannerPublicId = result.public_id; 

        // 2. Busca a configuração atual (via Redis)
        const currentConfig = await getBannerConfig();
        const newConfig = { ...currentConfig };
        
        // 3. Adiciona o novo banner: Padrão é 'random' e PRIORIDADE BAIXA (999)
        newConfig.specific_banners = newConfig.specific_banners || {};
        newConfig.specific_banners[newBannerUrl] = {
            publicId: newBannerPublicId,
            day: 'random', 
            priority: 999 
        }; 
        
        // 4. Salva a nova configuração no Redis
        const saveSuccess = await setBannerConfig(newConfig);
        
        if (!saveSuccess) {
            // Em caso de falha no Redis, o upload do Cloudinary é mantido, mas a config falha.
            throw new Error('Falha ao salvar a configuração de banner no Upstash Redis.');
        }

        res.json({ 
            success: true, 
            message: 'Banner enviado para Cloudinary e ativado como Aleatório no Redis!', 
            url: newBannerUrl,
            publicId: newBannerPublicId
        });
        
    } catch (error) {
        console.error('Erro no upload para Cloudinary/Redis:', error);
        res.status(500).json({ success: false, error: `Falha interna ao salvar configuração: ${error.message}` });
    }
});


// --- ROTA 1: API PARA OBTER OS BANNERS ATIVOS (CONSUMO DO CLIENTE) ---
app.get('/api/banners', async (req, res) => {
    
    const config = await getBannerConfig(); // Lendo do Redis
    const specificStatuses = config.specific_banners || {}; 
    
    const today = DateTime.local().setZone('America/Sao_Paulo').weekday.toString(); 
    
    let activeBanners = [];

    // 1. Processa Banners Genéricos
    Object.keys(specificStatuses).forEach(url => {
        const bannerConfig = specificStatuses[url];
        
        const isActive = bannerConfig && bannerConfig !== false; 
        
        if (isActive) {
            const dayToDisplay = bannerConfig.day || 'random'; 
            
            // Ativo se for 'random' OU o dia configurado for o dia de hoje
            if (dayToDisplay === 'random' || dayToDisplay === today) {
                activeBanners.push({
                    url: url,
                    priority: bannerConfig.priority || 999 
                });
            }
        }
    });
    
    // 2. Ordena a lista de banners ativos pela prioridade
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
app.get('/api/config/banners/list', async (req, res) => {
    const config = await getBannerConfig(); // Lendo do Redis
    const specificStatuses = config.specific_banners || {};
    
    let bannerList = [];

    // 1. Adiciona Banners Genéricos (lidos do Redis)
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
    
    // 2. Ordena a lista para exibição no painel pela prioridade
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
    
    try {
        const currentConfig = await getBannerConfig(); // Lendo do Redis
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

        const saveSuccess = await setBannerConfig(newConfig); // Escrevendo no Redis
        
        if (!saveSuccess) {
            throw new Error('Falha ao atualizar a configuração de banner no Upstash Redis.');
        }

        // Retorna a nova config para confirmação
        const updatedConfig = newConfig.specific_banners[file] === false ? { day: baseConfig.day || 'random', priority: baseConfig.priority || 999 } : newConfig.specific_banners[file];

        res.json({ 
            success: true, 
            new_state: active, 
            banner_file: file, 
            new_day: updatedConfig.day,
            new_priority: updatedConfig.priority,
            message: `Configuração do banner ${file} atualizada com sucesso no Redis.` 
        });
    } catch (error) {
        console.error('Erro de escrita no Redis:', error);
        res.status(500).json({ success: false, error: `Falha interna ao salvar configuração: ${error.message}` });
    }
});

module.exports = app;