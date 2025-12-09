// Server.js (CONTROLE INDIVIDUAL POR ARQUIVO DINÂMICO COM CLOUDINARY)

const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors'); 
const { DateTime } = require('luxon');
const fetch = require('node-fetch'); 
const cloudinary = require('cloudinary').v2;
const multer = require('multer');           
const app = express();

app.use(express.json()); 
app.use(cors()); 
// Mantém o acesso estático para os banners diários (que ainda estão no disco)
app.use(express.static(path.join(__dirname, 'banners'))); 

// --- CONFIGURAÇÃO CLOUDINARY (Lê as Variáveis de Ambiente) ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configuração do Multer: Armazena o arquivo na memória temporariamente
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- Mapeamento de Banners por Dia da Semana (BannerDoDia) ---
const BannerDoDia = {
    7: 'banner_domingo.png', 1: 'banner_segunda.png', 2: 'banner_terca.png',    
    3: 'banner_quarta.png', 4: 'banner_quinta.png', 5: 'banner_sexta.png',    
    6: 'banner_sabado.png'    
};
const allDailyBanners = Object.values(BannerDoDia); 

// =========================================================================
// === FUNÇÕES DE CONFIGURAÇÃO REMOTA (JSONBIN) ===
// =========================================================================

const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_BIN_ID}/latest`;
const JSONBIN_WRITE_URL = `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_BIN_ID}`;

async function getBannerConfig() {
    const defaultFallback = { specific_banners: {}, daily_banners_active: true };
    
    if (!process.env.JSONBIN_BIN_ID) {
        return defaultFallback;
    }
    
    try {
        const response = await fetch(JSONBIN_URL);
        const data = await response.json();
        
        return data.record ? data.record : defaultFallback; 
    } catch (error) {
        console.error('Falha ao buscar estado de banners no JSON Bin, assumindo ATIVO:', error.message);
        return defaultFallback; 
    }
}

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
            folder: 'site_banners', 
        });

        const newBannerUrl = result.secure_url;
        const newBannerPublicId = result.public_id; 

        // 2. Busca a configuração atual
        const currentConfig = await getBannerConfig();
        const newConfig = { ...currentConfig };
        
        // 3. Adiciona o novo banner (URL) como chave no JSON Bin, mapeando para o Public ID
        newConfig.specific_banners = newConfig.specific_banners || {};
        newConfig.specific_banners[newBannerUrl] = newBannerPublicId; 
        
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
            message: 'Banner enviado e ativado com sucesso!', 
            url: newBannerUrl,
            publicId: newBannerPublicId
        });
        
    } catch (error) {
        console.error('Erro no upload para Cloudinary/JSON Bin:', error);
        res.status(500).json({ success: false, error: `Falha interna ao salvar configuração: ${error.message}` });
    }
});


// --- NOVO: ROTA PARA EXCLUIR BANNER PERMANENTEMENTE ---
app.delete('/api/banners/delete', async (req, res) => {
    // Espera { "fileUrl": "url_completa_do_cloudinary" } no corpo da requisição DELETE
    const { fileUrl } = req.body;
    
    if (!fileUrl) {
        return res.status(400).json({ success: false, error: 'URL do arquivo (fileUrl) é obrigatória.' });
    }

    try {
        // 1. Busca a configuração atual para obter o Public ID
        const currentConfig = await getBannerConfig();
        const specificBanners = currentConfig.specific_banners || {};
        
        // A URL é a chave; o valor é o Public ID (ou false se desativado)
        const publicId = specificBanners[fileUrl]; 

        if (!publicId && publicId !== false) {
             return res.status(404).json({ success: false, error: 'Banner não encontrado na configuração do JSON Bin.' });
        }
        
        // 2. Exclusão no Cloudinary
        if (publicId && publicId !== false) { 
            console.log(`Excluindo Public ID ${publicId} do Cloudinary...`);
            await cloudinary.uploader.destroy(publicId);
        }

        // 3. Excluir a entrada (URL) da configuração do JSON Bin
        const newConfig = { ...currentConfig };
        delete newConfig.specific_banners[fileUrl];
        
        // 4. Salvar a nova configuração no JSON Bin
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
            throw new Error(`Falha ao atualizar JSON Bin após exclusão. Status: ${jsonBinResponse.status}. Body: ${errorBody}`);
        }

        res.json({ 
            success: true, 
            message: `Banner excluído permanentemente (Cloudinary e JSON Bin).`, 
            fileUrl: fileUrl
        });

    } catch (error) {
        console.error('Erro na exclusão permanente:', error);
        res.status(500).json({ success: false, error: `Falha interna na exclusão: ${error.message}` });
    }
});


// --- ROTA 1: API PARA OBTER OS BANNERS ATIVOS (CONSUMO DO CLIENTE) ---
app.get('/api/banners', async (req, res) => {
    
    const config = await getBannerConfig();
    const isDailyActive = config.daily_banners_active;
    const specificStatuses = config.specific_banners || {}; 
    
    const today = DateTime.local().setZone('America/Sao_Paulo').weekday; 
    const bannerFilenameToday = BannerDoDia[today]; 
    const baseUrl = req.protocol + '://' + req.get('host');
    let finalBannerUrls = [];

    // 1. Processa Banner do Dia (Lê do disco local se ativo)
    if (isDailyActive && bannerFilenameToday) {
         const dailyBannerPath = path.join(__dirname, 'banners', bannerFilenameToday);
         if (fs.existsSync(dailyBannerPath)) {
            finalBannerUrls.push(`${baseUrl}/${bannerFilenameToday}`);
         }
    }

    // 2. Processa Banners Genéricos e Aleatórios (Lendo URLs do JSON Bin/Cloudinary)
    Object.keys(specificStatuses).forEach(url => {
        // A chave (URL) é considerada ativa se o valor não for explicitamente 'false'
        const isActive = specificStatuses[url] !== false; 
        
        if (isActive) {
            finalBannerUrls.push(url);
        }
    });
    
    res.json({ 
        banners: [...new Set(finalBannerUrls)],
        debug: {
            currentDay: today,
            timezone: 'America/Sao_Paulo',
            bannerDia: isDailyActive ? bannerFilenameToday : 'DESATIVADO',
            numGenericosAtivos: finalBannerUrls.length - (isDailyActive && finalBannerUrls.includes(`${baseUrl}/${bannerFilenameToday}`) ? 1 : 0)
        }
    });
});

// --- ROTA 2: API PARA OBTER LISTA COMPLETA DE BANNERS E STATUS (PAINEL) ---
app.get('/api/config/banners/list', async (req, res) => {
    const bannersDir = path.join(__dirname, 'banners');
    const config = await getBannerConfig(); 
    const specificStatuses = config.specific_banners || {};
    
    let bannerList = [];

    // 1. Adiciona Banners Diários (lidos do disco)
    try {
        const files = fs.readdirSync(bannersDir);
        const dailyImageFiles = files.filter(file => allDailyBanners.includes(file));

        dailyImageFiles.forEach(file => {
            bannerList.push({
                fileName: file,
                isDailyBanner: true,
                isActive: config.daily_banners_active !== false 
            });
        });
    } catch (err) {
        console.warn('Aviso: Pasta "banners/" não encontrada ou erro ao ler. Pulando banners diários.', err);
    }
    
    // 2. Adiciona Banners Genéricos (lidos do JSON Bin/Cloudinary)
    Object.keys(specificStatuses).forEach(url => {
        const isActive = specificStatuses[url] !== false; 
        
        bannerList.push({
            fileName: url, 
            isDailyBanner: false,
            isActive: isActive
        });
    });

    res.json({
        config: {
            daily_banners_active: config.daily_banners_active
        },
        banners: bannerList
    });
});

// --- ROTA 3: API PARA ATUALIZAR CONFIGURAÇÃO (ESCRITA DO PAINEL) ---
app.put('/api/config/banners', async (req, res) => {
    
    const { file, active } = req.body; 
    
    if (typeof active !== 'boolean' || !file) {
        return res.status(400).json({ success: false, error: 'O campo "active" deve ser booleano e "file" deve ser fornecido.' });
    }

    const url = JSONBIN_WRITE_URL; 
    const apiKey = process.env.JSONBIN_MASTER_KEY; 
    
    try {
        const currentConfig = await getBannerConfig();
        const newConfig = { ...currentConfig };

        if (file === 'daily') {
            newConfig.daily_banners_active = active;
            
        } else {
            newConfig.specific_banners = newConfig.specific_banners || {};
            
            if (active === true) {
                 // Para reativar (mantém o valor original, que é o Public ID, se ele existir)
                 const originalPublicId = currentConfig.specific_banners[file];

                 if (originalPublicId && originalPublicId !== false) {
                     newConfig.specific_banners[file] = originalPublicId; 
                 } else {
                     // Caso a chave tenha sido removida ou o valor não seja válido, apenas a recria como ativa (com o valor 'true')
                     // Este é um fallback, idealmente o Public ID seria preservado.
                     newConfig.specific_banners[file] = true;
                 }
                 
            } else {
                 // Para desativar, define explicitamente a chave (URL) como 'false'
                 newConfig.specific_banners[file] = false;
            }
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

        res.json({ success: true, new_state: active, banner_file: file, message: `Estado do banner ${file} atualizado com sucesso.` });
    } catch (error) {
        console.error('Erro de escrita no JSON Bin:', error);
        res.status(500).json({ success: false, error: `Falha interna ao salvar configuração: ${error.message}` });
    }
});

module.exports = app;