// server.js (CONTROLE INDIVIDUAL POR ARQUIVO DINÂMICO COM CLOUDINARY)

const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors'); 
const { DateTime } = require('luxon');
const fetch = require('node-fetch'); 
const cloudinary = require('cloudinary').v2; // Adição Cloudinary
const multer = require('multer');           // Adição Multer
const app = express();

app.use(express.json()); 
app.use(cors()); 
// Mantém o acesso estático para os banners diários (que ainda estão no disco)
app.use(express.static(path.join(__dirname, 'banners'))); 

// --- CONFIGURAÇÃO CLOUDINARY ---
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configuração do Multer: Armazena o arquivo na memória temporariamente
// (Crucial para ambientes Serverless como o Vercel)
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
        // Converte o buffer de memória em base64 para o Cloudinary
        const fileBase64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

        // 1. Upload para o Cloudinary
        const result = await cloudinary.uploader.upload(fileBase64, {
            folder: 'site_banners', // Pasta no Cloudinary
        });

        const newBannerUrl = result.secure_url;
        // O Public ID pode ser útil para exclusão futura, mas salvamos a URL como chave.
        const newBannerPublicId = result.public_id; 

        // 2. Busca a configuração atual
        const currentConfig = await getBannerConfig();
        const newConfig = { ...currentConfig };
        
        // 3. Adiciona o novo banner (URL) como chave no JSON Bin, mapeando para o Public ID
        newConfig.specific_banners = newConfig.specific_banners || {};
        newConfig.specific_banners[newBannerUrl] = newBannerPublicId; 
        
        // O banner é ativado por padrão ao ser adicionado

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


// --- ROTA 1: API PARA OBTER OS BANNERS ATIVOS (CONSUMO DO CLIENTE) ---
app.get('/api/banners', async (req, res) => {
    
    const config = await getBannerConfig();
    const isDailyActive = config.daily_banners_active;
    // specificStatuses agora contém URLs do Cloudinary como chaves
    const specificStatuses = config.specific_banners || {}; 
    
    const today = DateTime.local().setZone('America/Sao_Paulo').weekday; 
    const bannerFilenameToday = BannerDoDia[today]; 
    const baseUrl = req.protocol + '://' + req.get('host');
    let finalBannerUrls = [];

    // 1. Processa Banner do Dia (Lê do disco local se ativo)
    if (isDailyActive && bannerFilenameToday) {
         const dailyBannerPath = path.join(__dirname, 'banners', bannerFilenameToday);
         // Verifica se o arquivo diário existe antes de incluir
         if (fs.existsSync(dailyBannerPath)) {
            finalBannerUrls.push(`${baseUrl}/${bannerFilenameToday}`);
         }
    }

    // 2. Processa Banners Genéricos e Aleatórios (Lendo URLs do JSON Bin/Cloudinary)
    Object.keys(specificStatuses).forEach(url => {
        // A chave (URL) é considerada ativa se o valor não for explicitamente 'false'
        const isActive = specificStatuses[url] !== false; 
        
        if (isActive) {
            // Adiciona o URL do Cloudinary diretamente
            finalBannerUrls.push(url);
        }
    });
    
    res.json({ 
        banners: [...new Set(finalBannerUrls)],
        // Informações de debug/status podem ser úteis
        debug: {
            currentDay: today,
            timezone: 'America/Sao_Paulo',
            bannerDia: isDailyActive ? bannerFilenameToday : 'DESATIVADO',
            numGenericosAtivos: finalBannerUrls.length - (isDailyActive && finalBannerUrls.includes(`${baseUrl}/${bannerFilenameToday}`) ? 1 : 0)
        }
    });
});

// --- ROTA 2: API PARA OBTER LISTA COMPLETA DE BANNERS E STATUS (PAINEL) ---
// Esta rota precisa combinar Banners Diários (do disco) com Banners Cloudinary (do JSON Bin)
app.get('/api/config/banners/list', async (req, res) => {
    const bannersDir = path.join(__dirname, 'banners');
    const config = await getBannerConfig(); 
    const specificStatuses = config.specific_banners || {};
    
    // Lista para banners diários (lidos do disco)
    let bannerList = [];

    // 1. Adiciona Banners Diários (lidos do disco)
    try {
        const files = fs.readdirSync(bannersDir);
        const dailyImageFiles = files.filter(file => allDailyBanners.includes(file));

        dailyImageFiles.forEach(file => {
            bannerList.push({
                fileName: file,
                isDailyBanner: true,
                // Status reflete o controle global
                isActive: config.daily_banners_active !== false 
            });
        });
    } catch (err) {
        console.warn('Aviso: Pasta "banners/" não encontrada ou erro ao ler. Pulando banners diários.', err);
    }
    
    // 2. Adiciona Banners Genéricos (lidos do JSON Bin/Cloudinary)
    // As chaves são os URLs completos do Cloudinary.
    Object.keys(specificStatuses).forEach(url => {
        // O banner é considerado ativo se o valor não for 'false'.
        const isActive = specificStatuses[url] !== false; 
        
        bannerList.push({
            // O fileName é o URL do Cloudinary para o painel
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
// Manter esta rota quase inalterada. Ela funcionará para:
// 1. file='daily' (controle global)
// 2. file='url_do_cloudinary' (controle individual)
app.put('/api/config/banners', async (req, res) => {
    
    // Espera { "file": "nome_do_arquivo.png" | "url_do_cloudinary" | "daily", "active": true | false }
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
            // O "file" aqui é o URL do Cloudinary
            newConfig.specific_banners = newConfig.specific_banners || {};
            
            // O valor da chave (URL) é o Public ID no caso de um banner ativo.
            // Para desativar, definimos o valor como 'false'.
            if (active === true) {
                 // Para ativar, se o banner já estava lá, mantemos o Public ID original
                 // Ou adicionamos de volta (se já foi excluído, o server.js usará o fallback)
                 
                 // Se o valor era 'false' antes, tentamos restaurar o Public ID.
                 // Como não temos o Public ID aqui, uma maneira simples é deletar a chave
                 // e fazer um novo upload se for necessário (mais complexo).
                 // Para este caso, vamos manter a chave no JSON Bin, mas marcar como "ativado"
                 // reusando o Public ID original que o upload salvou (se existir).
                 
                 // Se o banner não existe mais (excluído do Cloudinary), o valor será undefined
                 const originalPublicId = currentConfig.specific_banners[file];

                 if (originalPublicId) {
                     newConfig.specific_banners[file] = originalPublicId; // Reativa com o ID
                 } else {
                     // Caso ele não tenha sido enviado por upload e sim manualmente
                     delete newConfig.specific_banners[file];
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