// server.js (ADAPTADO PARA UPSTASH REDIS REST API)

const express = require('express');
const cors = require('cors'); 
const { DateTime } = require('luxon');
const fetch = require('node-fetch'); 
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
// === FUNÇÕES DE CONFIGURAÇÃO REMOTA (UPSTASH REDIS) ===
// =========================================================================

// CHAVE ÚNICA para armazenar o objeto de configuração dos banners no Redis
const REDIS_BANNER_KEY = 'global_banner_config'; 

// URL BASE para a API REST do Upstash
const UPSTASH_BASE_URL = process.env.UPSTASH_REDIS_REST_URL; 
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN; 

/**
 * Executa um comando Redis (GET, SET) via API REST do Upstash.
 * @param {string} command - O comando Redis a executar (ex: 'GET', 'SET', 'JSON.SET').
 * @param {Array<any>} args - Argumentos do comando Redis.
 */
async function executeRedisCommand(command, args) {
    if (!UPSTASH_BASE_URL || !UPSTASH_TOKEN) {
        throw new Error('As variáveis UPSTASH_REDIS_REST_URL ou UPSTASH_REDIS_REST_TOKEN não estão configuradas.');
    }
    
    // O formato da requisição da API REST do Upstash é [comando, arg1, arg2, ...]
    const body = [command, ...args];

    try {
        const response = await fetch(UPSTASH_BASE_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${UPSTASH_TOKEN}` // Autenticação via Token
            },
            body: JSON.stringify(body)
        });

        // O Upstash retorna um JSON que contém a chave 'result'
        const data = await response.json();

        if (response.status !== 200 || data.error) {
            throw new Error(data.error || `Falha no Upstash: Status ${response.status}`);
        }
        
        return data.result;

    } catch (error) {
        console.error('Falha ao executar comando Upstash Redis:', error.message);
        throw error; // Re-lança para ser capturado pela função de chamada
    }
}


/**
 * Busca a configuração de banners do Redis.
 */
async function getBannerConfig() {
    // MODIFICADO: Estrutura simplificada, sem banners diários
    const defaultFallback = { specific_banners: {} }; 
    
    try {
        // 1. Executa o comando GET com a chave de configuração
        const resultString = await executeRedisCommand('GET', [REDIS_BANNER_KEY]);
        
        if (!resultString) {
             // Retorna o fallback se a chave não existir no Redis (primeira vez)
            return defaultFallback;
        }
        
        // 2. Parsa o JSON (o Redis armazena como string)
        const record = JSON.parse(resultString);
        
        return { 
            specific_banners: record.specific_banners || {} 
        }; 
        
    } catch (error) {
        console.error('Falha ao buscar estado de banners no Upstash Redis:', error.message);
        // Retorna o fallback em caso de erro de rede ou parsing
        return defaultFallback; 
    }
}

/**
 * Salva a nova configuração no Redis.
 */
async function saveBannerConfig(newConfig) {
     // 1. Converte o objeto de configuração em string JSON
    const configString = JSON.stringify(newConfig);

    // 2. Executa o comando SET no Redis com a chave e a string JSON
    const result = await executeRedisCommand('SET', [REDIS_BANNER_KEY, configString]);
    
    // O comando SET retorna "OK" em caso de sucesso
    if (result !== 'OK') {
        throw new Error(`Falha ao salvar configuração no Upstash. Resposta: ${result}`);
    }
    
    return true;
}

// =========================================================================
// === ROTAS DA API (APENAS A LÓGICA DE PERSISTÊNCIA MUDOU) ===
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
            priority: 999 // NOVO: Prioridade baixa por padrão (aparecerá por último)
        }; 
        
        // 4. Salva a nova configuração no UPSTASH (SUBSTITUI JSON BIN)
        await saveBannerConfig(newConfig); 
        // --- FIM DA MUDANÇA ---

        res.json({ 
            success: true, 
            message: 'Banner enviado e ativado como Aleatório, com prioridade baixa (999)!', 
            url: newBannerUrl,
            publicId: newBannerPublicId
        });
        
    } catch (error) {
        console.error('Erro no upload para Cloudinary/Upstash:', error);
        // Garante que o erro do Redis também é reportado
        res.status(500).json({ success: false, error: `Falha interna ao salvar configuração: ${error.message}` });
    }
});


// --- ROTA 1: API PARA OBTER OS BANNERS ATIVOS (CONSUMO DO CLIENTE) ---
// **Não precisa de alterações** pois usa getBannerConfig() que foi atualizada.
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
// **Não precisa de alterações** pois usa getBannerConfig() que foi atualizada.
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

        // 1. Salva a nova configuração no UPSTASH (SUBSTITUI JSON BIN)
        await saveBannerConfig(newConfig);
        // --- FIM DA MUDANÇA ---
        
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

module.exports = app;