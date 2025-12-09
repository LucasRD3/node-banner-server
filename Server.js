// server.js (CONTROLE INDIVIDUAL POR ARQUIVO DINÂMICO COM CLOUDINARY E MONGODB)

const express = require('express');
const cors = require('cors'); 
const { DateTime } = require('luxon');
// const fetch = require('node-fetch'); // Não é mais necessário com Mongoose
const cloudinary = require('cloudinary').v2;
const multer = require('multer');           
const mongoose = require('mongoose'); // NOVO: Mongoose para MongoDB
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
// === CONFIGURAÇÃO MONGODB E MODELO === // NOVO
// =========================================================================

const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI)
.then(() => console.log('Conexão com MongoDB estabelecida!'))
.catch(err => console.error('Erro ao conectar ao MongoDB:', err));

// 1. Definição do Schema (Modelo) para a Configuração do Banner
const bannerConfigSchema = new mongoose.Schema({
    // Usamos um ID fixo para garantir que haverá APENAS UM documento de configuração
    _id: { type: String, default: 'BANNER_CONFIG_ID' }, 
    // O objeto que armazenará a configuração de banners (antes era o corpo do JSONBin)
    specific_banners: {
        type: Map, 
        of: mongoose.Schema.Types.Mixed, // O valor pode ser { day, priority } ou 'false'
        default: new Map()
    }
}, { timestamps: true }); 

const BannerConfig = mongoose.model('BannerConfig', bannerConfigSchema);


// =========================================================================
// === FUNÇÕES DE CONFIGURAÇÃO REMOTA (MONGODB) === // MODIFICADO
// =========================================================================

// REMOVIDOS OS URLS DO JSONBIN

// FUNÇÃO PARA LER A CONFIGURAÇÃO DO MONGODB (Substitui o GET do JSONBin)
async function getBannerConfig() {
    try {
        // Busca o documento único de configuração pelo ID fixo
        const configDoc = await BannerConfig.findById('BANNER_CONFIG_ID');

        if (!configDoc) {
            console.log('Documento de configuração não encontrado. Retornando estrutura inicial.');
            return { specific_banners: {} };
        }

        // Converte o Map do Mongoose para um objeto JS simples para consistência
        const bannersObject = Object.fromEntries(configDoc.specific_banners);

        // Retorna no formato esperado pelo restante do código
        return {
            specific_banners: bannersObject
        };

    } catch (error) {
        console.error('Erro ao ler a configuração do MongoDB:', error);
        // Em caso de erro, retorna uma estrutura vazia para evitar falhas
        return { specific_banners: {} }; 
    }
}

// NOVO: Função para salvar/atualizar a configuração no MongoDB (Substitui o PUT/POST do JSONBin)
async function saveBannerConfig(newConfig) {
    try {
        // Encontra pelo ID fixo e atualiza. `upsert: true` garante que o documento será criado.
        await BannerConfig.findByIdAndUpdate(
            'BANNER_CONFIG_ID', 
            { specific_banners: newConfig.specific_banners }, // Salva apenas o objeto de banners
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );

    } catch (error) {
        console.error('Erro ao salvar a configuração no MongoDB:', error);
        throw error; // Propaga o erro para ser tratado pela rota
    }
}


// =========================================================================
// === ROTAS DA API ===
// =========================================================================

// Rota GET (Health Check)
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        message: 'Server is running',
        db: mongoose.connection.readyState === 1 ? 'MongoDB Connected' : 'MongoDB Disconnected' // NOVO: Status da conexão
    });
});

// Rota GET (Configuração)
app.get('/api/banners/config', async (req, res) => {
    try {
        const config = await getBannerConfig();
        res.json({ success: true, data: config.specific_banners });
    } catch (error) {
        console.error('Erro ao buscar a configuração:', error);
        res.status(500).json({ success: false, message: 'Erro ao buscar a configuração dos banners.' });
    }
});


