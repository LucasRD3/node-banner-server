// server.js (CONTROLE INDIVIDUAL POR ARQUIVO DINÂMICO COM CLOUDINARY E UPSTASH)

const express = require('express');
const cors = require('cors'); 
const { DateTime } = require('luxon');
const fetch = require('node-fetch'); 
const cloudinary = require('cloudinary').v2;
const multer = require('multer');           
const app = express();

// NOVO: Importa o cliente Redis
const Redis = require('ioredis');

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
// === FUNÇÕES DE CONFIGURAÇÃO REMOTA (UPSTASH REDIS) ===
// =========================================================================

// CHAVE ÚNICA NO REDIS
const REDIS_KEY = 'BANNER_CONFIG';

// NOVO: Inicializa o cliente Redis com a URL do Upstash
// Note: Você deve configurar a variável de ambiente UPSTASH_REDIS_URL no Vercel
const redis = new Redis(process.env.UPSTASH_REDIS_URL); 

// FUNÇÃO PARA BUSCAR CONFIGURAÇÃO
async function getBannerConfig() {
    // Estrutura padrão que será salva/lida no Redis
    const defaultFallback = { specific_banners: {} }; 
    
    if (!process.env.UPSTASH_REDIS_URL) {
        console.error("Variável UPSTASH_REDIS_URL não está configurada.");
        return defaultFallback;
    }
    
    try {
        const configString = await redis.get(REDIS_KEY);
        
        if (configString) {
            return JSON.parse(configString);
        }
        
        // Se a chave não existir no Redis, inicializa com o fallback
        await saveBannerConfig(defaultFallback); 
        return defaultFallback;
        
    } catch (error) {
        console.error('Falha ao buscar estado de banners no Upstash Redis:', error.message);
        return defaultFallback; 
    }
}

// NOVO: FUNÇÃO PARA SALVAR CONFIGURAÇÃO
async function saveBannerConfig(configObject) {
    if (!process.env.UPSTASH_REDIS_URL) {
        throw new Error("Variável de ambiente UPSTASH_REDIS_URL não está configurada.");
    }
    try {
        // Salva o objeto JSON serializado no Redis
        await redis.set(REDIS_KEY, JSON.stringify(configObject));
        return true;
    } catch (error) {
        console.error('Falha ao salvar estado de banners no Upstash Redis:', error.message);
        throw new Error(`Falha ao atualizar Upstash Redis: ${error.message}`);
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

        // 2. Busca a configuração atual
        const currentConfig = await getBannerConfig();
        const newConfig = { ...currentConfig };
        
        // 3. Adiciona o novo banner
        newConfig.specific_banners = newConfig.specific_banners || {};
        newConfig.specific_banners[newBannerUrl] = {
            publicId: newBannerPublicId,
            day: 'random', 
            priority: 999 
        }; 
        
        // 4. Salva a nova configuração no Upstash Redis
        await saveBannerConfig(newConfig);

        res.json({ 
            success: true, 
            message: 'Banner enviado e ativado como Aleatório, com prioridade baixa (999)!', 
            url: newBannerUrl,
            publicId: newBannerPublicId
        });
        
    } catch (error) {
        console.error('Erro no upload para Cloudinary/Upstash:', error);
        res.status(500).json({ success: false, error: `Falha interna ao salvar configuração: ${error.message}` });
    }
});


// --- ROTA 1: API PARA OBTER OS BANNERS ATIVOS (CONSUMO DO CLIENTE) ---
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
    const config = await getBannerConfig(); 
    const specificStatuses = config.specific_banners || {};
    
    let bannerList = [];

    // 1. Adiciona Banners Genéricos (lidos do Redis/Cloudinary)
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


        // SALVA a nova configuração no Upstash Redis
        await saveBannerConfig(newConfig);

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
        console.error('Erro de escrita no Upstash Redis:', error);
        res.status(500).json({ success: false, error: `Falha interna ao salvar configuração: ${error.message}` });
    }
});


// --- ROTA 4: API PARA EXCLUSÃO DE BANNER (Cloudinary + Upstash Redis) ---
app.delete('/api/banners/delete', async (req, res) => {
    const { fileUrl, publicId } = req.body;
    
    if (!fileUrl || !publicId) {
        // Frontend corrigido garante que isso não deve ocorrer, mas mantemos a validação.
        return res.status(400).json({ success: false, error: 'URL e publicId do banner são obrigatórios para a deleção.' });
    }

    try {
        // 1. Deleção do Cloudinary
        const cloudinaryResult = await cloudinary.uploader.destroy(publicId);

        if (cloudinaryResult.result === 'not found') {
            console.warn(`Cloudinary: Banner com publicId ${publicId} não encontrado, mas será removido da configuração.`);
        } else if (cloudinaryResult.result !== 'ok' && cloudinaryResult.result !== 'not found') {
            throw new Error(`Cloudinary falhou: ${cloudinaryResult.result}`);
        }

        // 2. Busca e Atualiza a configuração no Upstash Redis
        const currentConfig = await getBannerConfig();
        const newConfig = { ...currentConfig };
        
        // Remove a entrada da configuração usando a URL (chave)
        if (newConfig.specific_banners && newConfig.specific_banners[fileUrl]) {
            delete newConfig.specific_banners[fileUrl];
        } else {
            console.warn(`Banner com URL ${fileUrl} não encontrado na configuração, mas continua a deleção.`);
        }
        
        // 3. Salva a nova configuração no Upstash Redis
        await saveBannerConfig(newConfig);

        res.json({ success: true, message: `Banner ${publicId} excluído com sucesso do Cloudinary e da lista.` });
        
    } catch (error) {
        console.error('Erro na exclusão do banner:', error);
        // O erro original "Falha ao atualizar JSON Bin" agora será um erro de Upstash, se ocorrer.
        res.status(500).json({ success: false, error: `Falha interna ao deletar banner: ${error.message}` });
    }
});


module.exports = app;