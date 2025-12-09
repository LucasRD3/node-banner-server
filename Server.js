// server.js (CONTROLE INDIVIDUAL POR ARQUIVO DINÂMICO COM CLOUDINARY E UPSTASH)

const express = require('express');
const cors = require('cors'); 
const { DateTime } = require('luxon');
const fetch = require('node-fetch'); // Mantido para simular a chamada à API REST do Upstash
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
// === FUNÇÕES DE CONFIGURAÇÃO REMOTA (UPSTASH/REDIS) ===
// =========================================================================

// CHAVE PRINCIPAL NO REDIS ONDE O JSON DE CONFIGURAÇÃO SERÁ ARMAZENADO
const REDIS_CONFIG_KEY = 'banner_config'; 
const UPSTASH_REDIS_URL = process.env.UPSTASH_REDIS_REST_URL; 
const UPSTASH_REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

/**
 * Executa um comando Redis via API REST do Upstash.
 * @param {string} command - O comando Redis (ex: 'GET', 'SET').
 * @param {string[]} args - Array de argumentos do comando.
 * @returns {Promise<any>} O resultado da API do Upstash.
 */
async function redisCommand(command, args = []) {
    if (!UPSTASH_REDIS_URL || !UPSTASH_REDIS_TOKEN) {
        throw new Error("Variáveis de ambiente UPSTASH_REDIS_REST_URL ou UPSTASH_REDIS_REST_TOKEN não configuradas.");
    }
    
    // Constrói a URL para o comando
    const url = `${UPSTASH_REDIS_URL}/${command}/${args.map(arg => encodeURIComponent(arg)).join('/')}`;
    
    const response = await fetch(url, {
        method: 'GET', // Upstash REST API usa GET para comandos, mesmo para SET
        headers: {
            'Authorization': `Bearer ${UPSTASH_REDIS_TOKEN}`
        }
    });

    const data = await response.json();
    
    if (!response.ok || data.error) {
        throw new Error(`Upstash Command Failed (${command}): ${data.error || response.statusText}`);
    }
    
    return data.result; // Retorna o resultado do comando
}


async function getBannerConfig() {
    const defaultFallback = { specific_banners: {} }; 
    
    try {
        // 1. GET da configuração atual
        const result = await redisCommand('GET', [REDIS_CONFIG_KEY]);
        
        if (result) {
            // O resultado do GET é uma string JSON
            const data = JSON.parse(result);
            return { 
                specific_banners: data.specific_banners || {} 
            };
        }
        
        return defaultFallback; 
    } catch (error) {
        console.error('Falha ao buscar estado de banners no Upstash/Redis:', error.message);
        return defaultFallback; 
    }
}

async function saveBannerConfig(config) {
    // 1. Converte o objeto de configuração para string JSON
    const jsonString = JSON.stringify(config);
    
    // 2. SET da nova configuração no Redis
    const result = await redisCommand('SET', [REDIS_CONFIG_KEY, jsonString]);
    
    // No Upstash SET retorna 'OK' em caso de sucesso
    if (result !== 'OK') {
        throw new Error(`Falha ao salvar configuração no Upstash. Resultado: ${result}`);
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
        
        // 4. Salva a nova configuração no Upstash/Redis
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
    
    // 2. NOVO: Ordena a lista de banners ativos pela prioridade (menor número = maior prioridade)
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

    // 1. Adiciona Banners Genéricos (lidos do Upstash/Cloudinary)
    Object.keys(specificStatuses).forEach(url => {
        const bannerConfig = specificStatuses[url];
        
        const isActive = bannerConfig && bannerConfig !== false; 
        
        const day = isActive ? (bannerConfig.day || 'random') : 'random'; 
        // NOVO: Adiciona o campo priority
        const priority = isActive ? (bannerConfig.priority || 999) : 999; 
        
        bannerList.push({
            fileName: url, 
            isDailyBanner: false, 
            isActive: isActive,
            day: day, 
            priority: priority // NOVO: Campo de Prioridade
        });
    });
    
    // NOVO: Ordena a lista para exibição no painel pela prioridade (1º a 999º)
    bannerList.sort((a, b) => a.priority - b.priority);

    res.json({
        config: {}, // Sem daily_banners_active
        banners: bannerList
    });
});

// --- ROTA 3: API PARA ATUALIZAR CONFIGURAÇÃO (ESCRITA DO PAINEL) ---
// Agora lida com 'active', 'day' e 'priority'
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
                // NOVO: Prioriza o valor de 'day' enviado, senão o existente, senão 'random'
                day: day || baseConfig.day || 'random', 
                // NOVO: Prioriza o valor de 'priority' enviado, senão o existente, senão 999
                priority: priority !== undefined ? priority : (baseConfig.priority || 999) 
            };
            
        } else {
            // DESATIVAR: Define explicitamente a chave (URL) como 'false'
            newConfig.specific_banners[file] = false;
        }

        // Salva a nova configuração no Upstash/Redis
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
        console.error('Erro de escrita no Upstash/Redis:', error);
        res.status(500).json({ success: false, error: `Falha interna ao salvar configuração: ${error.message}` });
    }
});

module.exports = app;