// Rota GET (Banner principal do dia/random)
app.get('/api/banner', async (req, res) => {
    try {
        const config = await getBannerConfig();
        const specificBanners = config.specific_banners;

        const allBanners = Object.keys(specificBanners);

        // Filtra banners ativos (aqueles que não estão definidos como 'false')
        const activeBanners = allBanners.filter(file => specificBanners[file] !== 'false' && specificBanners[file] !== false);

        if (activeBanners.length === 0) {
            return res.json({ success: false, message: 'Nenhum banner ativo encontrado.' });
        }

        const today = DateTime.local().setZone("America/Sao_Paulo").weekdayLong.toLowerCase(); // Ex: 'monday'

        // 1. Tenta encontrar banners agendados para hoje
        let dailyBanners = activeBanners.filter(file => {
            const dayConfig = specificBanners[file].day;
            return dayConfig === today; // Verifica se o dia corresponde
        });

        if (dailyBanners.length > 0) {
            // Se houver mais de um banner para hoje, seleciona o de maior prioridade
            dailyBanners.sort((a, b) => {
                const priorityA = specificBanners[a].priority || 999;
                const priorityB = specificBanners[b].priority || 999;
                return priorityA - priorityB; // Ordena pela menor prioridade
            });

            const selectedFile = dailyBanners[0];
            return res.json({
                success: true,
                banner_file: selectedFile,
                type: 'daily',
                priority: specificBanners[selectedFile].priority
            });
        }

        // 2. Se não houver banner diário, verifica por banners 'random'
        let randomBanners = activeBanners.filter(file => specificBanners[file].day === 'random');

        if (randomBanners.length > 0) {
            // Seleciona um banner 'random'
            const randomIndex = Math.floor(Math.random() * randomBanners.length);
            const selectedFile = randomBanners[randomIndex];

            return res.json({
                success: true,
                banner_file: selectedFile,
                type: 'random',
                priority: specificBanners[selectedFile].priority
            });
        }
        
        // 3. Se não houver banners diários nem random, retorna falha
        return res.json({ success: false, message: 'Nenhum banner ativo configurado para hoje.' });

    } catch (error) {
        console.error('Erro ao buscar a configuração do banner:', error);
        res.status(500).json({ success: false, message: 'Erro interno ao buscar a configuração do banner.' });
    }
});


// Rota POST (Upload)
app.post('/api/banners/upload', upload.single('banner'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado.' });
    }

    try {
        const fileBuffer = req.file.buffer;
        const uploadResult = await cloudinary.uploader.upload(
            `data:${req.file.mimetype};base64,${fileBuffer.toString('base64')}`, 
            {
                folder: 'banners',
                resource_type: 'auto',
                public_id: req.file.originalname.replace(/\..+$/, '') // Usa o nome original como ID
            }
        );

        // A configuração padrão ao subir é 'false' (inativo), garantindo que não aparece imediatamente.
        const currentConfig = await getBannerConfig();
        currentConfig.specific_banners[uploadResult.public_id] = false;

        // Salva a nova configuração
        await saveBannerConfig(currentConfig); // MODIFICADO

        res.json({ 
            success: true, 
            message: 'Upload e configuração inicial realizados com sucesso.', 
            filename: uploadResult.public_id,
            url: uploadResult.secure_url
        });

    } catch (error) {
        console.error('Erro no upload para Cloudinary ou MongoDB:', error); // MODIFICADO
        res.status(500).json({ success: false, message: 'Falha no upload ou na persistência de dados.' });
    }
});

// Rota DELETE (Cloudinary)
app.delete('/api/banners/file/:file', async (req, res) => {
    try {
        const { file } = req.params;

        // 1. Remove do Cloudinary
        const destroyResult = await cloudinary.uploader.destroy(file, { resource_type: 'image' });

        if (destroyResult.result !== 'ok' && destroyResult.result !== 'not found') {
            // Se o arquivo não puder ser deletado, lance um erro (a menos que não exista)
            throw new Error(`Falha ao deletar arquivo no Cloudinary: ${destroyResult.result}`);
        }

        // 2. Remove da configuração do MongoDB
        const currentConfig = await getBannerConfig();
        const newConfig = {
            specific_banners: { ...currentConfig.specific_banners }
        };

        delete newConfig.specific_banners[file];

        await saveBannerConfig(newConfig); // MODIFICADO

        res.json({ success: true, message: `Banner ${file} removido com sucesso (Cloudinary e MongoDB).` });

    } catch (error) {
        console.error('Erro ao deletar banner:', error); // MODIFICADO
        res.status(500).json({ success: false, message: 'Erro interno ao deletar o banner.' });
    }
});


