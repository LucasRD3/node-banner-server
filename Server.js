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
    // ALTERAÇÃO: specific_banners agora mapeará URLs para { publicId: string | false, day: string }
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

// NOVO: Função auxiliar para salvar a configuração no JSON Bin
async function saveBannerConfig(newConfig) {
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
        throw new Error(`Falha ao atualizar JSON Bin. Status: ${jsonBinResponse.status}. Body: ${errorBody}`);
    }
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
            folder: 'site_banners', 
        });

        const newBannerUrl = result.secure_url;
        const newBannerPublicId = result.public_id; 

        // 2. Busca a configuração atual
        const currentConfig = await getBannerConfig();
        const newConfig = { ...currentConfig };
        
        // 3. Adiciona o novo banner (URL) como chave no JSON Bin
        // ALTERAÇÃO: Armazena um objeto com publicId e o dia padrão 'random'
        newConfig.specific_banners = newConfig.specific_banners || {};
        newConfig.specific_banners[newBannerUrl] = { 
            publicId: newBannerPublicId, 
            day: 'random' // Novo valor padrão
        }; 
        
        // 4. Salva a nova configuração no JSON Bin
        await saveBannerConfig(newConfig);

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


// --- ROTA PARA EXCLUIR BANNER PERMANENTEMENTE ---
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
        
        // A chave (URL) é o bannerInfo (objeto ou valor antigo)
        const bannerInfo = specificBanners[fileUrl]; 
        
        // ALTERAÇÃO: Extrai publicId do novo objeto ou usa o valor antigo
        let publicId = null;
        if (typeof bannerInfo === 'object' && bannerInfo !== null) {
            publicId = bannerInfo.publicId;
        } else {
            publicId = bannerInfo; // Caso seja a estrutura antiga (Public ID string ou false)
        }
        
        if (!bannerInfo && bannerInfo !== false) {
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
        await saveBannerConfig(newConfig);

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
        const bannerInfo = specificStatuses[url]; 
        
        // ALTERAÇÃO: Lógica para tratar a nova estrutura e a estrutura antiga (Public ID ou false)
        let isActive = false;
        let dayToDisplay = 'random'; // Novo campo

        if (typeof bannerInfo === 'object' && bannerInfo !== null) {
             // Nova Estrutura: { publicId: string | boolean, day: string }
             isActive = typeof bannerInfo.publicId === 'string'; // Ativo se publicId for string
             dayToDisplay = bannerInfo.day || 'random';
        } else {
             // Estrutura Antiga (Compatibilidade): 'publicId' ou 'false'
             isActive = typeof bannerInfo === 'string'; // Ativo se for uma string (Public ID)
        }

        // ALTERAÇÃO: Verifica se o banner deve ser exibido hoje (dia ou 'random')
        const isToday = dayToDisplay === 'random' || dayToDisplay === String(today);
        
        if (isActive && isToday) {
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
        const bannerInfo = specificStatuses[url];
        
        // ALTERAÇÃO: Lógica para extrair status e dia
        let isActive = false;
        let day = 'random';
        
        if (typeof bannerInfo === 'object' && bannerInfo !== null) {
            // Nova Estrutura
            isActive = typeof bannerInfo.publicId === 'string';
            day = bannerInfo.day || 'random';
        } else {
            // Estrutura Antiga (Compatibilidade)
            isActive = typeof bannerInfo === 'string'; // Ativo se for uma string (Public ID)
        }
        
        bannerList.push({
            fileName: url, 
            isDailyBanner: false,
            isActive: isActive,
            day: day, // NOVO CAMPO
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
    
    // ALTERAÇÃO: Adiciona 'day' no corpo da requisição (opcional, só para banners Cloudinary)
    const { file, active, day } = req.body; 
    
    if (typeof active !== 'boolean' || !file) {
        return res.status(400).json({ success: false, error: 'O campo "active" deve ser booleano e "file" deve ser fornecido.' });
    }
    
    try {
        const currentConfig = await getBannerConfig();
        const newConfig = { ...currentConfig };

        if (file === 'daily') {
            newConfig.daily_banners_active = active;
            
        } else {
            newConfig.specific_banners = newConfig.specific_banners || {};
            
            // 1. Lógica para obter o status atual (Pode ser string, false ou objeto)
            const currentBannerValue = newConfig.specific_banners[file];
            
            if (!currentBannerValue && currentBannerValue !== false) {
                return res.status(404).json({ success: false, error: `Banner ${file} não encontrado na configuração.` });
            }
            
            // Variáveis temporárias para a nova estrutura
            let publicIdToSave = null;
            let currentDay = 'random';
            
            // 2. Determina os valores atuais e trata a compatibilidade
            if (typeof currentBannerValue === 'object' && currentBannerValue !== null) {
                // Nova Estrutura
                publicIdToSave = currentBannerValue.publicId;
                currentDay = currentBannerValue.day || 'random';
            } else {
                // Estrutura Antiga (Public ID string ou false)
                publicIdToSave = currentBannerValue;
            }
            
            // 3. Lógica de Ativação/Desativação (muda o publicId para string ou false)
            if (active === true) {
                 // Para reativar: publicId deve ser a string original
                 publicIdToSave = typeof publicIdToSave === 'string' ? publicIdToSave : file; 
                 
            } else {
                 // Para desativar: publicId deve ser 'false'
                 publicIdToSave = false;
            }

            // 4. Lógica de Mudar o Dia (se 'day' foi fornecido, usa o novo valor; senão, preserva o antigo)
            const dayToSave = day !== undefined ? day : currentDay; 

            // 5. Salva o novo objeto
            newConfig.specific_banners[file] = {
                publicId: publicIdToSave,
                day: dayToSave
            };
        }

        // Salva a nova configuração no JSON Bin
        await saveBannerConfig(newConfig);

        res.json({ success: true, new_state: active, new_day: newConfig.specific_banners[file]?.day || undefined, banner_file: file, message: `Estado e/ou dia do banner ${file} atualizado com sucesso.` });
    } catch (error) {
        console.error('Erro de escrita no JSON Bin:', error);
        res.status(500).json({ success: false, error: `Falha interna ao salvar configuração: ${error.message}` });
    }
});

module.exports = app;