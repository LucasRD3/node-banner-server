// server.js (CONTROLE INDIVIDUAL POR ARQUIVO DINÂMICO COM CLOUDINARY)

const express = require('express');
const cors = require('cors'); 
const { DateTime } = require('luxon');
const fetch = require('node-fetch'); // Mantenho para consistência, mas o fetch aqui não será usado para 'jsonbin'
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
// === FUNÇÕES DE CONFIGURAÇÃO REMOTA (REDIS - SIMULAÇÃO) ===
// =========================================================================

// CHAVE DE CONFIGURAÇÃO PRINCIPAL NO REDIS
const REDIS_CONFIG_KEY = 'global_banner_config'; 

// Variável para simular o armazenamento em memória do Redis, 
// pois não tenho acesso ao seu Upstash.
let MOCK_REDIS_STORE = { specific_banners: {} }; 

// *** FUNÇÃO DE LEITURA (SIMULADA) ***
async function getBannerConfig() {
    const defaultFallback = { specific_banners: {} }; 
    
    // SUBSTITUA ISTO pela sua lógica real de leitura do Upstash.
    // Exemplo: const data = await redis.get(REDIS_CONFIG_KEY);
    // return data ? JSON.parse(data) : defaultFallback;
    
    // SIMULAÇÃO:
    console.log('SIMULAÇÃO REDIS: Lendo configuração...');
    return MOCK_REDIS_STORE || defaultFallback; 
}

// *** FUNÇÃO DE ESCRITA (SIMULADA) ***
async function writeBannerConfig(newConfig) {
    // SUBSTITUA ISTO pela sua lógica real de escrita no Upstash.
    // Exemplo: await redis.set(REDIS_CONFIG_KEY, JSON.stringify(newConfig));
    
    // SIMULAÇÃO:
    console.log('SIMULAÇÃO REDIS: Escrevendo configuração...');
    MOCK_REDIS_STORE = newConfig;
    return true;
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

        // 2. Busca a configuração atual (do Upstash)
        const currentConfig = await getBannerConfig();
        const newConfig = { ...currentConfig };
        
        // 3. Adiciona o novo banner: Padrão é 'random' e PRIORIDADE BAIXA (999)
        newConfig.specific_banners = newConfig.specific_banners || {};
        newConfig.specific_banners[newBannerUrl] = {
            publicId: newBannerPublicId,
            day: 'random', 
            priority: 999 // Prioridade baixa por padrão (aparecerá por último)
        }; 
        
        // 4. Salva a nova configuração no Upstash
        const redisWriteSuccess = await writeBannerConfig(newConfig);
        
        if (!redisWriteSuccess) {
            // Em um ambiente real, você faria o rollback da exclusão do Cloudinary
            throw new Error('Falha ao atualizar configuração no Redis após upload.');
        }

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

    // 1. Processa Banners Genéricos 
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

    // 1. Adiciona Banners Genéricos (lidos do Redis/Cloudinary)
    Object.keys(specificStatuses).forEach(url => {
        const bannerConfig = specificStatuses[url];
        
        const isActive = bannerConfig && bannerConfig !== false; 
        
        const day = isActive ? (bannerConfig.day || 'random') : 'random'; 
        const priority = isActive ? (bannerConfig.priority || 999) : 999; 
        const publicId = bannerConfig.publicId || 'unknown'; // Necessário para exclusão
        
        bannerList.push({
            fileName: url, 
            publicId: publicId, // Inclui o publicId no painel (não é exibido, mas é usado no frontend)
            isDailyBanner: false, 
            isActive: isActive,
            day: day, 
            priority: priority 
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
                // Prioriza o valor de 'day' enviado, senão o existente, senão 'random'
                day: day || baseConfig.day || 'random', 
                // Prioriza o valor de 'priority' enviado, senão o existente, senão 999
                priority: priority !== undefined ? priority : (baseConfig.priority || 999) 
            };
            
        } else {
            // DESATIVAR: Define explicitamente a chave (URL) como 'false'
            newConfig.specific_banners[file] = false;
        }


        const redisWriteSuccess = await writeBannerConfig(newConfig);

        if (!redisWriteSuccess) {
            throw new Error('Falha ao atualizar a configuração no Redis.');
        }

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

// --- NOVA ROTA 4: API PARA EXCLUIR BANNER PERMANENTEMENTE (PAINEL) ---
app.delete('/api/config/banners', async (req, res) => {
    
    const { file, publicId } = req.body; 
    
    if (!file || !publicId) {
        return res.status(400).json({ success: false, error: 'O "file" (URL) e o "publicId" são obrigatórios para exclusão.' });
    }

    try {
        // 1. Remove do Cloudinary
        const destroyResult = await cloudinary.uploader.destroy(publicId);
        
        if (destroyResult.result !== 'ok') {
            // Logar mas NÃO abortar, pois a exclusão da configuração do Redis é mais crítica
            console.warn(`Aviso: Falha na exclusão do Cloudinary para ${publicId}. Resultado: ${destroyResult.result}`);
        }
        
        // 2. Remove a entrada do Redis
        const currentConfig = await getBannerConfig();
        const newConfig = { ...currentConfig };
        
        if (newConfig.specific_banners && newConfig.specific_banners[file]) {
            delete newConfig.specific_banners[file];
            
            const redisWriteSuccess = await writeBannerConfig(newConfig);
            
            if (!redisWriteSuccess) {
                // Em um ambiente real, você não faria o rollback da exclusão do Cloudinary, apenas logaria o erro.
                throw new Error('Falha ao remover a configuração do banner do Redis.');
            }
        } else {
            console.warn(`Aviso: O banner ${file} não estava no Redis, mas a exclusão do Cloudinary foi tentada.`);
        }

        res.json({ 
            success: true, 
            message: `Banner ${file} e sua configuração foram excluídos permanentemente.`,
            cloudinary_result: destroyResult.result
        });
    } catch (error) {
        console.error('Erro na exclusão de banner (Cloudinary/Redis):', error);
        res.status(500).json({ success: false, error: `Falha interna ao excluir: ${error.message}` });
    }
});


module.exports = app;