// Rota POST (Específica - Ativar/Desativar Banner e configurar dia/prioridade)
app.post('/api/banners/file/:file/active', async (req, res) => {
    try {
        const { file } = req.params;
        const { active, day, priority } = req.body;
        const baseConfig = req.body; 

        if (active === undefined) {
            return res.status(400).json({ success: false, message: 'O campo "active" é obrigatório.' });
        }

        const currentConfig = await getBannerConfig();

        const newConfig = {
            specific_banners: { ...currentConfig.specific_banners }
        };

        if (active) {
            // ATIVAR: Configura o banner
            // Usa day e priority do corpo ou defaults
            newConfig.specific_banners[file] = {
                day: day || baseConfig.day || 'random', 
                priority: priority || baseConfig.priority || 999 
            };
            
        } else {
            // DESATIVAR: Define explicitamente a chave (URL) como 'false'
            newConfig.specific_banners[file] = false;
        }

        
        // **********************************************
        // SUBSTITUIÇÃO DO FETCH PARA JSONBIN PELO MONGO
        // **********************************************

        await saveBannerConfig(newConfig); // MODIFICADO: Chama a nova função de salvamento no MongoDB

        // A lógica de retorno permanece a mesma
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
        console.error('Erro de escrita no MongoDB:', error); // MODIFICADO
        res.status(500).json({ success: false, message: 'Erro interno ao atualizar a configuração do banner.' });
    }
});


// Rota PUT (General - Update Config)
// Esta rota mantém o 'specific_banners' persistente, mesmo se 'general_config' for enviado.
app.put('/api/banners/config', async (req, res) => {
    try {
        // O corpo desta rota no código original era confuso, 
        // mas o objetivo principal é persistir a configuração.
        // O foco é mantido no objeto 'specific_banners'.
        
        const currentConfig = await getBannerConfig();
        
        // Criamos o objeto completo a ser salvo no DB
        const fullNewConfig = {
            specific_banners: currentConfig.specific_banners 
        };

        // **********************************************
        // SUBSTITUIÇÃO DO FETCH PARA JSONBIN PELO MONGO
        // **********************************************
        await saveBannerConfig(fullNewConfig); // MODIFICADO

        res.json({ success: true, message: 'Configuração geral atualizada com sucesso (apenas specific_banners foi persistido).' });

    } catch (error) {
        console.error('Erro de escrita no MongoDB:', error); // MODIFICADO
        res.status(500).json({ success: false, message: 'Erro interno ao atualizar a configuração geral.' });
    }
});


// Rota POST (General - Update Config)
// Mantida, mas com comportamento idêntico ao PUT
app.post('/api/banners/config', async (req, res) => {
    try {
        const currentConfig = await getBannerConfig();
        
        const fullNewConfig = {
            specific_banners: currentConfig.specific_banners 
        };

        await saveBannerConfig(fullNewConfig); // MODIFICADO

        res.json({ success: true, message: 'Configuração geral atualizada com sucesso (apenas specific_banners foi persistido).' });
    } catch (error) {
        console.error('Erro de escrita no MongoDB:', error); // MODIFICADO
        res.status(500).json({ success: false, message: 'Erro interno ao atualizar a configuração geral.' });
    }
});


// Rota GET (Listar todos os banners)
app.get('/api/banners/list', async (req, res) => {
    try {
        // Obtém a lista de arquivos do Cloudinary
        const result = await cloudinary.search
            .expression('folder:banners')
            .max_results(500)
            .execute();

        const config = await getBannerConfig();
        const specificBanners = config.specific_banners || {};

        const list = result.resources.map(resource => {
            const fileKey = resource.public_id;
            const currentConfig = specificBanners[fileKey];

            let active = false;
            let day = 'random';
            let priority = 999;

            if (currentConfig !== 'false' && currentConfig !== false && typeof currentConfig === 'object') {
                active = true;
                day = currentConfig.day || 'random';
                priority = currentConfig.priority || 999;
            }

            return {
                public_id: fileKey,
                url: resource.secure_url,
                active: active,
                day: day,
                priority: priority,
                created_at: resource.created_at
            };
        });

        res.json({ success: true, data: list });
    } catch (error) {
        console.error('Erro ao listar banners:', error);
        res.status(500).json({ success: false, message: 'Erro ao listar banners.' });
    }
});


// Início do servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server rodando na porta ${PORT}`);
});