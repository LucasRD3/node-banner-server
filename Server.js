// server.js (CONTROLE INDIVIDUAL POR ARQUIVO DINÂMICO COM CLOUDINARY)

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
// === FUNÇÕES DE CONFIGURAÇÃO REMOTA (JSONBIN) ===
// =========================================================================

const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_BIN_ID}/latest`;
const JSONBIN_WRITE_URL = `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_BIN_ID}`;

async function getBannerConfig() {
    // MODIFICADO: Estrutura simplificada, sem banners diários
    const defaultFallback = { specific_banners: {} }; 
    
    if (!process.env.JSONBIN_BIN_ID) {
        return defaultFallback;
    }
    
    try {
        const response = await fetch(JSONBIN_URL);
        const data = await response.json();
        
        return data.record ? { 
            specific_banners: data.record.specific_banners || {} 
        } : defaultFallback; 
    } catch (error) {
        console.error('Falha ao buscar estado de banners no JSON Bin:', error.message);
        return defaultFallback; 
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
            priority: 999 // NOVO: Prioridade baixa por padrão (aparecerá por último)
        }; 
        
        // 4. Salva a nova configuração no JSON Bin
        const jsonBinResponse = await fetch(JSONBIN_WRITE_URL, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': process.env.JSONBIN_MASTER_KEY 
            },
            body: JSON.stringify(newConfig)
        });
        
        if (!jsonBinResponse.ok) {
            const errorBody = await jsonBinResponse.text();
            throw new Error(`Falha ao atualizar JSON Bin após upload. Status: ${jsonBinResponse.status}. Body: ${errorBody}`);
        }

        res.json({ 
            success: true, 
            message: 'Banner enviado e ativado como Aleatório, com prioridade baixa (999)!', 
            url: newBannerUrl,
            publicId: newBannerPublicId
        });
        
    } catch (error) {
        console.error('Erro no upload para Cloudinary/JSON Bin:', error);
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

    // 1. Adiciona Banners Genéricos (lidos do JSON Bin/Cloudinary)
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

    const url = JSONBIN_WRITE_URL; 
    const apiKey = process.env.JSONBIN_MASTER_KEY; 
    
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


        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': process.env.JSONBIN_MASTER_KEY 
            },
            body: JSON.stringify(newConfig) 
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Falha ao atualizar JSON Bin. Status: ${response.status}. Body: ${errorBody}`);
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
        console.error('Erro de escrita no JSON Bin:', error);
        res.status(500).json({ success: false, error: `Falha interna ao salvar configuração: ${error.message}` });
    }
});

// --- ROTA 4: API PARA DELETAR BANNER PERMANENTEMENTE (NOVA) ---
app.delete('/api/config/banners/:encodedUrl', async (req, res) => {
    
    // Decodifica a URL para obter o fileUrl original
    const fileUrl = decodeURIComponent(req.params.encodedUrl);
    
    if (!fileUrl) {
        return res.status(400).json({ success: false, error: 'URL do banner não fornecida.' });
    }

    try {
        // 1. Busca a configuração atual para obter o publicId
        const currentConfig = await getBannerConfig();
        const newConfig = { ...currentConfig };
        
        const bannerConfig = newConfig.specific_banners[fileUrl];
        
        if (!bannerConfig || bannerConfig === false) {
            // Se não encontrar ou já estiver marcado como false, apenas remove do JSON Bin se existir a chave
            if (newConfig.specific_banners.hasOwnProperty(fileUrl)) {
                delete newConfig.specific_banners[fileUrl];
            }
            // Não há o que deletar no Cloudinary se a config não existir
            // Prossegue para salvar a configuração limpa
            return res.json({ 
                success: true, 
                message: 'Banner não encontrado na configuração. Configuração limpa (se existia a chave).' 
            });
        }
        
        const publicId = bannerConfig.publicId;

        // 2. Deleta o arquivo no Cloudinary
        if (publicId && publicId !== 'unknown') {
            const deleteResult = await cloudinary.uploader.destroy(publicId);
            
            if (deleteResult.result !== 'ok' && deleteResult.result !== 'not found') {
                console.warn(`Aviso: Falha ao deletar no Cloudinary, mas continuará a remoção da config. Resultado: ${deleteResult.result}`);
            }
        }

        // 3. Remove a entrada da configuração do JSON Bin
        delete newConfig.specific_banners[fileUrl];

        // 4. Salva a nova configuração (sem o banner) no JSON Bin
        const jsonBinResponse = await fetch(JSONBIN_WRITE_URL, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': process.env.JSONBIN_MASTER_KEY 
            },
            body: JSON.stringify(newConfig)
        });
        
        if (!jsonBinResponse.ok) {
            const errorBody = await jsonBinResponse.text();
            throw new Error(`Falha ao atualizar JSON Bin após deleção. Status: ${jsonBinBinResponse.status}. Body: ${errorBody}`);
        }

        res.json({ 
            success: true, 
            message: `Banner ${fileUrl.substring(fileUrl.lastIndexOf('/') + 1)} deletado permanentemente.`
        });
        
    } catch (error) {
        console.error('Erro na deleção do banner:', error);
        res.status(500).json({ success: false, error: `Falha interna ao deletar banner: ${error.message}` });
    }
});


module.exports = app;