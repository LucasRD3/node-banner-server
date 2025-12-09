// server.js (AGORA USANDO UPSTASH REDIS EM VEZ DE JSONBIN)

const express = require('express');
const cors = require('cors'); 
const { DateTime } = require('luxon');
const fetch = require('node-fetch'); // Mantido, mas não usado para o estado
const cloudinary = require('cloudinary').v2;
const multer = require('multer');           
const Redis = require('ioredis'); // NOVO: Importa ioredis
const app = express();

app.use(express.json()); 
app.use(cors()); 

// =========================================================================
// === CONFIGURAÇÃO UPSTASH REDIS ===
// =========================================================================

// Conecta ao Upstash usando a URL completa (process.env.REDIS_URL deve ser definido no Vercel)
const redisClient = new Redis(process.env.REDIS_URL); 

// Chave única onde o objeto de configuração JSON será armazenado no Redis
const REDIS_CONFIG_KEY = 'global:banner_config_state';

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
// === FUNÇÕES DE CONFIGURAÇÃO REMOTA (REDIS) ===
// =========================================================================

/**
 * Busca a configuração de banners do Redis.
 * @returns {Promise<{specific_banners: Object}>} Configuração atual.
 */
async function getBannerConfig() {
    const defaultFallback = { specific_banners: {} }; 
    
    try {
        // 1. Pega a string JSON do Redis
        const configString = await redisClient.get(REDIS_CONFIG_KEY);
        
        if (configString) {
            // 2. Converte a string de volta para objeto
            const data = JSON.parse(configString);
            return { 
                specific_banners: data.specific_banners || {} 
            }; 
        }
        
        // 3. Se não houver dados, retorna o fallback e salva (inicia) no Redis
        await setBannerConfig(defaultFallback);
        return defaultFallback; 
    } catch (error) {
        console.error('Falha ao buscar estado de banners no Redis:', error.message);
        return defaultFallback; 
    }
}

/**
 * Salva a nova configuração no Redis.
 * @param {Object} config - O objeto de configuração a ser salvo.
 * @returns {Promise<void>}
 */
async function setBannerConfig(config) {
    try {
        // 1. Converte o objeto de configuração para string JSON
        const configString = JSON.stringify(config);
        
        // 2. Salva a string no Redis
        await redisClient.set(REDIS_CONFIG_KEY, configString);
        
    } catch (error) {
        console.error('Falha ao salvar estado de banners no Redis:', error.message);
        throw new Error('Falha ao salvar configuração no banco de dados.'); 
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
        
        // 4. Salva a nova configuração no REDIS
        await setBannerConfig(newConfig);

        res.json({ 
            success: true, 
            message: 'Banner enviado e ativado como Aleatório, com prioridade baixa (999)!', 
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
    
    const config = await getBannerConfig();
    const specificStatuses = config.specific_banners || {}; 
    
    const today = DateTime.local().setZone('America/Sao_Paulo').weekday.toString(); 
    
    let activeBanners = [];

    // 1. Processa Banners Genéricos (Cloudinary)
    Object.keys(specificStatuses).forEach(url => {
        const bannerConfig = specificStatuses[url];
        
        // Verifica se é um objeto de configuração (formato novo) e se está ativo (não é false)
        const isActive = bannerConfig && bannerConfig !== false; 
        
        if (isActive) {
            const dayToDisplay = bannerConfig.day || 'random'; 
            
            // Ativo se for 'random' OU o dia configurado for o dia de hoje
            if (dayToDisplay === 'random' || dayToDisplay === today) {
                activeBanners.push({
                    url: url,
                    priority: bannerConfig.priority || 999 // Usa prioridade salva ou 999
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
app.get('/api/config/banners/list', async (req, res) => {
    const config = await getBannerConfig(); 
    const specificStatuses = config.specific_banners || {};
    
    let bannerList = [];

    // 1. Adiciona Banners Genéricos (lidos do Cloudinary/Redis)
    Object.keys(specificStatuses).forEach(url => {
        const bannerConfig = specificStatuses[url];
        
        const isActive = bannerConfig && bannerConfig !== false; 
        
        const day = isActive ? (bannerConfig.day || 'random') : 'random'; 
        const priority = isActive ? (bannerConfig.priority || 999) : 999; 
        const publicId = isActive ? (bannerConfig.publicId || 'unknown') : (bannerConfig && bannerConfig.publicId ? bannerConfig.publicId : 'unknown'); 
        
        bannerList.push({
            fileName: url, 
            isDailyBanner: false, 
            isActive: isActive,
            day: day, 
            priority: priority, 
            publicId: publicId // Passa o publicId para o frontend usar na deleção
        });
    });
    
    // Ordena a lista para exibição no painel pela prioridade (1º a 999º)
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
        
        // Se a configuração atual for 'false' (desativado no formato antigo), tratamos como objeto vazio
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

        // SALVA NO REDIS
        await setBannerConfig(newConfig);

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
        console.error('Erro de escrita no Redis:', error);
        res.status(500).json({ success: false, error: `Falha interna ao salvar configuração: ${error.message}` });
    }
});

// --- ROTA 4: API PARA DELETAR BANNER (Deleta do Cloudinary e do Redis) ---
app.delete('/api/banners/delete', async (req, res) => {
    const { url, publicId } = req.body; // Recebe a URL e o Public ID

    if (!url || !publicId) {
        return res.status(400).json({ success: false, error: 'URL e publicId do banner são obrigatórios para a deleção.' });
    }

    try {
        // 1. Deleta a imagem do Cloudinary
        const cloudinaryResult = await cloudinary.uploader.destroy(publicId);
        
        if (cloudinaryResult.result !== 'ok' && cloudinaryResult.result !== 'not found') {
            console.warn(`Aviso: Cloudinary retornou: ${cloudinaryResult.result} para ${publicId}`);
            // Continuamos, pois o principal é remover do Redis
        }
        
        // 2. Remove a referência do Redis
        const currentConfig = await getBannerConfig();
        
        if (currentConfig.specific_banners && currentConfig.specific_banners[url]) {
            delete currentConfig.specific_banners[url]; // Remove a chave (URL) do objeto
            
            // 3. Salva a nova configuração (sem o banner) no Redis
            await setBannerConfig(currentConfig);
        } else {
            console.warn(`Banner ${url} não encontrado na configuração do Redis.`);
        }

        res.json({ 
            success: true, 
            message: `Banner ${publicId} deletado do Cloudinary e removido da configuração do Redis.`,
            cloudinaryStatus: cloudinaryResult.result
        });

    } catch (error) {
        console.error('Erro ao deletar banner (Cloudinary/Redis):', error);
        res.status(500).json({ success: false, error: `Falha interna ao deletar banner: ${error.message}` });
    }
});


module.exports = app;