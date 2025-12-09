// server.js (ATUALIZADO COM JSONBIN PARA DASHBOARD)

const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors'); 
const { DateTime } = require('luxon');
const fetch = require('node-fetch'); // ✅ NOVO: Importa node-fetch
const app = express();

// --- Middleware para leitura de JSON (Necessário para a rota PUT) ---
app.use(express.json()); 
app.use(cors()); 

// --- 1. CONFIGURAÇÃO DA PASTA DE ARQUIVOS ESTÁTICOS ---
app.use(express.static(path.join(__dirname, 'banners'))); 

// =========================================================================
// === Mapeamento de Banners por Dia da Semana (BannerDoDia) ===
// =========================================================================

const BannerDoDia = {
    7: 'banner_domingo.png',  
    1: 'banner_segunda.png',  
    2: 'banner_terca.png',    
    3: 'banner_quarta.png',   
    4: 'banner_quinta.png',   
    5: 'banner_sexta.png',    
    6: 'banner_sabado.png'    
};

// =========================================================================
// === FUNÇÕES DE CONFIGURAÇÃO REMOTA (JSONBIN) ===
// =========================================================================

const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_BIN_ID}/latest`;
const JSONBIN_WRITE_URL = `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_BIN_ID}`;

// Função para buscar o estado de ativação no JSON Bin
async function isBannersActive() {
    try {
        const response = await fetch(JSONBIN_URL);
        const data = await response.json();
        
        // Retorna 'true' ou 'false' com base no campo 'active'
        // Se a busca falhar ou o campo não existir, assume 'true' (ativo) como fallback seguro
        return data.record ? data.record.active === true : true; 
    } catch (error) {
        console.error('Falha ao buscar estado de ativação no JSON Bin, assumindo ATIVO:', error);
        return true; 
    }
}

// --- ROTA 1: API PARA OBTER OS BANNERS (Rota de LEITURA) ---
// Transformada em async para poder usar 'await isBannersActive()'
app.get('/api/banners', async (req, res) => {
    
    // 🛑 PASSO 3A: CHECAGEM DO ESTADO LIDO NO JSON BIN
    const isActive = await isBannersActive();
    
    // Configurações de Debug (úteis mesmo se desativado)
    const today = DateTime.local().setZone('America/Sao_Paulo').weekday; 
    const bannerFilenameToday = BannerDoDia[today]; 
    const debugMessage = isActive ? 
                         (bannerFilenameToday || 'Nenhum') : 
                         'DESATIVADO por JSON Bin';

    if (!isActive) {
        // Retorno rápido se desativado
        return res.json({ 
            banners: [],
            debug: {
                currentDay: today,
                timezone: 'America/Sao_Paulo',
                expectedBanner: debugMessage
            }
        });
    }

    // --- Lógica de Banners existente (só é executada se 'isActive' for true) ---
    const bannersDir = path.join(__dirname, 'banners');
    const allDailyBanners = Object.values(BannerDoDia); 
    const baseUrl = req.protocol + '://' + req.get('host');

    fs.readdir(bannersDir, (err, files) => {
        if (err) {
            console.error('Erro ao ler o diretório de banners:', err);
            return res.status(500).json({ error: 'Falha ao carregar banners.' });
        }

        let dailyBannerUrl = [];
        const genericBannerUrls = [];

        const imageFiles = files.filter(file => /\.(jpe?g|png|gif|webp)$/i.test(file));

        imageFiles.forEach(file => {
            if (file === bannerFilenameToday) {
                dailyBannerUrl.push(`${baseUrl}/${file}`);
            } 
            else if (!allDailyBanners.includes(file)) {
                genericBannerUrls.push(`${baseUrl}/${file}`);
            }
        });

        const finalBannerUrls = [...dailyBannerUrl, ...genericBannerUrls];

        res.json({ 
            banners: finalBannerUrls,
            debug: {
                currentDay: today,
                timezone: 'America/Sao_Paulo',
                expectedBanner: debugMessage
            }
        });
    });
});

// --- ROTA 2: API PARA ATUALIZAR CONFIGURAÇÃO (Rota de ESCRITA) ---
app.put('/api/config/banners', async (req, res) => {
    
    // Espera { "active": true | false } no corpo da requisição do Dashboard
    const { active } = req.body; 
    
    if (typeof active !== 'boolean') {
        return res.status(400).json({ success: false, error: 'O campo "active" deve ser booleano.' });
    }

    // URL de Escrita (sem o /latest)
    const url = JSONBIN_WRITE_URL; 
    const apiKey = process.env.JSONBIN_MASTER_KEY; 
    
    try {
        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                // A Master Key é obrigatória para escrita/PUT/criação
                'X-Master-Key': apiKey 
            },
            body: JSON.stringify({ active }) // Envia o novo estado
        });

        if (!response.ok) {
            // Se a API do JSON Bin retornar erro (ex: chave errada)
            const errorBody = await response.text();
            console.error('Falha na resposta do JSON Bin:', response.status, errorBody);
            throw new Error(`Falha ao atualizar JSON Bin. Status: ${response.status}`);
        }

        res.json({ success: true, new_state: active, message: 'Estado atualizado com sucesso.' });
    } catch (error) {
        console.error('Erro de escrita no JSON Bin:', error);
        res.status(500).json({ success: false, error: 'Falha interna ao salvar configuração.' });
    }
});

// --- EXPORTAÇÃO VERCEL: Exporta o aplicativo Express. ---
module.exports = app;