// server.js (CONTROLE INDIVIDUAL POR ARQUIVO DINÂMICO COM CLOUDINARY)

const express = require('express');
// const path = require('path'); // REMOVIDO: Não mais necessário para ler arquivos locais
// const fs = require('fs');     // REMOVIDO: Não mais necessário para ler arquivos locais
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
    // MODIFICADO: O fallback deve refletir a nova estrutura (apenas specific_banners e seus dias)
    const defaultFallback = { specific_banners: {} }; 
    
    if (!process.env.JSONBIN_BIN_ID) {
        return defaultFallback;
    }
    
    try {
        const response = await fetch(JSONBIN_URL);
        const data = await response.json();
        
        // Assegura que o retorno sempre tenha a estrutura esperada e não a flag daily_banners_active
        return data.record ? { 
            specific_banners: data.record.specific_banners || {} 
        } : defaultFallback; 
    } catch (error) {
        console.error('Falha ao buscar estado de banners no JSON Bin, assumindo ATIVO:', error.message);
        return defaultFallback; 
    }
}

// Funções para manipulação da configuração no JSON Bin
// ... (upload e outros métodos que usam getBannerConfig)

// =========================================================================
// === ROTAS DA API ===
// =========================================================================

// --- NOVO: ROTA PARA UPLOAD DE BANNER (Cloudinary) ---
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
        
        // 3. Adiciona o novo banner (URL) como chave no JSON Bin, mapeando para um objeto de status/dia
        newConfig.specific_banners = newConfig.specific_banners || {};
        // NOVO: Adiciona o banner com status 'ativo' e dia 'random' por padrão
        newConfig.specific_banners[newBannerUrl] = {
            publicId: newBannerPublicId,
            day: 'random' // Novo banner é 'random' por padrão
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
            message: 'Banner enviado e ativado como Aleatório!', // Mensagem atualizada
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
    
    const today = DateTime.local().setZone('America/Sao_Paulo').weekday.toString(); // Dia da semana (1 a 7, como string)
    let finalBannerUrls = [];

    // 1. Processa Banners Genéricos (Cloudinary)
    Object.keys(specificStatuses).forEach(url => {
        const bannerConfig = specificStatuses[url];
        
        // Verifica se é um objeto de configuração (formato novo) e se está ativo (não é false)
        const isActive = bannerConfig && bannerConfig !== false; 
        
        if (isActive) {
            // Verifica o dia de exibição
            const dayToDisplay = bannerConfig.day || 'random'; // Padrão: 'random'
            
            // Ativo se for 'random' OU o dia configurado for o dia de hoje
            if (dayToDisplay === 'random' || dayToDisplay === today) {
                finalBannerUrls.push(url);
            }
        }
    });
    
    // Embaralha a lista (opcional, mas recomendado para banners 'random')
    // for (let i = finalBannerUrls.length - 1; i > 0; i--) {
    //     const j = Math.floor(Math.random() * (i + 1));
    //     [finalBannerUrls[i], finalBannerUrls[j]] = [finalBannerUrls[j], finalBannerUrls[i]];
    // }
    
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
    // REMOVIDO: leitura de disco e banners diários
    const config = await getBannerConfig(); 
    const specificStatuses = config.specific_banners || {};
    
    let bannerList = [];

    // 1. Adiciona Banners Genéricos (lidos do JSON Bin/Cloudinary)
    // As chaves são os URLs completos do Cloudinary.
    Object.keys(specificStatuses).forEach(url => {
        const bannerConfig = specificStatuses[url];
        
        // Verifica se o valor é um objeto (novo formato) ou false (antigo desativado)
        const isActive = bannerConfig && bannerConfig !== false; 
        
        // O dia é 'random' se não estiver definido
        const day = isActive ? (bannerConfig.day || 'random') : 'random'; 
        
        bannerList.push({
            fileName: url, 
            isDailyBanner: false, // Sempre false agora
            isActive: isActive,
            day: day // Novo campo 'day'
        });
    });

    res.json({
        config: {
            // REMOVIDO: daily_banners_active
        },
        banners: bannerList
    });
});

// --- ROTA 3: API PARA ATUALIZAR CONFIGURAÇÃO (ESCRITA DO PAINEL) ---
// Agora lida com 'active' e 'day'
app.put('/api/config/banners', async (req, res) => {
    
    // Espera { "file": "url_do_cloudinary", "active": true | false, "day": "1" | "random" | ... }
    const { file, active, day } = req.body; 
    
    if (typeof active !== 'boolean' || !file) {
        return res.status(400).json({ success: false, error: 'O campo "active" deve ser booleano e "file" (URL) deve ser fornecido.' });
    }

    const url = JSONBIN_WRITE_URL; 
    const apiKey = process.env.JSONBIN_MASTER_KEY; 
    
    try {
        const currentConfig = await getBannerConfig();
        const newConfig = { ...currentConfig };
        
        // O "file" aqui é o URL do Cloudinary
        newConfig.specific_banners = newConfig.specific_banners || {};
            
        // Pega a configuração atual para preservar o publicId
        const currentBannerConfig = currentConfig.specific_banners[file];
        
        if (active === true) {
            // ATIVAR: Preserva o publicId e define o dia (se fornecido)
            
            // O publicId deve vir da config atual (se o banner já existia) ou ser 'uploaded' (se o upload acabou de ocorrer)
            const publicId = (currentBannerConfig && currentBannerConfig.publicId) || 'unknown'; 
            
            newConfig.specific_banners[file] = {
                publicId: publicId,
                // Preserva o dia existente, ou usa o dia novo (se fornecido), ou 'random' se for ativação
                day: day || (currentBannerConfig ? currentBannerConfig.day : 'random') 
            };
            
        } else {
            // DESATIVAR: Define explicitamente a chave (URL) como 'false'
            newConfig.specific_banners[file] = false;
        }


        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': apiKey 
            },
            body: JSON.stringify(newConfig) 
        });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`Falha ao atualizar JSON Bin. Status: ${response.status}. Body: ${errorBody}`);
        }

        res.json({ 
            success: true, 
            new_state: active, 
            banner_file: file, 
            message: `Estado e/ou dia do banner ${file} atualizado com sucesso.` 
        });
    } catch (error) {
        console.error('Erro de escrita no JSON Bin:', error);
        res.status(500).json({ success: false, error: `Falha interna ao salvar configuração: ${error.message}` });
    }
});

module.exports = app;